// Messaggi e modali Slack (Block Kit). Funzioni pure: nessuna chiamata a Slack
// qui dentro, cosi' si testano senza workspace.

import { PRIORITIES, STATUSES } from './store.mjs';

export const ACTIONS = {
  take: 'ticket_take',
  wait: 'ticket_wait',
  resolve: 'ticket_resolve',
  reopen: 'ticket_reopen',
  category: 'ticket_category',
};

export const NEW_TICKET_VIEW = 'ticket_new';

// Prefisso che trasforma una risposta del backoffice in nota interna: resta
// nel ticket e nel canale, ma non arriva all'agente.
export const INTERNAL_PREFIX = /^\s*nota\s*:\s*/i;

const MAX_TEXT = 2900; // Slack taglia i blocchi section a 3000 caratteri

const truncate = (s, n = MAX_TEXT) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export const formatDate = (iso) =>
  new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

const option = (value, label) => ({ text: { type: 'plain_text', text: label }, value });

export function newTicketModal(categories, prefill = {}) {
  return {
    type: 'modal',
    callback_id: NEW_TICKET_VIEW,
    title: { type: 'plain_text', text: 'Nuova richiesta' },
    submit: { type: 'plain_text', text: 'Invia al backoffice' },
    close: { type: 'plain_text', text: 'Annulla' },
    blocks: [
      {
        type: 'input',
        block_id: 'title',
        label: { type: 'plain_text', text: 'Oggetto' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          max_length: 150,
          placeholder: { type: 'plain_text', text: 'Es. Visura catastale per via Roma 12' },
          ...(prefill.title ? { initial_value: prefill.title.slice(0, 150) } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'category',
        label: { type: 'plain_text', text: 'Categoria' },
        element: {
          type: 'static_select',
          action_id: 'value',
          options: categories.map((c) => option(c, c)),
        },
      },
      {
        type: 'input',
        block_id: 'priority',
        label: { type: 'plain_text', text: 'Priorita\'' },
        element: {
          type: 'static_select',
          action_id: 'value',
          initial_option: option('normale', PRIORITIES.normale.label),
          options: Object.entries(PRIORITIES).map(([k, p]) => option(k, p.label)),
        },
      },
      {
        type: 'input',
        block_id: 'description',
        optional: true,
        label: { type: 'plain_text', text: 'Dettagli' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Immobile, cliente, scadenza, link utili…' },
          ...(prefill.description ? { initial_value: prefill.description.slice(0, 3000) } : {}),
        },
      },
    ],
  };
}

/** Legge i valori inviati dal modale. */
export function readNewTicket(view) {
  const v = view.state.values;
  return {
    title: v.title.value.value ?? '',
    category: v.category.value.selected_option?.value,
    priority: v.priority.value.selected_option?.value ?? 'normale',
    description: v.description.value.value ?? '',
  };
}

const TITLE_MAX = 80;

/**
 * Un messaggio libero scritto in #assistenza diventa oggetto + dettagli:
 * l'oggetto e' la prima riga (accorciata a parola intera), i dettagli il testo
 * completo quando aggiunge qualcosa all'oggetto.
 */
export function ticketFromMessage(text, authorName) {
  const clean = (text ?? '').trim();
  const firstLine = clean.split('\n').find((l) => l.trim())?.trim() ?? '';
  let title = firstLine;
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX - 1);
    title = (cut.lastIndexOf(' ') > TITLE_MAX / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut) + '…';
  }
  if (!title) title = `Richiesta di ${authorName}`;
  return { title, description: clean === title ? '' : clean };
}

/** Risposta in thread nel canale #assistenza: il ticket c'e', si prosegue in privato. */
export function assistenzaAck(t, dmLink) {
  const where = dmLink ? `<${dmLink}|nei messaggi diretti con me>` : 'nei messaggi diretti con me';
  return {
    text: `🎫 Ticket #${t.id} aperto. Ti risponde il backoffice ${where}: prosegui li'.`,
  };
}

export const ticketHeadline = (t) => `#${t.id} · ${t.title}`;

const button = (text, actionId, ticketId, style) => ({
  type: 'button',
  text: { type: 'plain_text', text },
  action_id: actionId,
  value: String(ticketId),
  ...(style ? { style } : {}),
});

