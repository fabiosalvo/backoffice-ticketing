// Le operazioni sui ticket, uguali da qualunque parte arrivino: dal canale
// Slack del backoffice, dal DM dell'agente o dalla dashboard. Ognuna aggiorna
// lo store e tiene allineati i due thread Slack del ticket (canale e DM).

import { relayText, statusNotice, ticketCard } from './blocks.mjs';

const OPERATORS_TTL = 10 * 60 * 1000;

export function createDesk(store, config) {
  const users = new Map();
  let operatorsCache = { at: 0, list: [] };

  const person = (u) => ({
    id: u.id,
    name: u.profile?.display_name || u.profile?.real_name || u.name,
    icon: u.profile?.image_48,
  });

  async function who(client, userId) {
    if (!users.has(userId)) {
      const { user } = await client.users.info({ user: userId });
      users.set(userId, { ...person(user), id: userId });
    }
    return users.get(userId);
  }

  async function refreshCards(client, t) {
    const updates = [];
    if (t.channel_ts) updates.push(client.chat.update({ channel: config.backofficeChannel, ts: t.channel_ts, ...ticketCard(t, { audience: 'backoffice' }) }));
    if (t.dm_ts) updates.push(client.chat.update({ channel: t.dm_channel, ts: t.dm_ts, ...ticketCard(t, { audience: 'agente' }) }));
    await Promise.all(updates);
  }

  const postInDm = (client, t, msg) => client.chat.postMessage({ channel: t.dm_channel, thread_ts: t.dm_ts, ...msg });
  const postInChannel = (client, t, msg) =>
    client.chat.postMessage({ channel: config.backofficeChannel, thread_ts: t.channel_ts, ...msg });

  /** Crea il ticket, lo pubblica nel canale backoffice e apre il thread in DM. */
  async function openTicket(client, logger, requester, input) {
    let t = store.create({ ...input, requesterId: requester.id, requesterName: requester.name });
    const posted = await client.chat.postMessage({ channel: config.backofficeChannel, ...ticketCard(t, { audience: 'backoffice' }) });
    t = store.setSlackRefs(t.id, { channelTs: posted.ts });
    try {
      const { channel } = await client.conversations.open({ users: requester.id });
      const dm = await client.chat.postMessage({ channel: channel.id, ...ticketCard(t, { audience: 'agente' }) });
      t = store.setSlackRefs(t.id, { dmChannel: channel.id, dmTs: dm.ts });
    } catch (err) {
      // Il ticket esiste comunque ed e' nel canale: il backoffice lo vede.
      logger.error(`Ticket #${t.id}: DM all'agente non riuscito`, err);
    }
    return t;
  }

  /**
   * Cambia stato per mano del backoffice: chi lo fa se lo prende se il ticket
   * non ha assegnatario, e l'agente viene avvisato nel suo thread.
   */
  async function changeStatus(client, id, status, actor, { reopened = false } = {}) {
    const before = store.get(id);
    if (!before) throw new Error(`Ticket #${id} inesistente`);
    if (!before.assignee_id && status !== 'aperto') store.assign(id, actor);
    const t = store.setStatus(id, status, actor) ?? store.get(id);
    await refreshCards(client, t);
    if (t.status === before.status) return t;
    const notice = { text: statusNotice(t, actor.id, { reopened }) };
    await Promise.all([t.channel_ts && postInChannel(client, t, notice), t.dm_ts && postInDm(client, t, notice)]);
    return t;
  }

  /**
   * Risposta del backoffice. Da Slack il messaggio e' gia' nel thread del
   * canale; dalla dashboard va pubblicato anche li', cosi' il canale resta lo
   * storico completo. Le note interne non arrivano mai all'agente.
   * `status`, se presente, e' lo stato con cui chiudere l'invio (come
   * "Invia come …" di Zendesk); il testo puo' anche mancare.
   */
  async function backofficeReply(client, id, actor, { body = '', internal = false, status, fromSlack = false }) {
    let t = store.get(id);
    if (!t) throw new Error(`Ticket #${id} inesistente`);
    const before = t;
    if (body.trim()) {
      ({ ticket: t } = store.reply(id, { side: 'backoffice', authorId: actor.id, authorName: actor.name, body, internal }));
      if (!fromSlack && t.channel_ts) {
        const text = internal ? `🔒 *Nota interna*\n${body}` : body;
        await postInChannel(client, t, { text, username: `${actor.name} · dashboard`, icon_url: actor.icon });
      }
      if (!internal && t.dm_ts) await postInDm(client, t, { text: body, username: `${actor.name} · Backoffice`, icon_url: actor.icon });
    }
    if (status && status !== t.status) return changeStatus(client, id, status, actor);
    if (t.status !== before.status || t.assignee_id !== before.assignee_id) await refreshCards(client, t);
    return t;
  }

  /** Risposta dell'agente dal suo DM: va nel thread del canale backoffice. */
  async function agentReply(client, id, author, { text = '', files } = {}) {
    const before = store.get(id);
    const body = relayText(text, files);
    const { ticket, statusChanged } = store.reply(id, { side: 'agente', authorId: author.id, authorName: author.name, body });
    if (ticket.channel_ts) await postInChannel(client, ticket, { text: body, username: author.name, icon_url: author.icon });
    if (statusChanged) {
      await refreshCards(client, ticket);
      if (before.status === 'risolto') await postInChannel(client, ticket, { text: statusNotice(ticket, author.id, { reopened: true }) });
    }
    return ticket;
  }

  /**
   * Chi puo' rispondere dalla dashboard: le persone del workspace (o solo
   * BACKOFFICE_USERS, se impostato). Serve per firmare le risposte con un
   * nome e un utente Slack veri.
   */
  async function operators(client) {
    if (Date.now() - operatorsCache.at < OPERATORS_TTL && operatorsCache.list.length) return operatorsCache.list;
    const list = [];
    let cursor;
    do {
      const res = await client.users.list({ limit: 200, cursor });
      for (const u of res.members ?? []) {
        if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
        if (config.backofficeUsers.length && !config.backofficeUsers.includes(u.id)) continue;
        list.push(person(u));
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
    list.sort((a, b) => a.name.localeCompare(b.name, 'it'));
    for (const p of list) users.set(p.id, p);
    operatorsCache = { at: Date.now(), list };
    return list;
  }

  return { who, refreshCards, openTicket, changeStatus, backofficeReply, agentReply, operators };
}
