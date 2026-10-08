import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  try {
    for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

const list = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

loadDotEnv();

export const config = {
  root,
  // Slack, Socket Mode: nessun URL pubblico da esporre
  botToken: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  // Canale dove il backoffice riceve e lavora i ticket (ID, es. C0123456)
  backofficeChannel: process.env.BACKOFFICE_CHANNEL,
  // Canale dove gli agenti scrivono le richieste: ogni messaggio diventa un ticket (ID, es. C0123456)
  assistenzaChannel: process.env.ASSISTENZA_CHANNEL || '',
  // Categoria dei ticket nati da #assistenza, finche' il backoffice non la cambia
  defaultCategory: process.env.DEFAULT_CATEGORY || 'Da classificare',
  // Chi puo' cambiare stato ai ticket. Vuoto = chiunque sia nel canale backoffice
  backofficeUsers: list('BACKOFFICE_USERS', []),
  categories: list('CATEGORIES', [
    'Contratti e mandati',
    'Pubblicazione annunci',
    'Documenti e visure',
    'Amministrazione e provvigioni',
    'IT e accessi',
    'Altro',
  ]),
  dbPath: resolve(root, process.env.DB_PATH || 'data/tickets.db'),
  // Dashboard web in sola lettura. Senza password non parte.
  dashboardPort: Number(process.env.DASHBOARD_PORT || 3000),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  // Es. https://gromia.slack.com — serve solo per il link al thread dalla dashboard
  workspaceUrl: process.env.SLACK_WORKSPACE_URL || '',
};

export function assertSlackConfig() {
  const missing = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'BACKOFFICE_CHANNEL'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Mancano in .env: ${missing.join(', ')} — vedi .env.example`);
  if (process.env.ASSISTENZA_CHANNEL && process.env.ASSISTENZA_CHANNEL === process.env.BACKOFFICE_CHANNEL) {
    throw new Error('ASSISTENZA_CHANNEL e BACKOFFICE_CHANNEL devono essere due canali diversi');
  }
}
