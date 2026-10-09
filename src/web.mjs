// Dashboard del backoffice, sul modello di Zendesk: le viste dei ticket a
// sinistra, e per ogni ticket la conversazione con il box di risposta
// (risposta pubblica o nota interna) e i pulsanti "Invia come …".
// Quello che si scrive qui arriva su Slack esattamente come una risposta data
// nel thread del canale: l'agente la riceve nel suo DM.

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { formatDate } from './blocks.mjs';
import { PRIORITIES, STATUSES } from './store.mjs';

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Link al thread Slack, se e' noto l'indirizzo del workspace. */
export const slackLink = (workspaceUrl, channel, ts) =>
  workspaceUrl && channel && ts ? `${workspaceUrl.replace(/\/$/, '')}/archives/${channel}/p${ts.replace('.', '')}` : null;

// Gli stati con cui si puo' chiudere un invio, nell'ordine dei pulsanti.
export const SUBMIT_STATUSES = ['in_lavorazione', 'in_attesa', 'risolto'];

const MAX_BODY = 64 * 1024;

function authorized(req, password) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':'));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Token anti-CSRF: deriva dalla password, quindi non e' indovinabile da un
// sito terzo e resta valido fra un riavvio e l'altro.
export const csrfToken = (password) => createHmac('sha256', password).update('csrf').digest('hex');

function sameOrigin(req) {
  const origin = req.headers.origin ?? req.headers.referer;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const cookies = (req) =>
  Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter(([k]) => k));

function readForm(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding?.('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) reject(Object.assign(new Error('Messaggio troppo lungo'), { status: 413 }));
    });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}

// --- Formattazione ------------------------------------------------------------

const romeDay = (d) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short' }).format(d);
const romeTime = (d) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(d);

/** "Oggi, 11:04" · "Ieri, 11:04" · data completa. */
export function friendlyDate(iso, now = new Date()) {
  const d = new Date(iso);
  if (romeDay(d) === romeDay(now)) return `Oggi, ${romeTime(d)}`;
  if (romeDay(d) === romeDay(new Date(now - 864e5))) return `Ieri, ${romeTime(d)}`;
  return formatDate(iso);
}

const AVATAR_COLORS = ['#d9467a', '#2f6fb3', '#2f8a5d', '#b26b1f', '#7a4fc0', '#2a8a96', '#b8443a'];

function avatar(name) {
  const initials = String(name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="avatar" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}">${escapeHtml(initials)}</span>`;
}

const badge = (status) => `<span class="badge s-${status}">${STATUSES[status].label}</span>`;

