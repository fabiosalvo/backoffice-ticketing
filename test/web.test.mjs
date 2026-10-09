import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createDesk } from '../src/desk.mjs';
import { TicketStore } from '../src/store.mjs';
import { csrfToken, dashboardHandler, escapeHtml, friendlyDate, slackLink } from '../src/web.mjs';

const PASSWORD = 'segreta';
const CH = 'CHELPDESK';
const DM = 'DAGENTE';

function call(handler, path, { password = PASSWORD, method = 'GET', form, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = Readable.from(form ? [new URLSearchParams(form).toString()] : []);
    Object.assign(req, {
      url: path,
      method,
      headers: {
        host: 'ticket.example',
        ...(password ? { authorization: 'Basic ' + Buffer.from(`x:${password}`).toString('base64') } : {}),
        ...headers,
      },
    });
    const res = {
      status: 0, body: '', headers: {}, headersSent: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(s, h = {}) { this.status = s; this.headersSent = true; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; return this; },
      end(b = '') { this.body = String(b); resolve(this); return this; },
    };
    handler(req, res);
  });
}

function fakeClient() {
  const calls = [];
  let ts = 100;
  return {
    calls,
    users: {
      info: async ({ user }) => ({ user: { id: user, profile: { real_name: user } } }),
      list: async () => ({
        members: [
          { id: 'UBO', profile: { real_name: 'Luca Rossi' } },
          { id: 'UFS', profile: { real_name: 'Fabio Salvo' } },
          { id: 'UBOT', is_bot: true, profile: { real_name: 'Bot' } },
          { id: 'UOLD', deleted: true, profile: { real_name: 'Ex' } },
        ],
      }),
    },
    chat: {
      postMessage: async (a) => (calls.push({ m: 'post', ...a }), { ts: `${++ts}.0` }),
      update: async (a) => (calls.push({ m: 'update', ...a }), {}),
    },
  };
}

const config = { dashboardPassword: PASSWORD, backofficeChannel: CH, backofficeUsers: [], workspaceUrl: 'https://gromia.slack.com', categories: ['Altro', 'Pubblicazione annunci'] };

function setup() {
  const store = new TicketStore(':memory:');
  const t = store.create({ title: '<script>x</script>', description: 'Annuncio 132w non visibile', category: 'Altro', requesterId: 'UAG', requesterName: 'Mauro Lonardo' });
  store.setSlackRefs(t.id, { channelTs: '1.0', dmChannel: DM, dmTs: '2.0' });
  const client = fakeClient();
  const desk = createDesk(store, config);
  return { store, client, h: dashboardHandler(store, config, { desk, client }) };
}

const reply = (h, form, extra = {}) =>
  call(h, '/t/1/reply', { method: 'POST', form: { csrf: csrfToken(PASSWORD), operator: 'UBO', ...form }, ...extra });

test('senza password giusta non si entra', async () => {
  const { h } = setup();
  assert.equal((await call(h, '/', { password: null })).status, 401);
  assert.equal((await call(h, '/', { password: 'sbagliata' })).status, 401);
  assert.equal((await call(h, '/health', { password: null })).status, 200);
});

test('senza password la dashboard resta chiusa, /health risponde', async () => {
  const h = dashboardHandler(new TicketStore(':memory:'), { dashboardPassword: '' });
  assert.equal((await call(h, '/', { password: null })).status, 404);
  assert.equal((await call(h, '/health', { password: null })).status, 200);
});

