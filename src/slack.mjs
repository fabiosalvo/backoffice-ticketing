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
} from './blocks.mjs';
import { createDesk } from './desk.mjs';

// Scorciatoia globale: compare scrivendo "/" in qualsiasi campo messaggio
// (e nel menu ⚡) e apre direttamente il modulo, senza digitare comandi.
export const NEW_TICKET_SHORTCUT = 'ticket_new_shortcut';

const HELP = [
  '*Come usare i ticket*',
  '• Scrivi `/` e scegli *Nuovo ticket*, oppure `/ticket`: apre una nuova richiesta al backoffice (`/ticket oggetto` precompila l\'oggetto)',
  '• `/ticket miei` elenca le tue richieste aperte',
  '• Le risposte arrivano qui in DM, nel thread del ticket: rispondi li\'.',
].join('\n');

export function registerSlack(app, store, config, desk = createDesk(store, config)) {
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
    await desk.openTicket(client, logger, await desk.who(client, body.user.id), input);
  });

  // --- Pulsanti di stato ---------------------------------------------------------

  app.action(/^ticket_/, async ({ action, ack, body, client }) => {
    await ack();
    const userId = body.user.id;
    if (!desk.isBackoffice(userId)) {
      return client.chat.postEphemeral({
        channel: body.channel.id,
        user: userId,
        text: 'Solo il backoffice puo\' cambiare lo stato dei ticket.',
      });
    }
    const actor = await desk.who(client, userId);
    const id = Number(action.value);
    const t = store.get(id);
    if (!t) return;

    if (action.action_id === ACTIONS.take) {
      store.assign(id, actor);
      await desk.changeStatus(client, id, 'in_lavorazione', actor);
    } else if (action.action_id === ACTIONS.wait) {
      await desk.changeStatus(client, id, 'in_attesa', actor);
    } else if (action.action_id === ACTIONS.resolve) {
      await desk.changeStatus(client, id, 'risolto', actor);
    } else if (action.action_id === ACTIONS.reopen) {
      await desk.changeStatus(client, id, t.assignee_id ? 'in_lavorazione' : 'aperto', actor, { reopened: true });
    }
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
      const internal = INTERNAL_PREFIX.test(event.text ?? '');
      const body = relayText((event.text ?? '').replace(INTERNAL_PREFIX, ''), event.files);
      await desk.backofficeReply(client, t.id, await desk.who(client, event.user), { body, internal, fromSlack: true });
      return;
    }

    if (event.channel_type === 'im') {
      if (!inThread) {
        await client.chat.postMessage({ channel: event.channel, text: HELP });
        return;
      }
      const t = store.byDmThread(event.channel, event.thread_ts);
      if (!t) return;
      await desk.agentReply(client, t.id, await desk.who(client, event.user), { text: event.text, files: event.files });
      return;
    }

    logger.debug?.(`Messaggio ignorato in ${event.channel}`);
  });
}