const page = (title, body) => `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#f8f9f9; --card:#fff; --ink:#2f3941; --muted:#68737d; --line:#d8dcde; --accent:#1f73b7;
          --note:#fff6d6; --note-line:#f5d16e; --nuovo:#ffb648; --aperto:#e34f32; --attesa:#3091ec; --risolto:#87929d; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14181b; --card:#1e2428; --ink:#e4e7e9; --muted:#9aa4ab; --line:#353d43;
          --accent:#5aa3e0; --note:#3a3420; --note-line:#8a7430; } }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--ink); }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  header.top { display:flex; align-items:center; gap:16px; padding:10px 16px; background:var(--card); border-bottom:1px solid var(--line); }
  header.top b { font-size:15px; }
  .wrap { display:grid; grid-template-columns:240px 1fr; min-height:calc(100vh - 45px); }
  aside { background:var(--card); border-right:1px solid var(--line); padding:16px; }
  aside h3 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0 0 8px; }
  aside nav a { display:flex; justify-content:space-between; padding:6px 8px; border-radius:6px; color:var(--ink); }
  aside nav a.on, aside nav a:hover { background:var(--bg); text-decoration:none; font-weight:600; }
  main { padding:20px 24px; min-width:0; }
  h1 { font-size:22px; margin:0 0 4px; }
  .muted { color:var(--muted); }
  .badge { display:inline-block; padding:1px 8px; border-radius:4px; font-size:12px; font-weight:600; color:#fff; }
  .s-aperto { background:var(--nuovo); color:#3a2a00; } .s-in_lavorazione { background:var(--aperto); }
  .s-in_attesa { background:var(--attesa); } .s-risolto { background:var(--risolto); }
  input, select, button, textarea { font:inherit; color:var(--ink); }
  input, select { padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); }
  .filters { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 12px; }
  .table { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; color:var(--muted); font-weight:600; }
  tr.row:hover { background:var(--bg); cursor:pointer; }
  .props dt { font-size:12px; color:var(--muted); margin-top:12px; } .props dd { margin:2px 0 0; }
  .ticket-head { display:flex; gap:12px; align-items:flex-start; margin-bottom:16px; }
  .avatar { flex:none; display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px;
            border-radius:50%; color:#fff; font-weight:700; font-size:14px; }
  .reply { background:var(--card); border:1px solid var(--line); border-radius:8px; margin-bottom:20px; }
  .reply input[type=radio] { position:absolute; opacity:0; pointer-events:none; }
  .reply .tabs { display:flex; border-bottom:1px solid var(--line); }
  .reply .tabs label { padding:10px 16px; cursor:pointer; border-bottom:3px solid transparent; color:var(--muted); }
  #k-pub:checked ~ .tabs label[for=k-pub] { border-color:var(--accent); color:var(--accent); font-weight:600; }
  #k-int:checked ~ .tabs label[for=k-int] { border-color:var(--note-line); color:var(--ink); font-weight:600; }
  .reply textarea { display:block; width:100%; min-height:140px; padding:12px 14px; border:0; resize:vertical; background:var(--card); }
  #k-int:checked ~ textarea { background:var(--note); }
  .reply .hint { display:none; padding:6px 14px; font-size:12px; color:var(--muted); background:var(--note); }
  #k-int:checked ~ .hint { display:block; }
  .reply .bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; padding:10px 12px; border-top:1px solid var(--line); }
  .reply .bar .as { margin-right:auto; display:flex; gap:6px; align-items:center; color:var(--muted); }
  .btn { padding:7px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); cursor:pointer; }
  .btn b { margin-left:2px; } .btn:hover { border-color:var(--accent); }
  .btn.primary { background:#1f2a33; color:#fff; border-color:#1f2a33; }
  @media (prefers-color-scheme: dark) { .btn.primary { background:#e4e7e9; color:#14181b; border-color:#e4e7e9; } }
  .views { display:flex; gap:16px; border-bottom:1px solid var(--line); margin-bottom:8px; }
  .views a { padding:8px 2px; color:var(--muted); border-bottom:3px solid transparent; }
  .views a.on { color:var(--ink); font-weight:600; border-color:var(--ink); text-decoration:none; }
  .count { display:inline-block; min-width:20px; padding:0 6px; margin-left:4px; border-radius:10px; font-size:12px; text-align:center;
           border:1px solid var(--line); }
  .views a.on .count { background:var(--ink); color:var(--card); border-color:var(--ink); }
  .msg { display:flex; gap:12px; padding:14px 0; border-bottom:1px solid var(--line); }
  .msg .who { margin-bottom:6px; } .msg .who b { margin-right:6px; }
  .msg .text { white-space:pre-wrap; overflow-wrap:anywhere; }
  .msg.interna .text { background:var(--note); border:1px solid var(--note-line); border-radius:6px; padding:10px 12px; }
  .tag { font-size:11px; padding:1px 6px; border-radius:4px; border:1px solid var(--line); color:var(--muted); margin-left:4px; }
  .event { padding:8px 0 8px 48px; font-size:12px; color:var(--muted); border-bottom:1px solid var(--line); }
  .solo { max-width:760px; margin:0 auto; }
  .member { display:flex; align-items:center; gap:12px; padding:10px 14px; border-bottom:1px solid var(--line); }
  .member:last-child { border-bottom:0; } .member form { margin-left:auto; }
  .add { display:flex; gap:8px; flex-wrap:wrap; margin:16px 0; }
  .flash { padding:10px 12px; border-radius:6px; margin-bottom:12px; background:#e8f4ea; color:#1d5b2f; }
  .flash.err { background:#fbe9e7; color:#8a2316; }
  @media (max-width:760px) { .wrap { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } main { padding:16px; } }
</style></head><body>
<header class="top"><b>Ticket backoffice</b><a href="/">Ticket</a><a href="/team">Team</a></header>
${body}
</body></html>`;

// --- Lista ---------------------------------------------------------------------

const VIEWS = [
  ['aperti', 'Da gestire'],
  ['aperto', STATUSES.aperto.label],
  ['in_lavorazione', STATUSES.in_lavorazione.label],
  ['in_attesa', STATUSES.in_attesa.label],
  ['risolto', STATUSES.risolto.label],
  ['tutti', 'Tutti'],
];

function viewsNav(store, current) {
  const counts = store.counts();
  const n = (v) => (v === 'aperti' ? counts.aperto + counts.in_lavorazione + counts.in_attesa : v === 'tutti' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[v]);
  return `<aside><h3>Viste</h3><nav>${VIEWS.map(
    ([v, label]) => `<a href="/?status=${v}"${v === current ? ' class="on"' : ''}><span>${escapeHtml(label)}</span><span class="muted">${n(v)}</span></a>`,
  ).join('')}</nav></aside>`;
}

