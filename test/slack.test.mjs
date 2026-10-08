// Il flusso completo su un finto Slack: apertura, inoltri fra i due thread,
// note interne, cambi di stato e riapertura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, NEW_TICKET_VIEW } from '../src/blocks.mjs';
import { registerSlack } from '../src/slack.mjs';
import { TicketStore } from '../src/store.mjs';

const CH = 'CBACKOFFICE';
const AS = 'CASSISTENZA';
const DM = 'DAGENTE';

function fakeSlack() {
  const handlers = { command: {}, view: {}, action: [], event: {}, shortcut: {} };
  const app = {
    command: (n, f) => (handlers.command[n] = f),
    view: (n, f) => (handlers.view[n] = f),
    action: (re, f) => handlers.action.push([re, f]),
    event: (n, f) => (handlers.event[n] = f),
    shortcut: (n, f) => (handlers.shortcut[n] = f),
  };
  const calls = [];
  let ts = 1000;
  const rec = (method, out = {}) => async (args) => (calls.push({ method, ...args }), out);
  const client = {
    users: { info: async ({ user }) => ({ user: { name: user, profile: { real_name: { UAG: 'Marianna', UBO: 'Luca' }[user] ?? user } } }) },
    chat: {
      postMessage: async (args) => (calls.push({ method: 'postMessage', ...args }), { ts: `${++ts}.0` }),
      update: rec('update'),
      postEphemeral: rec('postEphemeral'),
      getPermalink: async ({ channel }) => ({ permalink: `https://slack/${channel}` }),
    },
    conversations: { open: async () => ({ channel: { id: DM } }) },
    views: { open: rec('views.open') },
  };
  const ctx = (extra) => ({ ack: async (r) => calls.push({ method: 'ack', r }), client, logger: console, respond: rec('respond'), ...extra });
  const press = (actionId, ticketId, user = 'UBO') => {
    const [, f] = handlers.action.find(([re]) => re.test(actionId));
    return f(ctx({ action: { action_id: actionId, value: String(ticketId) }, body: { user: { id: user }, channel: { id: CH } } }));
  };
  const say = (event) => handlers.event.message(ctx({ event: { ts: `${++ts}.5`, ...event } }));
  return { app, handlers, calls, ctx, press, say };
}

const submitView = (title) => ({
  state: { values: {
    title: { value: { value: title } },
    category: { value: { selected_option: { value: 'Documenti e visure' } } },
    priority: { value: { selected_option: { value: 'alta' } } },
    description: { value: { value: 'Serve entro venerdi' } },
  } },
});

async function setup(config = {}) {
  const store = new TicketStore(':memory:');
  const slack = fakeSlack();
  registerSlack(slack.app, store, { backofficeChannel: CH, assistenzaChannel: AS, defaultCategory: 'Da classificare', backofficeUsers: [], categories: ['Documenti e visure'], ...config });
  await slack.handlers.view[NEW_TICKET_VIEW](slack.ctx({ view: submitView('Visura via Roma 12'), body: { user: { id: 'UAG' } } }));
  return { store, ...slack, t: () => store.get(1) };
}

