import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TicketStore, statusAfterReply } from '../src/store.mjs';

const agente = { requesterId: 'UAG', requesterName: 'Marianna' };
const bo = { id: 'UBO', name: 'Luca' };
const nuovo = (s) => s.create({ title: 'Visura via Roma 12', category: 'Documenti e visure', ...agente });

test('un ticket nuovo e\' aperto e senza assegnatario', () => {
  const s = new TicketStore(':memory:');
  const t = nuovo(s);
  assert.equal(t.id, 1);
  assert.equal(t.status, 'aperto');
  assert.equal(t.priority, 'normale');
  assert.equal(t.assignee_id, null);
});

test('il titolo e\' obbligatorio', () => {
  const s = new TicketStore(':memory:');
  assert.throws(() => s.create({ title: '  ', category: 'Altro', ...agente }));
});

test('la prima risposta del backoffice prende in carico il ticket', () => {
  const s = new TicketStore(':memory:');
  const { ticket, statusChanged } = s.reply(nuovo(s).id, { side: 'backoffice', authorId: bo.id, authorName: bo.name, body: 'Ci penso io' });
  assert.equal(ticket.status, 'in_lavorazione');
  assert.equal(ticket.assignee_id, 'UBO');
  assert.ok(statusChanged);
});

test('una nota interna non cambia stato ne\' assegnatario', () => {
  const s = new TicketStore(':memory:');
  const { ticket, statusChanged } = s.reply(nuovo(s).id, { side: 'backoffice', authorId: bo.id, authorName: bo.name, body: 'chiedere al notaio', internal: true });
  assert.equal(ticket.status, 'aperto');
  assert.equal(ticket.assignee_id, null);
  assert.equal(statusChanged, false);
  assert.equal(s.comments(ticket.id)[0].internal, 1);
});

test('la risposta dell\'agente riapre un ticket risolto', () => {
  const s = new TicketStore(':memory:');
  const t = nuovo(s);
  s.assign(t.id, bo);
  s.setStatus(t.id, 'risolto', bo);
  assert.ok(s.get(t.id).resolved_at);
  const { ticket } = s.reply(t.id, { side: 'agente', authorId: 'UAG', authorName: 'Marianna', body: 'Manca la planimetria' });
  assert.equal(ticket.status, 'in_lavorazione');
  assert.equal(ticket.resolved_at, null);
});

test('regole di stato dopo una risposta', () => {
  assert.equal(statusAfterReply({ status: 'in_attesa', assignee_id: null }, 'agente'), 'aperto');
  assert.equal(statusAfterReply({ status: 'in_attesa', assignee_id: 'U' }, 'agente'), 'in_lavorazione');
  assert.equal(statusAfterReply({ status: 'aperto' }, 'agente'), 'aperto');
  assert.equal(statusAfterReply({ status: 'in_attesa' }, 'backoffice'), 'in_attesa');
});

test('setStatus restituisce null se lo stato non cambia e traccia lo storico', () => {
  const s = new TicketStore(':memory:');
  const t = nuovo(s);
  assert.equal(s.setStatus(t.id, 'aperto', bo), null);
  s.setStatus(t.id, 'in_attesa', bo);
  assert.match(s.comments(t.id).at(-1).body, /Luca ha portato il ticket da "Nuovo"/);
});

test('list filtra per aperti, richiedente e testo, urgenti prima', () => {
  const s = new TicketStore(':memory:');
  nuovo(s);
  s.create({ title: 'Accesso gestionale', category: 'IT e accessi', priority: 'urgente', requesterId: 'UX', requesterName: 'Paolo' });
  const chiuso = nuovo(s);
  s.setStatus(chiuso.id, 'risolto', bo);
  assert.deepEqual(s.list({ status: 'aperti' }).map((t) => t.id), [2, 1]);
  assert.deepEqual(s.list({ requesterId: 'UAG' }).map((t) => t.id).sort(), [1, 3]);
  assert.deepEqual(s.list({ q: 'gestionale' }).map((t) => t.id), [2]);
  assert.deepEqual(s.list({ q: '#3' }).map((t) => t.id), [3]);
  assert.deepEqual(s.counts(), { aperto: 2, in_lavorazione: 0, in_attesa: 0, risolto: 1 });
});

test('team: aggiunta, rinomina, rimozione', () => {
  const s = new TicketStore(':memory:');
  assert.deepEqual(s.team(), []);
  s.addToTeam('UB', 'Bruno');
  s.addToTeam('UA', 'anna');
  s.addToTeam('UB', 'Bruno Neri');
  assert.deepEqual(s.team().map((m) => m.name), ['anna', 'Bruno Neri']);
  assert.ok(s.inTeam('UA'));
  assert.ok(s.removeFromTeam('UA'));
  assert.equal(s.removeFromTeam('UA'), false);
  assert.ok(!s.inTeam('UA'));
});
