import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// --- Vocabolario ---------------------------------------------------------------

export const STATUSES = {
  aperto: { label: 'Aperto', emoji: '🟡' },
  in_lavorazione: { label: 'In lavorazione', emoji: '🔵' },
  in_attesa: { label: "In attesa dell'agente", emoji: '🟠' },
  risolto: { label: 'Risolto', emoji: '🟢' },
};

export const PRIORITIES = {
  bassa: { label: 'Bassa', emoji: '⚪' },
  normale: { label: 'Normale', emoji: '🔵' },
  alta: { label: 'Alta', emoji: '🟠' },
  urgente: { label: 'Urgente', emoji: '🔴' },
};

export const OPEN_STATUSES = ['aperto', 'in_lavorazione', 'in_attesa'];

/**
 * Lo stato dopo una risposta in thread. Le regole sono quelle di un helpdesk:
 * - il backoffice che risponde a un ticket aperto lo prende in lavorazione;
 * - l'agente che risponde a un ticket in attesa o risolto lo rimette in coda,
 *   cosi' una risposta non resta mai sepolta in un ticket chiuso.
 * Le note interne non spostano nulla.
 */
export function statusAfterReply(ticket, side, internal = false) {
  if (internal) return ticket.status;
  if (side === 'backoffice' && ticket.status === 'aperto') return 'in_lavorazione';
  if (side === 'agente' && (ticket.status === 'in_attesa' || ticket.status === 'risolto')) {
    return ticket.assignee_id ? 'in_lavorazione' : 'aperto';
  }
  return ticket.status;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'normale',
  status          TEXT NOT NULL DEFAULT 'aperto',
  requester_id    TEXT NOT NULL,
  requester_name  TEXT NOT NULL,
  assignee_id     TEXT,
  assignee_name   TEXT,
  channel_ts      TEXT,
  dm_channel      TEXT,
  dm_ts           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS tickets_requester ON tickets(requester_id);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_channel_ts ON tickets(channel_ts);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_dm ON tickets(dm_channel, dm_ts);

CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id    INTEGER NOT NULL REFERENCES tickets(id),
  side         TEXT NOT NULL,          -- agente | backoffice | sistema
  author_id    TEXT,
  author_name  TEXT NOT NULL,
  body         TEXT NOT NULL,
  internal     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_ticket ON comments(ticket_id);
`;

export class TicketStore {
  /** @param {string} path file SQLite, oppure ':memory:' nei test */
  constructor(path, now = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.now = () => now().toISOString();
  }

  create({ title, description = '', category, priority = 'normale', requesterId, requesterName }) {
    if (!title?.trim()) throw new Error('Il titolo e\' obbligatorio');
    if (!PRIORITIES[priority]) throw new Error(`Priorita' sconosciuta: ${priority}`);
    const at = this.now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO tickets (title, description, category, priority, requester_id, requester_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(title.trim(), description.trim(), category, priority, requesterId, requesterName, at, at);
    return this.get(Number(lastInsertRowid));
  }

  get(id) {
    return this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) ?? null;
  }

  byChannelThread(ts) {
    return this.db.prepare('SELECT * FROM tickets WHERE channel_ts = ?').get(ts) ?? null;
  }

  byDmThread(channel, ts) {
    return this.db.prepare('SELECT * FROM tickets WHERE dm_channel = ? AND dm_ts = ?').get(channel, ts) ?? null;
  }

  setSlackRefs(id, { channelTs, dmChannel, dmTs }) {
    this.db
      .prepare(
        `UPDATE tickets SET channel_ts = COALESCE(?, channel_ts), dm_channel = COALESCE(?, dm_channel),
         dm_ts = COALESCE(?, dm_ts) WHERE id = ?`,
      )
      .run(channelTs ?? null, dmChannel ?? null, dmTs ?? null, id);
    return this.get(id);
  }

  /** Cambia stato e lascia traccia nello storico. Restituisce null se lo stato e' gia' quello. */
  setStatus(id, status, actor) {
    if (!STATUSES[status]) throw new Error(`Stato sconosciuto: ${status}`);
    const ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket #${id} inesistente`);
    if (ticket.status === status) return null;
    const at = this.now();
    this.db
      .prepare('UPDATE tickets SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?')
      .run(status, at, status === 'risolto' ? at : null, id);
    this.#system(id, `${actor.name} ha portato il ticket da "${STATUSES[ticket.status].label}" a "${STATUSES[status].label}"`);
    return this.get(id);
  }

  assign(id, actor) {
    const ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket #${id} inesistente`);
    if (ticket.assignee_id === actor.id) return null;
    this.db
      .prepare('UPDATE tickets SET assignee_id = ?, assignee_name = ?, updated_at = ? WHERE id = ?')
      .run(actor.id, actor.name, this.now(), id);
    this.#system(id, `${actor.name} ha preso in carico il ticket`);
    return this.get(id);
  }

  /**
   * Registra una risposta arrivata da Slack e applica le regole di stato.
   * Chi del backoffice risponde a un ticket senza assegnatario se lo prende.
   */
  reply(id, { side, authorId, authorName, body, internal = false }) {
    let ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket #${id} inesistente`);
    this.db
      .prepare(
        `INSERT INTO comments (ticket_id, side, author_id, author_name, body, internal, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, side, authorId, authorName, body, internal ? 1 : 0, this.now());
    this.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(this.now(), id);

    const actor = { id: authorId, name: authorName };
    if (side === 'backoffice' && !internal && !ticket.assignee_id) this.assign(id, actor);
    const next = statusAfterReply(this.get(id), side, internal);
    const before = ticket.status;
    if (next !== before) this.setStatus(id, next, actor);
    ticket = this.get(id);
    return { ticket, statusChanged: next !== before };
  }

  comments(id) {
    return this.db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY id').all(id);
  }

  /** Ricerca per la dashboard e per /ticket miei. */
  list({ status, category, requesterId, q, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (status === 'aperti') {
      where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
      args.push(...OPEN_STATUSES);
    } else if (status) {
      where.push('status = ?');
      args.push(status);
    }
    if (category) where.push('category = ?'), args.push(category);
    if (requesterId) where.push('requester_id = ?'), args.push(requesterId);
    if (q) {
      where.push("(title LIKE ? OR description LIKE ? OR requester_name LIKE ? OR CAST(id AS TEXT) = ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, q.replace(/^#/, ''));
    }
    const sql = `SELECT * FROM tickets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE priority WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'normale' THEN 2 ELSE 3 END,
      created_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit);
  }

  /** Conteggi per stato, per l'intestazione della dashboard. */
  counts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all();
    return Object.fromEntries(Object.keys(STATUSES).map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0]));
  }

  #system(id, body) {
    this.db
      .prepare(`INSERT INTO comments (ticket_id, side, author_name, body, created_at) VALUES (?, 'sistema', 'Sistema', ?, ?)`)
      .run(id, body, this.now());
  }
}