test('aprire un ticket lo pubblica nel canale e in DM', async () => {
  const { calls, t } = await setup();
  const posts = calls.filter((c) => c.method === 'postMessage');
  assert.deepEqual(posts.map((p) => p.channel), [CH, DM]);
  assert.match(posts[0].text, /#1 · Visura via Roma 12/);
  assert.ok(t().channel_ts && t().dm_ts);
});

test('oggetto vuoto: il modale torna con errore', async () => {
  const s = fakeSlack();
  const store = new TicketStore(':memory:');
  registerSlack(s.app, store, { backofficeChannel: CH, backofficeUsers: [], categories: [] });
  await s.handlers.view[NEW_TICKET_VIEW](s.ctx({ view: submitView(' '), body: { user: { id: 'UAG' } } }));
  assert.equal(s.calls[0].r.response_action, 'errors');
  assert.equal(store.get(1), null);
});

test('risposta del backoffice arriva in DM e prende in carico', async () => {
  const { say, calls, t } = await setup();
  calls.length = 0;
  await say({ channel: CH, user: 'UBO', text: 'Te la mando entro sera', thread_ts: t().channel_ts });
  const dm = calls.find((c) => c.method === 'postMessage');
  assert.equal(dm.channel, DM);
  assert.equal(dm.thread_ts, t().dm_ts);
  assert.equal(dm.username, 'Luca · Backoffice');
  assert.equal(t().status, 'in_lavorazione');
  assert.equal(t().assignee_id, 'UBO');
  assert.ok(calls.some((c) => c.method === 'update'));
});

test('la nota interna non esce dal canale', async () => {
  const { say, calls, t, store } = await setup();
  calls.length = 0;
  await say({ channel: CH, user: 'UBO', text: 'nota: aspetto il geometra', thread_ts: t().channel_ts });
  assert.equal(calls.filter((c) => c.method === 'postMessage').length, 0);
  assert.equal(store.comments(1)[0].body, 'aspetto il geometra');
});

test('risposta dell\'agente arriva nel thread del backoffice', async () => {
  const { say, calls, t } = await setup();
  calls.length = 0;
  await say({ channel: DM, channel_type: 'im', user: 'UAG', text: 'Allego la planimetria', thread_ts: t().dm_ts, subtype: 'file_share', files: [{ name: 'p.pdf', permalink: 'https://f/p' }] });
  const post = calls.find((c) => c.method === 'postMessage');
  assert.equal(post.channel, CH);
  assert.equal(post.thread_ts, t().channel_ts);
  assert.match(post.text, /planimetria\n📎 <https:\/\/f\/p\|p.pdf>/);
});

test('messaggi di bot e fuori thread sono ignorati', async () => {
  const { say, calls, t, store } = await setup();
  calls.length = 0;
  await say({ channel: CH, bot_id: 'B1', text: 'eco', thread_ts: t().channel_ts });
  await say({ channel: CH, user: 'UBO', text: 'chiacchiere nel canale' });
  await say({ channel: CH, user: 'UBO', subtype: 'message_changed', thread_ts: t().channel_ts });
  assert.equal(calls.length, 0);
  assert.equal(store.comments(1).length, 0);
});

test('pulsanti: in attesa, risolvi, e l\'agente che risponde riapre', async () => {
  const { press, say, calls, t } = await setup();
  await press(ACTIONS.wait, 1);
  assert.equal(t().status, 'in_attesa');
  assert.equal(t().assignee_id, 'UBO');
  await press(ACTIONS.resolve, 1);
  assert.equal(t().status, 'risolto');
  const notices = calls.filter((c) => c.method === 'postMessage' && c.channel === DM && /risolta/.test(c.text));
  assert.equal(notices.length, 1);

  calls.length = 0;
  await say({ channel: DM, channel_type: 'im', user: 'UAG', text: 'Non e\' quella giusta', thread_ts: t().dm_ts });
  assert.equal(t().status, 'in_lavorazione');
  assert.ok(calls.some((c) => c.channel === CH && /riaperto/.test(c.text ?? '')));
});

test('con BACKOFFICE_USERS, gli altri non cambiano stato', async () => {
  const { press, calls, t } = await setup({ backofficeUsers: ['UBO'] });
  await press(ACTIONS.resolve, 1, 'UAG');
  assert.equal(t().status, 'aperto');
  assert.ok(calls.some((c) => c.method === 'postEphemeral'));
});

test('/ticket miei elenca le richieste aperte', async () => {
  const { handlers, ctx, calls } = await setup();
  await handlers.command['/ticket'](ctx({ command: { text: 'miei', user_id: 'UAG' } }));
  const r = calls.find((c) => c.method === 'respond');
  assert.match(r.text, /1 richieste aperte/);
});

// --- Canale #assistenza ---------------------------------------------------------

async function setupAssistenza() {
  const store = new TicketStore(':memory:');
  const slack = fakeSlack();
  registerSlack(slack.app, store, { backofficeChannel: CH, assistenzaChannel: AS, defaultCategory: 'Da classificare', backofficeUsers: [], categories: ['Documenti e visure'] });
  return { store, ...slack };
}

test('un messaggio in #assistenza apre un ticket e risponde in thread', async () => {
  const { say, calls, store } = await setupAssistenza();
  await say({ channel: AS, user: 'UAG', ts: '500.1', text: 'Mi serve la visura di via Roma 12\nper il rogito di venerdi' });
  const t = store.get(1);
  assert.equal(t.title, 'Mi serve la visura di via Roma 12');
  assert.equal(t.category, 'Da classificare');
  assert.equal(t.requester_id, 'UAG');
  const posts = calls.filter((c) => c.method === 'postMessage');
  assert.deepEqual(posts.map((p) => p.channel), [CH, DM, AS]);
  assert.equal(posts[2].thread_ts, '500.1');
  assert.match(posts[2].text, /Ticket #1 aperto.*<https:\/\/slack\/DAGENTE\|/);
});

test('lo stesso messaggio ritentato da Slack non apre due ticket', async () => {
  const { say, store } = await setupAssistenza();
  await say({ channel: AS, user: 'UAG', ts: '500.1', text: 'Visura' });
  await say({ channel: AS, user: 'UAG', ts: '500.1', text: 'Visura' });
  assert.equal(store.list().length, 1);
});

test('solo allegato: oggetto di ripiego, allegato nei dettagli', async () => {
  const { say, store } = await setupAssistenza();
  await say({ channel: AS, user: 'UAG', ts: '500.1', subtype: 'file_share', text: '', files: [{ name: 'p.pdf', permalink: 'https://f/p' }] });
  assert.equal(store.get(1).title, 'Richiesta di Marianna');
  assert.match(store.get(1).description, /p\.pdf/);
});

test('in thread su #assistenza conta solo chi ha aperto il ticket', async () => {
  const { say, calls, store } = await setupAssistenza();
  await say({ channel: AS, user: 'UAG', ts: '500.1', text: 'Visura' });
  calls.length = 0;
  await say({ channel: AS, user: 'UXX', thread_ts: '500.1', text: 'anche a me!' });
  assert.equal(store.comments(1).length, 0);
  await say({ channel: AS, user: 'UAG', thread_ts: '500.1', text: 'foglio 12' });
  assert.equal(store.comments(1)[0].body, 'foglio 12');
  assert.equal(calls.at(-1).channel, CH);
});

test('il backoffice cambia categoria dal menu della scheda', async () => {
  const { say, handlers, ctx, store, calls } = await setupAssistenza();
  await say({ channel: AS, user: 'UAG', ts: '500.1', text: 'Visura' });
  const [, f] = handlers.action.find(([re]) => re.test(ACTIONS.category));
  calls.length = 0;
  await f(ctx({ action: { action_id: ACTIONS.category, block_id: 'ticket_1', selected_option: { value: 'Documenti e visure' } }, body: { user: { id: 'UBO' } , channel: { id: CH } } }));
  assert.equal(store.get(1).category, 'Documenti e visure');
  assert.equal(calls.filter((c) => c.method === 'update').length, 2);
});