function listPage(store, query) {
  const filter = { status: query.get('status') || 'aperti', category: query.get('category') || '', q: query.get('q') || '' };
  const tickets = store.list({ status: filter.status === 'tutti' ? undefined : filter.status, category: filter.category || undefined, q: filter.q || undefined });
  const categories = [...new Set(store.list({ limit: 1000 }).map((t) => t.category))].sort();
  const opt = (value, label, current) => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const title = VIEWS.find(([v]) => v === filter.status)?.[1] ?? 'Ticket';

  const rows = tickets
    .map(
      (t) => `<tr class="row" onclick="location.href='/t/${t.id}'">
        <td>${badge(t.status)}</td>
        <td><a href="/t/${t.id}">${escapeHtml(t.title)}</a><div class="muted">#${t.id} · ${escapeHtml(t.category)}</div></td>
        <td>${PRIORITIES[t.priority].emoji} ${PRIORITIES[t.priority].label}</td>
        <td>${escapeHtml(t.requester_name)}</td>
        <td>${escapeHtml(t.assignee_name ?? '—')}</td>
        <td class="muted">${friendlyDate(t.updated_at)}</td>
      </tr>`,
    )
    .join('');

  return page(
    'Ticket backoffice',
    `<div class="wrap">${viewsNav(store, filter.status)}<main>
    <h1>${escapeHtml(title)} <span class="muted" style="font-size:15px;font-weight:400">${tickets.length} ticket</span></h1>
    <form class="filters">
      <input type="hidden" name="status" value="${escapeHtml(filter.status)}">
      <select name="category" onchange="this.form.submit()">${opt('', 'Tutte le categorie', filter.category)}${categories.map((c) => opt(c, c, filter.category)).join('')}</select>
      <input name="q" placeholder="Cerca titolo, agente, #id" value="${escapeHtml(filter.q)}">
    </form>
    <div class="table"><table>
      <thead><tr><th>Stato</th><th>Oggetto</th><th>Priorita'</th><th>Richiedente</th><th>Assegnatario</th><th>Aggiornato</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">Nessun ticket in questa vista.</td></tr>'}</tbody>
    </table></div></main></div>`,
  );
}

// --- Ticket --------------------------------------------------------------------

function conversation(store, t, vista) {
  const comments = store.comments(t.id);
  const internals = comments.filter((c) => c.internal).length;
  const shown = vista === 'interne' ? comments.filter((c) => c.internal) : comments;

  // La richiesta iniziale e' il primo messaggio, come in Zendesk.
  const opening = { side: 'agente', author_name: t.requester_name, body: t.description || t.title, created_at: t.created_at, internal: 0 };
  const items = [...(vista === 'interne' ? [] : [opening]), ...shown].reverse();

  const html = items
    .map((c) => {
      if (c.side === 'sistema') return `<div class="event">${escapeHtml(c.body)} · ${friendlyDate(c.created_at)}</div>`;
      const tag = c.internal ? '<span class="tag">Nota interna</span>' : c.side === 'agente' ? '<span class="tag">Agente</span>' : '<span class="tag">Backoffice</span>';
      return `<div class="msg${c.internal ? ' interna' : ''}">${avatar(c.author_name)}<div style="min-width:0;flex:1">
        <div class="who"><b>${escapeHtml(c.author_name)}</b><span class="muted">${friendlyDate(c.created_at)}</span>${tag}</div>
        <div class="text">${escapeHtml(c.body)}</div></div></div>`;
    })
    .join('');

  return `<div class="views">
      <a href="/t/${t.id}"${vista !== 'interne' ? ' class="on"' : ''}>Tutte<span class="count">${comments.filter((c) => c.side !== 'sistema').length + 1}</span></a>
      <a href="/t/${t.id}?vista=interne"${vista === 'interne' ? ' class="on"' : ''}>Interne<span class="count">${internals}</span></a>
    </div>${html || '<p class="muted">Nessuna nota interna.</p>'}`;
}

