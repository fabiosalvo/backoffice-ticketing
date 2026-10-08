import bolt from '@slack/bolt';
import { assertSlackConfig, config } from './config.mjs';
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
registerSlack(app, store, config);

await app.start();
console.log(`Ticketing attivo su Slack · canale backoffice ${config.backofficeChannel} · db ${config.dbPath}`);

if (config.dashboardPassword) {
  startDashboard(store, config);
  console.log(`Dashboard su http://localhost:${config.dashboardPort}`);
} else {
  console.log('Dashboard disattivata: imposta DASHBOARD_PASSWORD per accenderla');
}