/**
 * La scheda del ticket. Nel canale backoffice porta i pulsanti di stato; nel
 * DM dell'agente e' solo informativa.
 */
export function ticketCard(t, { audience, categories = [] }) {
  const status = STATUSES[t.status];
  const priority = PRIORITIES[t.priority];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: truncate(ticketHeadline(t), 150) } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Stato*\n${status.emoji} ${status.label}` },
        { type: 'mrkdwn', text: `*Priorita'*\n${priority.emoji} ${priority.label}` },
        { type: 'mrkdwn', text: `*Categoria*\n${t.category}` },
        { type: 'mrkdwn', text: `*Richiedente*\n<@${t.requester_id}>` },
        { type: 'mrkdwn', text: `*In carico a*\n${t.assignee_id ? `<@${t.assignee_id}>` : '—'}` },
        { type: 'mrkdwn', text: `*Aperto il*\n${formatDate(t.created_at)}` },
      ],
    },
  ];
  if (t.description) blocks.push({ type: 'section', text: { type: 'plain_text', text: truncate(t.description) } });

  if (audience === 'backoffice') {
    const buttons = [];
    if (t.status === 'risolto') {
      buttons.push(button('Riapri', ACTIONS.reopen, t.id));
    } else {
      if (!t.assignee_id) buttons.push(button('Prendi in carico', ACTIONS.take, t.id));
      if (t.status !== 'in_attesa') buttons.push(button("In attesa dell'agente", ACTIONS.wait, t.id));
      buttons.push(button('Risolvi', ACTIONS.resolve, t.id, 'primary'));
    }
    if (categories.length) {
      const options = [...new Set([t.category, ...categories])].map((c) => option(c, c.slice(0, 75)));
      buttons.push({
        type: 'static_select',
        action_id: ACTIONS.category,
        placeholder: { type: 'plain_text', text: 'Categoria' },
        initial_option: options[0],
        options,
      });
    }
    blocks.push({ type: 'actions', block_id: `ticket_${t.id}`, elements: buttons });
    blocks.push(context("Rispondi in thread per scrivere all'agente · inizia con `nota:` per una nota interna"));
  } else {
    blocks.push(
      context(
        t.status === 'risolto'
          ? 'Ticket risolto. Rispondi in questo thread se serve riaprirlo.'
          : 'Rispondi in questo thread per scrivere al backoffice.',
      ),
    );
  }
  return { text: `${status.emoji} ${ticketHeadline(t)}`, blocks };
}

function context(text) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

/** Messaggio in thread quando cambia lo stato. */
export function statusNotice(t, actorId, { reopened = false } = {}) {
  const s = STATUSES[t.status];
  if (reopened) return `🔁 Ticket riaperto da <@${actorId}>.`;
  const lines = {
    in_lavorazione: `${s.emoji} <@${actorId}> ha preso in carico la richiesta.`,
    in_attesa: `${s.emoji} <@${actorId}> attende una tua risposta: rispondi in questo thread.`,
    risolto: `${s.emoji} <@${actorId}> ha segnato la richiesta come risolta. Rispondi qui se serve riaprirla.`,
  };
  return lines[t.status] ?? `${s.emoji} Stato: ${s.label}`;
}

/** Testo di una risposta inoltrata dall'altra parte. */
export function relayText(body, files = []) {
  const links = files.filter((f) => f.permalink).map((f) => `📎 <${f.permalink}|${f.name ?? 'allegato'}>`);
  return [body, ...links].filter(Boolean).join('\n');
}

/** Elenco per /ticket miei. */
export function myTicketsBlocks(tickets) {
  if (!tickets.length) return { text: 'Nessuna richiesta aperta.', blocks: [context('Nessuna richiesta aperta. `/ticket` per aprirne una.')] };
  return {
    text: `Hai ${tickets.length} richieste aperte`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Le tue richieste aperte (${tickets.length})*` } },
      ...tickets.map((t) => ({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${STATUSES[t.status].emoji} *#${t.id}* ${t.title}\n${STATUSES[t.status].label} · ${t.category}${t.assignee_id ? ` · in carico a <@${t.assignee_id}>` : ''}`,
        },
      })),
    ],
  };
}
