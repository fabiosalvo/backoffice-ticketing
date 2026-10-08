// Il ponte fra Slack e lo store. Un ticket nasce in due modi:
//  - un messaggio scritto nel canale #assistenza (il modo principale);
//  - /ticket o il menu di un messaggio, con il modulo.
// Poi vive in due thread:
//  - nel canale backoffice, sotto la scheda con i pulsanti di stato;
//  - nel DM fra l'app e l'agente che l'ha aperto.
// Quello che si scrive in un thread viene inoltrato nell'altro, a nome di chi
// l'ha scritto: l'agente non entra mai nel canale backoffice e il backoffice
// non deve cercare l'agente in privato.

import {
  ACTIONS,
  INTERNAL_PREFIX,
  NEW_TICKET_VIEW,
  assistenzaAck,
  myTicketsBlocks,
  newTicketModal,
  readNewTicket,
  relayText,
  statusNotice,
  ticketCard,
  ticketFromMessage,
} from './blocks.mjs';

export const MESSAGE_SHORTCUT = 'ticket_from_message';

const helpText = (config) => [
  '*Come usare i ticket*',
  ...(config.assistenzaChannel ? [`• Scrivi la tua richiesta in <#${config.assistenzaChannel}>: diventa un ticket e ti rispondiamo qui`] : []),
  '• `/ticket` apre una nuova richiesta al backoffice (`/ticket oggetto` precompila l\'oggetto)',
  '• `/ticket miei` elenca le tue richieste aperte',
  '• Dal menu `⋯` di un messaggio: *Apri ticket* lo trasforma in richiesta',
  '• Le risposte arrivano qui in DM, nel thread del ticket: rispondi li\'.',
].join('\n');

export function registerSlack(app, store, config) {
  const users = new Map();
  const HELP = helpText(config);

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
    if (t.channel_ts) updates.push(client.chat.update({ channel: config.backofficeChannel, ts: t.channel_ts, ...backofficeCard(t) }));
    if (t.dm_ts) updates.push(client.chat.update({ channel: t.dm_channel, ts: t.dm_ts, ...ticketCard(t, { audience: 'agente' }) }));
    await Promise.all(updates);
  }

  const backofficeCard = (t) => ticketCard(t, { audience: 'backoffice', categories: config.categories });

  /** Crea il ticket, lo pubblica nel canale backoffice e apre il thread in DM. */
  async function openTicket(client, logger, requester, input, source) {
    let t = store.create({ ...input, requesterId: requester.id, requesterName: requester.name, source });
    const posted = await client.chat.postMessage({ channel: config.backofficeChannel, ...backofficeCard(t) });
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

  app.shortcut(MESSAGE_SHORTCUT, async ({ shortcut, ack, client }) => {
    await ack();
    const { permalink } = await client.chat.getPermalink({ channel: shortcut.channel.id, message_ts: shortcut.message.ts });
    const description = [shortcut.message.text, permalink && `Messaggio originale: ${permalink}`].filter(Boolean).join('\n\n');
    await client.views.open({ trigger_id: shortcut.trigger_id, view: newTicketModal(config.categories, { description }) });
  });

  app.view(NEW_TICKET_VIEW, async ({ ack, body, view, client, logger }) => {
    const input = readNewTicket(view);
    if (!input.title.trim()) return ack({ response_action: 'errors', errors: { title: "Scrivi l'oggetto della richiesta" } });
    await ack();

    await openTicket(client, logger, await who(client, body.user.id), input);
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
    // I pulsanti portano l'id nel value; il menu categoria nel block_id della scheda.
    const id = Number(action.value ?? action.block_id?.replace('ticket_', ''));
    let t = store.get(id);
    if (!t) return;

    if (action.action_id === ACTIONS.category) {
      const changed = store.setCategory(id, action.selected_option.value, actor);
      if (changed) await refreshCards(client, changed);
      return;
    }

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

    if (config.assistenzaChannel && event.channel === config.assistenzaChannel) {
      const author = await who(client, event.user);
      if (inThread) {
        // Chi ha aperto il ticket aggiunge dettagli sotto il suo messaggio: li
        // trattiamo come una risposta in DM. Gli altri commenti restano li'.
        const t = store.bySource(event.channel, event.thread_ts);
        if (t && t.requester_id === event.user) await agentReply(client, t, author, event);
        return;
      }
      // Slack ritenta gli eventi non confermati in tempo: un messaggio, un ticket.
      if (store.bySource(event.channel, event.ts)) return;
      const { title, description } = ticketFromMessage(event.text, author.name);
      const input = { title, description: relayText(description, event.files), category: config.defaultCategory };
      const t = await openTicket(client, logger, author, input, { channel: event.channel, ts: event.ts });
      let dmLink = null;
      if (t.dm_ts) dmLink = (await client.chat.getPermalink({ channel: t.dm_channel, message_ts: t.dm_ts }).catch(() => ({}))).permalink;
      await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, ...assistenzaAck(t, dmLink) });
      return;
    }

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
      if (t) await agentReply(client, t, await who(client, event.user), event);
      return;
    }

    logger.debug?.(`Messaggio ignorato in ${event.channel}`);
  });

  async function agentReply(client, t, author, event) {
    const body = relayText(event.text ?? '', event.files);
    const { ticket, statusChanged } = store.reply(t.id, { side: 'agente', authorId: author.id, authorName: author.name, body });
    await postInChannel(client, ticket, { text: body, username: author.name, icon_url: author.icon });
    if (statusChanged) {
      await refreshCards(client, ticket);
      if (t.status === 'risolto') await postInChannel(client, ticket, { text: statusNotice(ticket, author.id, { reopened: true }) });
    }
  }
}