function replyBox(t, operators, current, csrf) {
  // Finche' il browser non sa chi sei, nessuno e' preselezionato: meglio
  // chiedere che rispondere a nome di un collega.
  const known = operators.some((o) => o.id === current);
  const options = operators.length
    ? (known ? '' : '<option value="" selected disabled>Scegli…</option>') +
      operators.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === current ? ' selected' : ''}>${escapeHtml(o.name)}</option>`).join('')
    : '<option value="">— nessun operatore —</option>';
  const buttons = SUBMIT_STATUSES.map(
    (s) => `<button class="btn${s === 'risolto' ? ' primary' : ''}" name="status" value="${s}">Invia come <b>${STATUSES[s].label}</b></button>`,
  ).join('');
  return `<form class="reply" method="post" action="/t/${t.id}/reply">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="radio" name="kind" value="pubblica" id="k-pub" checked>
    <input type="radio" name="kind" value="interna" id="k-int">
    <div class="tabs"><label for="k-pub">Risposta pubblica</label><label for="k-int">Nota interna</label></div>
    <div class="hint">La nota interna resta al backoffice: all'agente non arriva.</div>
    <textarea name="body" placeholder="Scrivi la risposta per ${escapeHtml(t.requester_name)}…"></textarea>
    <div class="bar">
      <label class="as">Rispondi come <select name="operator" required>${options}</select></label>
      ${buttons}
    </div>
  </form>`;
}

function ticketPage(store, t, config, { operators, operator, vista, flash }) {
  const link = slackLink(config.workspaceUrl, config.backofficeChannel, t.channel_ts);
  const props = `<aside><dl class="props">
      <dt>Richiedente</dt><dd>${escapeHtml(t.requester_name)}</dd>
      <dt>Assegnatario</dt><dd>${escapeHtml(t.assignee_name ?? '—')}</dd>
      <dt>Stato</dt><dd>${badge(t.status)}</dd>
      <dt>Priorita'</dt><dd>${PRIORITIES[t.priority].emoji} ${PRIORITIES[t.priority].label}</dd>
      <dt>Categoria</dt><dd>${escapeHtml(t.category)}</dd>
      <dt>Aperto il</dt><dd>${formatDate(t.created_at)}</dd>
      ${t.resolved_at ? `<dt>Risolto il</dt><dd>${formatDate(t.resolved_at)}</dd>` : ''}
      ${link ? `<dt>Slack</dt><dd><a href="${escapeHtml(link)}">Apri il thread</a></dd>` : ''}
    </dl></aside>`;
  const flashHtml = flash ? `<div class="flash${flash.error ? ' err' : ''}">${escapeHtml(flash.text)}</div>` : '';
  return page(
    `#${t.id} ${t.title}`,
    `<div class="wrap">${props}<main>
      ${flashHtml}
      <div class="ticket-head">${avatar(t.requester_name)}<div>
        <h1>${escapeHtml(t.title)}</h1>
        <div class="muted">#${t.id} · ${friendlyDate(t.created_at)} · ${escapeHtml(t.requester_name)} · da Slack</div>
      </div></div>
      ${replyBox(t, operators, operator, csrfToken(config.dashboardPassword))}
      ${conversation(store, t, vista)}
    </main></div>`,
  );
}

// --- Team ----------------------------------------------------------------------

function teamPage(store, people, csrf, flash) {
  const team = store.team();
  const byId = new Map(people.map((p) => [p.id, p]));
  const members = team
    .map((m) => {
      const name = byId.get(m.user_id)?.name ?? m.name;
      return `<div class="member">${avatar(name)}<div><b>${escapeHtml(name)}</b><div class="muted">nel team dal ${formatDate(m.added_at)}</div></div>
        <form method="post" action="/team"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="user" value="${escapeHtml(m.user_id)}">
        <button class="btn" name="action" value="remove">Rimuovi</button></form></div>`;
    })
    .join('');
  const candidates = people.filter((p) => !store.inTeam(p.id));
  const flashHtml = flash ? `<div class="flash${flash.error ? ' err' : ''}">${escapeHtml(flash.text)}</div>` : '';
  return page(
    'Team del backoffice',
    `<main class="solo">${flashHtml}
      <h1>Team del backoffice</h1>
      <p class="muted">Le persone del team rispondono ai ticket dalla dashboard e ne cambiano lo stato, anche dai pulsanti su Slack.
      Gli altri possono aprire ticket ma non gestirli.</p>
      ${team.length ? '' : '<div class="flash err">Il team è vuoto: finché non aggiungi qualcuno, chiunque nel workspace può rispondere e cambiare stato.</div>'}
      <form class="add" method="post" action="/team">
        <input type="hidden" name="csrf" value="${csrf}">
        <select name="user" required><option value="" selected disabled>Scegli una persona…</option>${candidates
          .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
          .join('')}</select>
        <button class="btn primary" name="action" value="add">Aggiungi al team</button>
      </form>
      <div class="table">${members || '<div class="member muted">Nessuno nel team.</div>'}</div>
    </main>`,
  );
}

