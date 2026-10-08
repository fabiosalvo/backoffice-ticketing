import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TicketStore } from '../src/store.mjs';
import { dashboardHandler, escapeHtml, slackLink } from '../src/web.mjs';

function call(handler, path, password) {
  return new Promise((resolve) => {
    const req = { url: path, method: 'GET', headers: password ? { authorization: 'Basic ' + Buffer.from(`x:${password}`).toString('base64') } : {} };
    const res = {
      status: 0, body: '',
      writeHead(s) { this.status = s; return this; },
      end(b = '') { this.body = String(b); resolve(this); return this; },
    };
    handler(req, res);
  });
}

const setup = () => {
  const store = new TicketStore(':memory:');
  store.create({ title: '<script>x</script>', category: 'Altro', requesterId: 'U', requesterName: 'Marianna' });
  return dashboardHandler(store, { dashboardPassword: 'segreta', backofficeChannel: 'C1', workspaceUrl: 'https://gromia.slack.com' });
};

test('senza password giusta non si entra', async () => {
  const h = setup();
  assert.equal((await call(h, '/')).status, 401);
  assert.equal((await call(h, '/', 'sbagliata')).status, 401);
  assert.equal((await call(h, '/health')).status, 200);
});

test('lista e dettaglio, con escaping', async () => {
  const h = setup();
  const list = await call(h, '/', 'segreta');
  assert.equal(list.status, 200);
  assert.match(list.body, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(list.body, /<script>x/);
  assert.equal((await call(h, '/t/1', 'segreta')).status, 200);
  assert.equal((await call(h, '/t/99', 'segreta')).status, 404);
});

test('helper', () => {
  assert.equal(escapeHtml(`a"b'<`), 'a&quot;b&#39;&lt;');
  assert.equal(slackLink('https://gromia.slack.com/', 'C1', '1712.0001'), 'https://gromia.slack.com/archives/C1/p17120001');
  assert.equal(slackLink('', 'C1', '1'), null);
});
