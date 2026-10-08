# Ticket Backoffice

Un helpdesk minimo, alla Zendesk, per le richieste degli agenti al backoffice.
Si usa tutto da Slack: l'agente scrive `/` e sceglie **Nuovo ticket**, il backoffice la
lavora in un canale, e le risposte vanno avanti e indietro senza che nessuno
debba cercare l'altro in privato. Una dashboard web in sola lettura dà la vista
d'insieme.

## Come funziona

```
 Agente                          App                         #backoffice-ticket
 ──────                          ───                         ──────────────────
 "/" ────► modulo ──────────►  ticket #42  ─────────────►  scheda #42 + pulsanti
                                     │                          │
 DM: scheda #42  ◄───────────────────┘                          │
   └ thread  ◄────── inoltro a nome di Luca ◄──────────── thread │ "Te la mando entro sera"
   └ thread "Allego planimetria" ──── inoltro ─────────────────► thread
```

Ogni ticket vive in **due thread**: sotto la scheda nel canale backoffice e
sotto la scheda nel DM fra l'app e l'agente. Quello che si scrive in uno compare
nell'altro, a nome di chi l'ha scritto, allegati compresi (come link).

**Privacy.** Una richiesta la vedono solo l'agente che l'ha aperta e il canale
del backoffice. La scorciatoia `/` (e il comando `/ticket`) non lascia traccia nel canale in cui viene
digitato, il modulo è personale, e tutta la conversazione con l'agente avviene
nel suo DM con l'app. Non esiste un canale condiviso fra agenti.

**Per l'agente**

| Cosa | Come |
| ---- | ---- |
| Aprire una richiesta | scrivere `/` in un campo messaggio e scegliere **Nuovo ticket** |
| …oppure col comando | `/ticket` (oppure `/ticket oggetto` per precompilare) |
| Rispondere al backoffice | nel thread del ticket, nel DM con l'app |
| Vedere le proprie richieste aperte | `/ticket miei` |

**Per il backoffice**, nel canale:

- **Prendi in carico** · **In attesa dell'agente** · **Risolvi** · **Riapri**: i
  pulsanti sulla scheda. L'agente riceve ogni cambio nel suo thread.
- Rispondere nel thread della scheda scrive all'agente.
- Un messaggio che inizia con `nota:` è una **nota interna**: resta nel ticket e
  nel canale, all'agente non arriva.

### Stati

```
 aperto ──► in lavorazione ──► in attesa dell'agente ──► risolto
    ▲             ▲                     │                  │
    └─────────────┴──── l'agente risponde ◄────────────────┘
```

Le regole automatiche sono due, quelle di ogni helpdesk:

1. Il primo del backoffice che risponde a un ticket **aperto** se lo prende in
   carico e lo porta **in lavorazione**.
2. Se l'agente risponde a un ticket **in attesa** o **risolto**, il ticket torna
   in coda (in lavorazione se ha già un assegnatario, altrimenti aperto). Una
   risposta non resta mai sepolta in un ticket chiuso.

Le note interne non spostano nulla. Ogni cambio di stato resta nello storico.

### Dashboard

Con `DASHBOARD_PASSWORD` impostata, su `http://localhost:3000`: conteggi per
stato, lista filtrabile per stato, categoria e testo (o `#42`), urgenti in cima,
e per ogni ticket l'intera conversazione con note interne e storico. È in sola
lettura: il lavoro si fa su Slack, così c'è un posto solo dove le cose
succedono. Accesso con Basic Auth (utente qualsiasi, la password è quella).

## Setup

### 1. App Slack (5 minuti, una volta)

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** →
   scegli il workspace → incolla `slack-manifest.yml`.
2. **Basic Information → App-Level Tokens → Generate**, scope
   `connections:write`: è lo `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** → installa: il **Bot User OAuth Token** è lo
   `SLACK_BOT_TOKEN` (`xoxb-…`).
4. Crea il canale del backoffice (es. `#backoffice-ticket`) e invitaci l'app:
   `/invite @Ticket Backoffice`. Il suo ID (`C…`) va in `BACKOFFICE_CHANNEL`.

