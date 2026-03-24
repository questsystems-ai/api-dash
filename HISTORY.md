# API Dash — Development History

## Origin

API Dash was born inside the `romantasy-v1` repo as an internal tool to track AI API spend across the Romantasy Illustrator project. The app uses Anthropic (Claude), Google (Gemini), OpenAI, fal.ai, ElevenLabs, Replicate, and Venice — and the monthly bills were opaque. We needed a single pane of glass.

## Timeline

### Phase 1: Next.js Dashboard Route (2026-03-23)
**Commit `abd0ae4` in romantasy-v1**

Built the first version as a Next.js page inside the Romantasy app:
- `app/api/dashboard/api-spend/route.ts` — 600+ line endpoint fetching billing from all providers
- `app/dashboard/page.tsx` — Cumulative spend chart with time range selector
- `lib/api-logger.ts` — Fire-and-forget usage logger for Claude, Gemini, TTS calls
- `supabase/migrations/0028_api_usage.sql` — `api_usage` table schema

Also built in the same session: cost simulation script proving 45% token savings with shorter Claude Code sessions, leading to the session budget discipline protocol.

### Phase 2: OpenAI Billing Bug Fix (2026-03-23)
**Commit `82abdeb` in romantasy-v1**

**Problem**: OpenAI spend was showing ~1% of actual value.
**Root cause**: Code divided `result.amount.value` by 100, assuming cents. OpenAI API returns USD directly.
**Fix**: Changed to `parseFloat(result.amount?.value || "0")` and added pagination — OpenAI returns multi-page results, and we were only reading page 1 (~20% of total spend).

### Phase 3: Standalone Extraction (2026-03-23)
**Commit `4b7423b` in romantasy-v1**

Realized the dashboard needs to run independently of the Next.js dev server. Extracted into a standalone Node app:
- `server.js` — Vanilla Node HTTP server + WebSocket for live updates
- `public/index.html` — Radial gauge UI with canvas rendering
- Runs on `localhost:3737`, polls every 60 seconds
- First attempt at Anthropic 429 retry logic

### Phase 4: Google Billing + Spend Chart (2026-03-23)
**Commit `168c966` in romantasy-v1**

- Added Google Cloud Billing API integration with JWT service account auth
- Added Supabase fallback: when billing APIs aren't available, query `api_usage` table
- Added fal.ai fallback: also queries `generations` table (has per-image cost data)
- Added daily spend trend chart with peak markers and 7-day running average
- Improved Anthropic retry: exponential backoff (3 attempts: 3s, 6s, 9s)

### Phase 5: Repo Extraction (2026-03-24)

Spun off as its own repo at `a-i-rons_projects/api-dash/`. The dashboard is meant to be an always-on desktop utility, not tied to any single project.

---

## Known Issues

### 1. Anthropic 429 Rate Limiting — Partially Solved
**Status**: Works most of the time, still fails intermittently.

The Anthropic `cost_report` endpoint is rate-limited. Current mitigation: exponential backoff with 3 retries (3s, 6s, 9s waits). This catches most transient 429s but persistent ones still fail silently.

**What's needed**:
- Jittered backoff (add randomness to avoid thundering herd on clock-aligned polls)
- Longer initial wait (5-10s) or configurable retry count
- Circuit breaker: after N consecutive failures, back off to 5-minute polling for that provider
- Consider caching last successful result and serving stale data with a "stale" indicator

### 2. Google Costs Showing $0 — Root Cause Known
**Status**: Broken. Dashboard shows $0 for Google.

**Root cause chain**:
1. Google Cloud Billing API requires a service account with `billing.accounts.getSpendInfo` permission. Most users won't have `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` configured.
2. Fallback path queries Supabase `api_usage` table — but this table has 0 rows for Google because:
   - `logGemini()` in `lib/api-logger.ts` (romantasy-v1) exists but many Gemini routes don't call it
   - Fire-and-forget pattern means logging failures are silent
   - The logger was in the romantasy app, not in api-dash — so api-dash has no way to populate usage data on its own

**What's needed**:
- Option A: Wire up Google Cloud Billing API properly (requires service account setup docs)
- Option B: Build a lightweight cost estimator based on model + token count (Gemini pricing is public)
- Option C: Add a manual entry UI for providers without billing APIs
- The Supabase `api_usage` table approach only works if every app using Google APIs logs to it

### 3. OpenAI Billing — Fixed
Parsing bug (cents vs USD) and missing pagination both fixed in Phase 2.

---

## Pending Features

### Must Have (for daily-driver use)
- [ ] **Add/remove gauges UI** — toggle which providers show, add custom providers
- [ ] **Persistent history** — store poll results to show trends over days/weeks (currently in-memory only, resets on restart)
- [ ] **Startup on boot** — system service / tray app so it runs continuously
- [ ] **Alert thresholds** — configurable per-provider spend alerts (email, desktop notification, or webhook)
- [ ] **Stale data indicator** — when a provider poll fails, show last known value with "stale" badge and timestamp

### Should Have
- [ ] **Multi-project awareness** — track spend per project/repo, not just per provider
- [ ] **Cost attribution** — correlate API calls with specific Claude Code sessions or features
- [ ] **Export** — CSV/JSON export of historical spend data
- [ ] **Provider health status** — show API latency, error rates, and rate limit headroom alongside spend

### Nice to Have
- [ ] **Budget forecasting** — project month-end spend based on current burn rate
- [ ] **Anomaly detection** — flag unusual spend spikes (e.g., runaway generation loop)
- [ ] **Mobile view** — responsive layout for checking spend from phone
- [ ] **Webhook integration** — POST spend data to Slack, Discord, or custom endpoints

---

## Architecture Decisions

**Why vanilla Node (no Express, no React)?**
- Zero dependencies beyond Supabase client, dotenv, ws, and jsonwebtoken
- Starts instantly, runs with minimal resources
- Single HTML file means no build step — edit and refresh
- The dashboard is a utility, not a product. Simplicity > polish.

**Why WebSocket instead of polling from the client?**
- Server already polls providers on a 60s interval
- WebSocket pushes to all connected tabs simultaneously
- No duplicate API calls if multiple tabs are open
- Enables future real-time alerting

**Why Supabase fallback?**
- Not all providers have billing APIs (or they're hard to auth)
- Apps that log usage to Supabase (like romantasy-v1) populate the `api_usage` table
- Dashboard can aggregate from both direct API and logged data
- Prevents double-counting by checking source overlap
