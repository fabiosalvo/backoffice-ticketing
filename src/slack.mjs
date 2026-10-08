// Il ponte fra Slack e lo store. Ogni ticket vive in due thread:
//  - nel canale backoffice, sotto la scheda con i pulsanti di stato;
//  - nel DM fra l'app e l'agente che l'ha aperto.
// Quello che si scrive in un thread viene inoltrato nell'altro, a nome di chi
// l'ha scritto: l'agente non entra mai nel canale backoffice e il backoffice
// non deve cercare l'agente in privato.

import {
  ACTIONS,
  INTERNAL_PREFIX,
  NEW_TICKET_VIEW,
  myTicketsBlocks,
  newTicketModal,
  readNewTicket,
  relayText,
  statusNotice,
  ticketCard,
} from './blocks.mjs';

// Scorciatoia globale: compare scrivendo "/" in qualsiasi campo messaggio
// (e nel menu ⚡) e apre direttamente il modulo, senza digitare comandi.
export const NEW_TICKET_SHORTCUT = 'ticket_new_shortcut';

const HELP = [
  '*Come usare i ticket*',
  '• Scrivi `/` e scegli *Nuovo ticket*, oppure `/ticket`: apre una nuova richiesta al backoffice (`/ticket oggetto` precompila l\'oggetto)',
  '• `/ticket miei` elenca le tue richieste aperte',
  '• Le risposte arrivano qui in DM, nel thread del ticket: rispondi li\'.',
].join('\n');

export function registerSlack(app, store, config) {
  const users = new Map();

  async function who(client, userId) {
    if (!users.has(userId)) {
      const { user } = await client.users.info({ user: userId });
      users.set(userId, {
        id: userId,
        name: user.profile?.display_name || user.profile?.real_name || user.name,
        icon: user.profile?.image_48,
      });
    }
    return users.get(userId);
  }

  const isBackoffice = (userId) => !config.backofficeUsers.length || config.backofficeUsers.includes(userId);

  async function refreshCards(client, t) {
    const updates = [];
    if (t.channel_ts) updates.push(client.chat.update({ channel: config.backofficeChannel, ts: t.channel_ts, ...ticketCard(t, { audience: 'backoffice' }) }));
    if (t.dm_ts) updates.push(client.chat.update({ channel: t.dm_channel, ts: t.dm_ts, ...ticketCard(t, { audience: 'agente' }) }));
    await Promise.all(updates);
  }

  const postInDm = (client, t, msg) => client.chat.postMessage({ channel: t.dm_channel, thread_ts: t.dm_ts, ...msg });
  const postInChannel = (client, t, msg) =>
    client.chat.postMessage({ channel: config.backofficeChannel, thread_ts: t.channel_ts, ...msg });

  // --- Apertura ----------------------------------------------------------------

  app.command('/ticket', async ({ command, ack, client, respond }) => {
    await ack();
    const text = command.text.trim();
    if (/^(miei|mie|lista)$/i.test(text)) {
      const mine = store.list({ status: 'aperti', requesterId: command.user_id });
      return respond({ response_type: 'ephemeral', ...myTicketsBlocks(mine) });
    }
    if (/^(aiuto|help|\?)$/i.test(text)) return respond({ response_type: 'ephemeral', text: HELP });
    await client.views.open({ trigger_id: command.trigger_id, view: newTicketModal(config.categories, { title: text }) });
  });

  app.shortcut(NEW_TICKET_SHORTCUT, async ({ shortcut, ack, client }) => {
    await ack();
    await client.views.open({ trigger_id: shortcut.trigger_id, view: newTicketModal(config.categories) });
  });

  app.view(NEW_TICKET_VIEW, async ({ ack, body, view, client, logger }) => {
    const input = readNewTicket(view);
    if (!input.title.trim()) return ack({ response_action: 'errors', errors: { title: "Scrivi l'oggetto della richiesta" } });
    await ack();

    const requester = await who(client, body.user.id);
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
  });

  // --- Pulsanti di stato ---------------------------------------------------------

  app.action(/^ticket_/, async ({ action, ack, body, client }) => {
    await ack();
    const userId = body.user.id;
    if (!isBackoffice(userId)) {
      return client.chat.postEphemeral({
        channel: body.channel.id,
        user: userId,
        text: 'Solo il backoffice puo\' cambiare lo stato dei ticket.',
      });
    }
    const actor = await who(client, userId);
    const id = Number(action.value);
    let t = store.get(id);
    if (!t) return;
    let reopened = false;

    if (action.action_id === ACTIONS.take) {
      store.assign(id, actor);
      t = store.setStatus(id, 'in_lavorazione', actor) ?? store.get(id);
    } else if (action.action_id === ACTIONS.wait) {
      if (!t.assignee_id) store.assign(id, actor);
      t = store.setStatus(id, 'in_attesa', actor) ?? store.get(id);
    } else if (action.action_id === ACTIONS.resolve) {
      if (!t.assignee_id) store.assign(id, actor);
      t = store.setStatus(id, 'risolto', actor) ?? store.get(id);
    } else if (action.action_id === ACTIONS.reopen) {
      reopened = true;
      t = store.setStatus(id, t.assignee_id ? 'in_lavorazione' : 'aperto', actor) ?? store.get(id);
    }

    await refreshCards(client, t);
    const notice = { text: statusNotice(t, userId, { reopened }) };
    await Promise.all([postInChannel(client, t, notice), t.dm_ts && postInDm(client, t, notice)]);
  });

  // --- Conversazione nei thread -------------------------------------------------

  app.event('message', async ({ event, client, logger }) => {
    // Solo messaggi scritti da persone: niente modifiche, cancellazioni o bot
    // (compresi gli inoltri fatti da noi stessi, che altrimenti rimbalzerebbero).
    if (event.bot_id || (event.subtype && event.subtype !== 'file_share')) return;

    const inThread = event.thread_ts && event.thread_ts !== event.ts;

    if (event.channel === config.backofficeChannel) {
      if (!inThread) return;
      const t = store.byChannelThread(event.thread_ts);
      if (!t) return;
      const author = await who(client, event.user);
      const internal = INTERNAL_PREFIX.test(event.text ?? '');
      const body = relayText((event.text ?? '').replace(INTERNAL_PREFIX, ''), event.files);
      const { ticket, statusChanged } = store.reply(t.id, { side: 'backoffice', authorId: author.id, authorName: author.name, body, internal });
      if (!internal && ticket.dm_ts) await postInDm(client, ticket, { text: body, username: `${author.name} · Backoffice`, icon_url: author.icon });
      if (statusChanged || ticket.assignee_id !== t.assignee_id) await refreshCards(client, ticket);
      return;
    }

    if (event.channel_type === 'im') {
      if (!inThread) {
        await client.chat.postMessage({ channel: event.channel, text: HELP });
        return;
      }
      const t = store.byDmThread(event.channel, event.thread_ts);
      if (!t) return;
      const author = await who(client, event.user);
      const body = relayText(event.text ?? '', event.files);
      const { ticket, statusChanged } = store.reply(t.id, { side: 'agente', authorId: author.id, authorName: author.name, body });
      await postInChannel(client, ticket, { text: body, username: author.name, icon_url: author.icon });
      if (statusChanged) {
        await refreshCards(client, ticket);
        if (t.status === 'risolto') await postInChannel(client, ticket, { text: statusNotice(ticket, author.id, { reopened: true }) });
      }
      return;
    }

    logger.debug?.(`Messaggio ignorato in ${event.channel}`);
  });
}