test('lista e dettaglio, con escaping e box di risposta', async () => {
  const { h } = setup();
  const list = await call(h, '/');
  assert.equal(list.status, 200);
  assert.match(list.body, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(list.body, /<script>x/);
  const detail = await call(h, '/t/1');
  assert.equal(detail.status, 200);
  assert.match(detail.body, /Risposta pubblica/);
  assert.match(detail.body, /Nota interna/);
  assert.match(detail.body, /Invia come <b>Aperto<\/b>/);
  assert.match(detail.body, /Invia come <b>In attesa<\/b>/);
  assert.match(detail.body, /Invia come <b>Risolto<\/b>/);
  assert.match(detail.body, /Annuncio 132w non visibile/);
  assert.match(detail.body, /<option value="UBO">Luca Rossi<\/option>/);
  assert.doesNotMatch(detail.body, /UBOT|UOLD/);
  assert.match(detail.body, /<option value="" selected disabled>Scegli…<\/option>/);
  const remembered = await call(h, '/t/1', { headers: { cookie: 'operator=UBO' } });
  assert.match(remembered.body, /<option value="UBO" selected>Luca Rossi<\/option>/);
  assert.equal((await call(h, '/t/99')).status, 404);
});

test('risposta pubblica "Invia come In attesa": arriva nel DM e nel canale, cambia stato', async () => {
  const { h, store, client } = setup();
  const res = await reply(h, { kind: 'pubblica', body: 'Mi mandi il link?', status: 'in_attesa' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/t/1?ok=inviato');
  assert.match(res.headers['set-cookie'], /operator=UBO/);

  const posts = client.calls.filter((c) => c.m === 'post');
  const inChannel = posts.find((p) => p.channel === CH && p.text === 'Mi mandi il link?');
  const inDm = posts.find((p) => p.channel === DM && p.text === 'Mi mandi il link?');
  assert.equal(inChannel.thread_ts, '1.0');
  assert.equal(inDm.thread_ts, '2.0');
  assert.equal(inDm.username, 'Luca Rossi · Backoffice');
  assert.ok(posts.some((p) => p.channel === DM && /attende una tua risposta/.test(p.text)));

  const t = store.get(1);
  assert.equal(t.status, 'in_attesa');
  assert.equal(t.assignee_id, 'UBO');
  assert.equal(store.comments(1).find((c) => c.side === 'backoffice').body, 'Mi mandi il link?');
});

test('nota interna: resta nel canale, non arriva all agente', async () => {
  const { h, client, store } = setup();
  const res = await reply(h, { kind: 'interna', body: 'sentire il portale', status: 'in_lavorazione' });
  assert.equal(res.headers.location, '/t/1?ok=nota');
  const posts = client.calls.filter((c) => c.m === 'post');
  assert.ok(posts.some((p) => p.channel === CH && /Nota interna/.test(p.text)));
  assert.ok(!posts.some((p) => p.channel === DM && /sentire il portale/.test(p.text)));
  assert.equal(store.comments(1).find((c) => c.internal).body, 'sentire il portale');
});

test('"Invia come Risolto" senza testo cambia solo lo stato', async () => {
  const { h, store } = setup();
  const res = await reply(h, { kind: 'pubblica', body: '', status: 'risolto' });
  assert.equal(res.headers.location, '/t/1?ok=stato');
  assert.equal(store.get(1).status, 'risolto');
});

test('invio vuoto, operatore sconosciuto, CSRF e origine estranea vengono respinti', async () => {
  const { h, store, client } = setup();
  assert.equal((await reply(h, { body: '' })).headers.location, '/t/1?ok=vuoto');
  assert.equal((await reply(h, { body: 'ciao', operator: 'UOLD' })).headers.location, '/t/1?ok=operatore');
  assert.equal((await reply(h, { body: 'ciao', csrf: 'falso' })).status, 403);
  assert.equal((await reply(h, { body: 'ciao' }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal(store.comments(1).length, 0);
  assert.equal(client.calls.length, 0);
});

test('pannello: assegnatario, priorita\' e categoria si modificano con "Aggiorna"', async () => {
  const { h, store, client } = setup();
  const detail = (await call(h, '/t/1')).body;
  assert.match(detail, /<select name="assignee" form="reply-form"/);
  assert.match(detail, /<select name="priority" form="reply-form"/);
  assert.match(detail, /<option value="Pubblicazione annunci">/);

  const res = await reply(h, { body: '', status: '', assignee: 'UFS', priority: 'alta', category: 'Pubblicazione annunci' });
  assert.equal(res.headers.location, '/t/1?ok=salvato');
  const t = store.get(1);
  assert.equal(t.assignee_id, 'UFS');
  assert.equal(t.assignee_name, 'Fabio Salvo');
  assert.equal(t.priority, 'alta');
  assert.equal(t.category, 'Pubblicazione annunci');
  assert.equal(t.status, 'aperto');
  const history = store.comments(1).map((c) => c.body).join('\n');
  assert.match(history, /Luca Rossi: priorita' da Normale a Alta/);
  assert.match(history, /Luca Rossi: categoria da "Altro" a "Pubblicazione annunci"/);
  assert.match(history, /Luca Rossi: assegnato a Fabio Salvo/);
  // nel canale una riga con la menzione, cosi' Slack avvisa il nuovo assegnatario; all'agente niente
  assert.ok(client.calls.some((c) => c.m === 'post' && c.channel === CH && /assegnato a <@UFS>/.test(c.text)));
  assert.ok(!client.calls.some((c) => c.m === 'post' && c.channel === DM));
  assert.ok(client.calls.some((c) => c.m === 'update'));

  // nessuna modifica: niente da salvare
  const same = await reply(h, { body: '', status: '', assignee: 'UFS', priority: 'alta', category: 'Pubblicazione annunci' });
  assert.equal(same.headers.location, '/t/1?ok=vuoto');
});

test('pannello: rispondere assegnando a un collega lascia il collega', async () => {
  const { h, store } = setup();
  await reply(h, { body: 'Se ne occupa Fabio', status: 'in_lavorazione', assignee: 'UFS' });
  assert.equal(store.get(1).assignee_id, 'UFS');
  assert.equal(store.get(1).status, 'in_lavorazione');
});

test('pannello: valori non validi vengono ignorati, "Nessuno" toglie l\'assegnatario', async () => {
  const { h, store } = setup();
  await reply(h, { body: '', status: '', assignee: 'UFS' });
  assert.equal((await reply(h, { body: '', status: '', assignee: 'USCONOSCIUTO', priority: 'altissima', category: 'Inventata' })).headers.location, '/t/1?ok=vuoto');
  assert.equal(store.get(1).assignee_id, 'UFS');
  assert.equal(store.get(1).priority, 'normale');
  await reply(h, { body: '', status: '', assignee: '' });
  assert.equal(store.get(1).assignee_id, null);
});

const team = (h, form, extra = {}) =>
  call(h, '/team', { method: 'POST', form: { csrf: csrfToken(PASSWORD), ...form }, ...extra });

test('team: si aggiunge e si toglie dalla dashboard, e decide chi risponde', async () => {
  const { h, store } = setup();
  const empty = await call(h, '/team');
  assert.match(empty.body, /Il team è vuoto/);
  assert.match((await call(h, '/t/1')).body, /<option value="UFS">Fabio Salvo<\/option>/);

  assert.equal((await team(h, { action: 'add', user: 'UBO' })).headers.location, '/team?ok=aggiunto');
  assert.deepEqual(store.team().map((m) => [m.user_id, m.name]), [['UBO', 'Luca Rossi']]);
  const page = await call(h, '/team');
  assert.match(page.body, /<b>Luca Rossi<\/b>/);
  assert.doesNotMatch(page.body, /Il team è vuoto/);
  // in "Aggiungi" restano solo quelli fuori dal team
  assert.match(page.body, /<option value="UFS">Fabio Salvo<\/option>/);
  assert.doesNotMatch(page.body, /<option value="UBO">/);

  // "Rispondi come" mostra solo il team, e chi e' fuori non puo' rispondere
  const detail = (await call(h, '/t/1')).body;
  assert.match(detail, /<option value="UBO">Luca Rossi<\/option>/);
  assert.doesNotMatch(detail, /Fabio Salvo/);
  assert.equal((await reply(h, { body: 'ciao', operator: 'UFS' })).headers.location, '/t/1?ok=operatore');

  assert.equal((await team(h, { action: 'remove', user: 'UBO' })).headers.location, '/team?ok=rimosso');
  assert.equal(store.team().length, 0);
});

test('team: niente aggiunte senza CSRF o di persone fuori dal workspace', async () => {
  const { h, store } = setup();
  assert.equal((await team(h, { action: 'add', user: 'UBO', csrf: 'falso' })).status, 403);
  assert.equal((await team(h, { action: 'add', user: 'UNESSUNO' })).status, 400);
  assert.equal(store.team().length, 0);
});

test('helper', () => {
  assert.equal(escapeHtml(`a"b'<`), 'a&quot;b&#39;&lt;');
  assert.equal(slackLink('https://gromia.slack.com/', 'C1', '1712.0001'), 'https://gromia.slack.com/archives/C1/p17120001');
  assert.equal(slackLink('', 'C1', '1'), null);
  const now = new Date('2026-10-09T12:00:00Z');
  assert.match(friendlyDate('2026-10-09T09:04:00Z', now), /^Oggi, 11:04$/);
  assert.match(friendlyDate('2026-10-08T09:04:00Z', now), /^Ieri, 11:04$/);
});
