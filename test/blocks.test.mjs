import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, INTERNAL_PREFIX, newTicketModal, readNewTicket, relayText, ticketCard } from '../src/blocks.mjs';

const base = {
  id: 7, title: 'Visura', description: 'Via Roma 12', category: 'Altro', priority: 'alta', status: 'aperto',
  requester_id: 'UAG', assignee_id: null, created_at: '2026-10-08T10:00:00Z',
};
const actionIds = (card) => card.blocks.find((b) => b.type === 'actions')?.elements.map((e) => e.action_id) ?? [];

test('la scheda backoffice ha i pulsanti giusti per stato', () => {
  assert.deepEqual(actionIds(ticketCard(base, { audience: 'backoffice' })), [ACTIONS.take, ACTIONS.wait, ACTIONS.resolve]);
  assert.deepEqual(actionIds(ticketCard({ ...base, assignee_id: 'UBO', status: 'in_attesa' }, { audience: 'backoffice' })), [ACTIONS.resolve]);
  assert.deepEqual(actionIds(ticketCard({ ...base, status: 'risolto' }, { audience: 'backoffice' })), [ACTIONS.reopen]);
});

test('la scheda in DM non ha pulsanti', () => {
  const card = ticketCard(base, { audience: 'agente' });
  assert.deepEqual(actionIds(card), []);
  assert.match(card.text, /#7 · Visura/);
});

test('il modale si rilegge nei suoi valori', () => {
  const view = newTicketModal(['Altro'], { title: 'Ciao' });
  assert.equal(view.blocks[0].element.initial_value, 'Ciao');
  const values = {
    title: { value: { value: 'Ciao' } },
    category: { value: { selected_option: { value: 'Altro' } } },
    priority: { value: { selected_option: { value: 'urgente' } } },
    description: { value: { value: null } },
  };
  assert.deepEqual(readNewTicket({ state: { values } }), { title: 'Ciao', category: 'Altro', priority: 'urgente', description: '' });
});

test('prefisso nota interna', () => {
  assert.ok(INTERNAL_PREFIX.test('Nota: chiamare il notaio'));
  assert.ok(!INTERNAL_PREFIX.test('una nota: qui no'));
});

test('gli allegati diventano link', () => {
  assert.equal(relayText('ecco', [{ name: 'a.pdf', permalink: 'https://x/a' }]), 'ecco\n📎 <https://x/a|a.pdf>');
  assert.equal(relayText('', [{ name: 'a.pdf', permalink: 'https://x/a' }]), '📎 <https://x/a|a.pdf>');
});