const TEAM_FLASHES = {
  aggiunto: { text: 'Aggiunto al team.' },
  rimosso: { text: 'Rimosso dal team.' },
};

const FLASHES = {
  inviato: { text: 'Risposta inviata: l\'agente la riceve su Slack.' },
  nota: { text: 'Nota interna salvata.' },
  stato: { text: 'Stato aggiornato.' },
  vuoto: { text: 'Scrivi un messaggio o scegli uno stato diverso da quello attuale.', error: true },
  operatore: { text: 'Scegli chi sta rispondendo.', error: true },
};

// --- Server --------------------------------------------------------------------

/**
 * @param desk  le operazioni sui ticket (createDesk); senza, la dashboard e' in sola lettura
 * @param client il client Slack con cui il desk scrive
 */
export function dashboardHandler(store, config, { desk, client } = {}) {
  const operatorsOf = async () => (desk ? desk.operators(client).catch(() => []) : []);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return res.writeHead(200).end('ok');
    // Senza password il server risponde solo al controllo di salute dell'hosting
    if (!config.dashboardPassword) return res.writeHead(404).end('Dashboard disattivata');
    if (!authorized(req, config.dashboardPassword)) {
      return res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Ticket backoffice"' }).end('Accesso riservato');
    }
    const send = (status, html) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    const notFound = () => send(404, page('Non trovato', '<main><p>Ticket non trovato. <a href="/">Torna alla lista</a></p></main>'));

    const reply = url.pathname.match(/^\/t\/(\d+)\/reply$/);
    if (reply && req.method === 'POST') {
      const t = store.get(Number(reply[1]));
      if (!t) return notFound();
      const form = await readForm(req);
      if (!sameOrigin(req) || form.get('csrf') !== csrfToken(config.dashboardPassword)) return res.writeHead(403).end('Richiesta non valida');
      if (!desk) return res.writeHead(503).end('Dashboard in sola lettura');

      const back = (flash) => res.writeHead(303, { Location: `/t/${t.id}?ok=${flash}` }).end();
      const operator = (await operatorsOf()).find((o) => o.id === form.get('operator'));
      if (!operator) return back('operatore');
      res.setHeader('Set-Cookie', `operator=${encodeURIComponent(operator.id)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);

      const body = (form.get('body') ?? '').trim();
      const internal = form.get('kind') === 'interna';
      const status = SUBMIT_STATUSES.includes(form.get('status')) ? form.get('status') : undefined;
      if (!body && (!status || status === t.status)) return back('vuoto');
      await desk.backofficeReply(client, t.id, operator, { body, internal, status });
      return back(body ? (internal ? 'nota' : 'inviato') : 'stato');
    }

    if (url.pathname === '/team' && req.method === 'POST') {
      const form = await readForm(req);
      if (!sameOrigin(req) || form.get('csrf') !== csrfToken(config.dashboardPassword)) return res.writeHead(403).end('Richiesta non valida');
      if (!desk) return res.writeHead(503).end('Dashboard in sola lettura');
      const user = form.get('user') ?? '';
      if (form.get('action') === 'add') {
        await desk.addToTeam(client, user);
        return res.writeHead(303, { Location: '/team?ok=aggiunto' }).end();
      }
      if (form.get('action') === 'remove') {
        desk.removeFromTeam(user);
        return res.writeHead(303, { Location: '/team?ok=rimosso' }).end();
      }
      return res.writeHead(400).end('Azione sconosciuta');
    }

    if (req.method !== 'GET') return res.writeHead(405).end();
    if (url.pathname === '/team') {
      const people = desk ? await desk.people(client).catch(() => []) : [];
      return send(200, teamPage(store, people, csrfToken(config.dashboardPassword), TEAM_FLASHES[url.searchParams.get('ok')]));
    }
    if (url.pathname === '/') return send(200, listPage(store, url.searchParams));
    const m = url.pathname.match(/^\/t\/(\d+)$/);
    const t = m && store.get(Number(m[1]));
    if (!t) return notFound();
    return send(
      200,
      ticketPage(store, t, config, {
        operators: await operatorsOf(),
        operator: cookies(req).operator,
        vista: url.searchParams.get('vista'),
        flash: FLASHES[url.searchParams.get('ok')],
      }),
    );
  }

  return (req, res) =>
    handle(req, res).catch((err) => {
      console.error('Dashboard:', err);
      if (!res.headersSent) res.writeHead(err.status ?? 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.status ? err.message : 'Errore interno');
    });
}

export function startDashboard(store, config, deps) {
  const server = createServer(dashboardHandler(store, config, deps));
  server.listen(config.dashboardPort);
  return server;
}
