# API Dash — Standalone API Spend Dashboard

## Startup Protocol
On every new conversation, run `/initiate` to load handoff, git state, memory, and verify Sonnet mode.

## What This Is
A standalone Node.js dashboard that monitors API spend across multiple AI providers in real-time. Runs on `localhost:3737` with radial gauges, WebSocket live updates, 60-second polling, and budget alerts. Designed to run continuously while you work.

## Stack
- Runtime: Node.js (vanilla — no framework)
- Server: Built-in `http` module + `ws` for WebSocket
- Database: Supabase (fallback cost source via `api_usage` table)
- Auth: JWT for Google Cloud Billing API
- Frontend: Single `public/index.html` (vanilla HTML/CSS/JS, radial gauge canvas)

## Architecture
Two files do everything:
- `server.js` — HTTP server, WebSocket broadcaster, provider billing API fetchers, Supabase fallback
- `public/index.html` — Radial gauge UI, daily spend chart, WebSocket client, budget alerts

## Supported Providers
| Provider | Data Source | Status |
|----------|-----------|--------|
| Anthropic | Admin API `cost_report` + `usage_report` | Working (429 intermittent) |
| OpenAI | Billing API (paginated) | Working |
| Google | Cloud Billing API → Supabase fallback | Broken ($0 — see HISTORY.md) |
| fal.ai | Usage API + Supabase `generations` table | Working |
| ElevenLabs | Subscription API | Working |
| Replicate | Predictions list API | Working |
| Venice | Balance API (stub) | Partial |

## Env Vars
See `.env.example` for all keys. Required: at least one provider's API key. Optional: `MONTHLY_BUDGET` (default $100), `PORT` (default 3737), Supabase credentials for fallback.

## Running
```bash
npm install
cp .env.example .env  # fill in your API keys
npm start             # http://localhost:3737
```

## Key Behaviors
- Polls all configured providers every 60 seconds
- WebSocket pushes updates to all connected clients
- Radial gauges show spend vs budget per provider
- Daily spend trend chart with 7-day running average
- Anthropic uses exponential backoff on 429 (3 attempts: 3s, 6s, 9s)
- Supabase fallback when billing APIs are unavailable or unconfigured

## Complexity Check (Self-Audit Rule)
After 2 failed attempts at the same problem: STOP. Diagnose what's tangled, propose a focused fix, and let the user decide.

## Git Workflow
- Push to `dev/wip` for in-progress work, `master` for stable releases
- Skip `.env` and `node_modules/` from commits
