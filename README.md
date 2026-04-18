# api-dash

Real-time API spend dashboard across every AI provider you use. Runs locally on `localhost:3737`. No accounts, no cloud, no framework.

![dashboard](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

---

## What it does

- **Radial gauges** — spend vs budget per provider, at a glance
- **Live updates** — polls every 60 seconds via WebSocket
- **Spike alerts** — desktop notification when a provider's burn rate spikes above its baseline
- **Daily trend chart** — 7-day bar chart with running average
- **Drill-down** — click any tile for model breakdown, call count, cost per call
- **CSV import** — drop a GCP / AWS / Azure billing export onto a tile; auto-detects columns
- **SQLite tracking** — for providers with no billing API (Gemini, Venice, Modal), log spend locally and api-dash builds a tile from the database automatically
- **Co-pilot** — chat interface with direct access to your spend data; can also edit dashboard config inline

---

## Supported providers

| Provider | Source |
|----------|--------|
| Anthropic | Admin API (`cost_report` + `usage_report`) |
| OpenAI | Billing API (paginated) |
| fal.ai | Usage API + SQLite |
| ElevenLabs | Subscription API |
| Replicate | Predictions API |
| Venice | Balance API |
| Google Cloud / AWS / Azure | CSV billing export tile |
| Any provider | SQLite local logging (3 lines of code per call) |

---

## Setup

```bash
git clone https://github.com/questsystems-ai/api-dash.git
cd api-dash
npm install
cp .env.example .env.local   # fill in the keys for providers you use
npm start
```

Open `http://localhost:3737`. First launch asks for a data folder — pick anywhere (Dropbox/iCloud works great for multi-machine sync).

Only add keys for providers you actually use. Any key left blank just won't show a tile.

---

## Env vars

See `.env.example` for all options. The important ones:

```env
ANTHROPIC_ADMIN_KEY=   # Admin key from console.anthropic.com/settings/admin-keys
OPENAI_ADMIN_KEY=      # Admin key from platform.openai.com/settings/organization/admin-keys
FAL_KEY=
ELEVENLABS_API_KEY=
REPLICATE_API_TOKEN=
MONTHLY_BUDGET=100     # Total budget across all providers (default $100)
PORT=3737
```

---

## SQLite logging (for providers without billing APIs)

For any provider that doesn't expose a billing API, you can log spend locally. api-dash will find the database and build a tile automatically.

Point api-dash at your project folder (Add Repo button), and log calls like this:

```js
// After each API call — log provider, model, tokens, cost
db.run(
  `INSERT INTO api_usage (provider, model, input_units, output_units, cost)
   VALUES (?, ?, ?, ?, ?)`,
  [provider, model, inputTokens, outputTokens, cost]
);
```

Schema is created automatically on first launch. Works with any SQLite client (`better-sqlite3`, `sqlite3`, etc.).

---

## Architecture

Two files do everything:

- `server.js` — HTTP server, WebSocket broadcaster, all provider fetchers, SQLite
- `public/index.html` — radial gauge UI, charts, WebSocket client, co-pilot

No framework, no build step. Edit and restart.

---

## License

MIT
