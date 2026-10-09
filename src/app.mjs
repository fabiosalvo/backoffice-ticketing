import bolt from '@slack/bolt';
import { assertSlackConfig, config } from './config.mjs';
import { createDesk } from './desk.mjs';
import { registerSlack } from './slack.mjs';
import { TicketStore } from './store.mjs';
import { startDashboard } from './web.mjs';

try {
  assertSlackConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const store = new TicketStore(config.dbPath);
const app = new bolt.App({ token: config.botToken, appToken: config.appToken, socketMode: true });
const desk = createDesk(store, config);
registerSlack(app, store, config, desk);

await app.start();
console.log(`Ticketing attivo su Slack · canale backoffice ${config.backofficeChannel} · db ${config.dbPath}`);

// Il server HTTP parte sempre: risponde a /health per l'hosting, e alla
// dashboard solo se c'e' una password.
startDashboard(store, config, { desk, client: app.client });
console.log(
  config.dashboardPassword
    ? `Dashboard su http://localhost:${config.dashboardPort}`
    : `Dashboard disattivata (manca DASHBOARD_PASSWORD) · /health su porta ${config.dashboardPort}`,
);