L'app usa **Socket Mode**: si collega lei a Slack, quindi non serve un URL
pubblico, un dominio o un certificato. Basta una macchina sempre accesa.

### 2. Avvio

```bash
npm install
cp .env.example .env    # e compila i token e il canale
npm start
npm test                # 25 test, nessun workspace necessario
```

Serve Node 22.13 o successivo: il database è SQLite integrato in Node
(`node:sqlite`), nessun servizio da installare. I dati stanno in
`data/tickets.db` — è l'unico file da salvare nei backup.

### In produzione su Railway

Il repository è già pronto (`railway.json`): build, avvio, controllo di salute
su `/health`, riavvio automatico, una sola istanza.

1. <https://railway.com> → **New Project** → **Deploy from GitHub repo** →
   `fabiosalvo/backoffice-ticketing`. Al primo giro il servizio va in errore
   perché mancano le variabili: è normale.
2. Nel servizio → **Settings → Volumes** (o tasto destro → *Attach volume*):
   mount path `/data`. Qui vive il database; senza volume, a ogni rilascio i
   ticket andrebbero persi.
3. **Variables** → *Raw Editor* → incolla e completa:

   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   BACKOFFICE_CHANNEL=C06PTFAS9V1
   DB_PATH=/data/tickets.db
   DASHBOARD_PASSWORD=
   ```

   `C06PTFAS9V1` è **#helpdesk**. `DASHBOARD_PASSWORD`: una password lunga a
   scelta; vuota, la dashboard resta spenta.
4. Il servizio si rilancia da solo. Nei log deve comparire
   `Ticketing attivo su Slack`.
5. Per la dashboard: **Settings → Networking → Generate Domain**. Si apre con
   la password scelta (il nome utente è indifferente).
6. Su Slack, in **#helpdesk**: `/invite @Ticket Backoffice`.

Ogni merge su `main` viene rilasciato in automatico. Il database è l'unico
dato da proteggere: Railway fa i backup dei volumi da **Volume → Backups**.

Resta **una sola istanza** (`numReplicas: 1`): il database è un file sul volume
e non si condivide fra più copie del servizio.

## Configurazione

| Variabile | Default | Cosa fa |
| --------- | ------- | ------- |
| `SLACK_BOT_TOKEN` | — | Token bot `xoxb-` |
| `SLACK_APP_TOKEN` | — | Token app `xapp-` per Socket Mode |
| `BACKOFFICE_CHANNEL` | — | ID del canale dove arrivano i ticket |
| `BACKOFFICE_USERS` | tutti | ID Slack di chi può usare i pulsanti di stato |
| `CATEGORIES` | 6 categorie | Voci del menu *Categoria*, separate da virgola |
| `DASHBOARD_PASSWORD` | spenta | Accende la dashboard |
| `DASHBOARD_PORT` | 3000 | Porta della dashboard |
| `SLACK_WORKSPACE_URL` | — | Per il link al thread Slack dalla dashboard |
| `DB_PATH` | `data/tickets.db` | File del database |

## Struttura

| File | Ruolo |
| ---- | ----- |
| `src/store.mjs` | Ticket, risposte, stati e regole. Non sa nulla di Slack. |
| `src/blocks.mjs` | Modale e schede Slack (Block Kit), funzioni pure |
| `src/slack.mjs` | Comando, pulsanti, inoltro fra i due thread |
| `src/web.mjs` | Dashboard |
| `src/app.mjs` | Avvio |

## Fuori da questa prima versione

Deliberatamente lasciati fuori per restare semplici, e facili da aggiungere
quando servono:

- **SLA e solleciti**: un promemoria nel canale per i ticket aperti da più di N
  ore senza assegnatario.
- **Assegnazione a un collega** dal menu della scheda (oggi ci si prende in
  carico da sé).
- **Risposte pronte** (macro) per le richieste ricorrenti.
- **Login Slack sulla dashboard** al posto della password condivisa.
- **Triage con AI**: categoria e priorità suggerite dal testo, e una bozza di
  risposta per il backoffice sulle richieste frequenti.
