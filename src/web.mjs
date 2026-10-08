// Dashboard web in sola lettura: la coda dei ticket e lo storico di ciascuno.
// Si lavora da Slack; qui si cerca, si filtra e si guarda l'insieme.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { formatDate } from './blocks.mjs';
import { PRIORITIES, STATUSES } from './store.mjs';

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Link al thread Slack, se e' noto l'indirizzo del workspace. */
export const slackLink = (workspaceUrl, channel, ts) =>
  workspaceUrl && channel && ts ? `${workspaceUrl.replace(/\/$/, '')}/archives/${channel}/p${ts.replace('.', '')}` : null;

function authorized(req, password) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':'));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const page = (title, body) => `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1d1d1b; --muted:#6b6b66; --line:#e4e4df; --accent:#2f5d50; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --card:#1f1f1d; --ink:#ececea; --muted:#9a9a94; --line:#33332f; --accent:#7fbfa9; } }
  body { margin:0; font:15px/1.45 system-ui,sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:1100px; margin:0 auto; padding:24px 16px; }
  a { color:var(--accent); }
  h1 { font-size:22px; margin:0 0 16px; }
  .counts { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  .counts a { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 12px; text-decoration:none; color:var(--ink); }
  .counts b { font-size:18px; margin-right:4px; }
  form { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
  input, select, button { font:inherit; padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); }
  .table { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .muted { color:var(--muted); font-size:13px; }
  .comment { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:8px 0; white-space:pre-wrap; }
  .comment.sistema { background:transparent; border-style:dashed; color:var(--muted); font-size:13px; }
  .comment.interna { border-left:4px solid #c9a227; }
  .comment.backoffice { border-left:4px solid var(--accent); }
</style></head><body><main>${body}</main></body></html>`;

function listPage(store, query) {
  const filter = { status: query.get('status') || 'aperti', category: query.get('category') || '', q: query.get('q') || '' };
  const tickets = store.list({ status: filter.status === 'tutti' ? undefined : filter.status, category: filter.category || undefined, q: filter.q || undefined });
  const counts = store.counts();
  const categories = [...new Set(store.list({ limit: 1000 }).map((t) => t.category))].sort();

  const opt = (value, label, current) => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const rows = tickets
    .map(
      (t) => `<tr>
        <td><a href="/t/${t.id}">#${t.id}</a></td>
        <td><a href="/t/${t.id}">${escapeHtml(t.title)}</a><div class="muted">${escapeHtml(t.category)}</div></td>
        <td>${STATUSES[t.status].emoji} ${STATUSES[t.status].label}</td>
        <td>${PRIORITIES[t.priority].emoji} ${PRIORITIES[t.priority].label}</td>
        <td>${escapeHtml(t.requester_name)}</td>
        <td>${escapeHtml(t.assignee_name ?? '—')}</td>
        <td class="muted">${formatDate(t.created_at)}</td>
      </tr>`,
    )
    .join('');

  return page(
    'Ticket backoffice',
    `<h1>Ticket backoffice</h1>
    <div class="counts">${Object.entries(STATUSES)
      .map(([k, s]) => `<a href="/?status=${k}"><b>${counts[k]}</b>${s.emoji} ${s.label}</a>`)
      .join('')}</div>
    <form>
      <select name="status">${opt('aperti', 'Tutti gli aperti', filter.status)}${Object.entries(STATUSES)
        .map(([k, s]) => opt(k, s.label, filter.status))
        .join('')}${opt('tutti', 'Tutti', filter.status)}</select>
      <select name="category">${opt('', 'Tutte le categorie', filter.category)}${categories.map((c) => opt(c, c, filter.category)).join('')}</select>
      <input name="q" placeholder="Cerca titolo, agente, #id" value="${escapeHtml(filter.q)}">
      <button>Filtra</button>
    </form>
    <div class="table"><table>
      <thead><tr><th>#</th><th>Richiesta</th><th>Stato</th><th>Priorita'</th><th>Agente</th><th>In carico a</th><th>Aperto</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">Nessun ticket con questi filtri.</td></tr>'}</tbody>
    </table></div>`,
  );
}

function detailPage(store, t, config) {
  const link = slackLink(config.workspaceUrl, config.backofficeChannel, t.channel_ts);
  const comments = store
    .comments(t.id)
    .map((c) => {
      const kind = c.side === 'sistema' ? 'sistema' : c.internal ? 'interna' : c.side;
      const who = c.side === 'sistema' ? '' : `<div class="muted">${escapeHtml(c.author_name)} · ${c.side}${c.internal ? ' · nota interna' : ''} · ${formatDate(c.created_at)}</div>`;
      return `<div class="comment ${kind}">${who}${escapeHtml(c.body)}${c.side === 'sistema' ? ` <span>· ${formatDate(c.created_at)}</span>` : ''}</div>`;
    })
    .join('');
  return page(
    `#${t.id} ${t.title}`,
    `<p><a href="/">← Tutti i ticket</a></p>
    <h1>#${t.id} · ${escapeHtml(t.title)}</h1>
    <p>${STATUSES[t.status].emoji} ${STATUSES[t.status].label} · ${PRIORITIES[t.priority].emoji} ${PRIORITIES[t.priority].label} · ${escapeHtml(t.category)}<br>
    <span class="muted">Aperto da ${escapeHtml(t.requester_name)} il ${formatDate(t.created_at)} · in carico a ${escapeHtml(t.assignee_name ?? '—')}${t.resolved_at ? ` · risolto il ${formatDate(t.resolved_at)}` : ''}</span>
    ${link ? `<br><a href="${escapeHtml(link)}">Apri il thread su Slack</a>` : ''}</p>
    ${t.description ? `<div class="comment">${escapeHtml(t.description)}</div>` : ''}
    <h2>Conversazione</h2>
    ${comments || '<p class="muted">Ancora nessuna risposta.</p>'}`,
  );
}

export function dashboardHandler(store, config) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return res.writeHead(200).end('ok');
    if (!authorized(req, config.dashboardPassword)) {
      return res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Ticket backoffice"' }).end('Accesso riservato');
    }
    const send = (status, html) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    if (req.method !== 'GET') return res.writeHead(405).end();
    if (url.pathname === '/') return send(200, listPage(store, url.searchParams));
    const m = url.pathname.match(/^\/t\/(\d+)$/);
    const t = m && store.get(Number(m[1]));
    if (t) return send(200, detailPage(store, t, config));
    return send(404, page('Non trovato', '<p>Ticket non trovato. <a href="/">Torna alla lista</a></p>'));
  };
}

export function startDashboard(store, config) {
  const server = createServer(dashboardHandler(store, config));
  server.listen(config.dashboardPort);
  return server;
}
