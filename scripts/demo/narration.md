# api-dash — Narration Script
### Voice: Liam (Energetic, Social Media Creator) — fast, punchy, car-salesman energy
### Target: ~3 minutes total
### For ElevenLabs: [pause] = 0.5s beat, [pause long] = 1.2s beat

---

## SCENE 1 — Cold Open

You're burning money on AI every single day and you have NO idea how much. [pause] I didn't either. [pause long] Until I built this. This is api-dash — real-time spend tracking across every AI provider you use. [pause] Let me show you how fast you can get set up.

---

## SCENE 2 — First Launch: Data Folder Setup

First launch, one question: where do you want to store your data? [pause] Pick a folder. [pause] Pro tip — point it at your Dropbox or iCloud and your spend data syncs across every machine you work on automatically. [pause] Hit Let's go. Done.

---

## SCENE 3 — Dashboard Overview

Boom. [pause] Every AI provider — one tile each. [pause] Each gauge shows your spend vs your budget for the period. Green means you're good. Amber means watch it. Red means — yeah, we'll talk about that. [pause] Grand total top right. [pause] This refreshes every sixty seconds. Set it and forget it.

---

## SCENE 4 — Provider Tile Detail

Click any tile — boom, detail view. [pause] Model breakdown — which model is costing you the most, call count, average cost per call. [pause] Daily bar chart right underneath. You can see spikes at a glance. [pause] Click again to close. That simple.

---

## SCENE 5 — Time Period Selector

This week, this month, custom range. [pause] Switch it up here. [pause] Current month view projects where you'll land at month end based on your current burn rate. [pause] Very useful when you're getting close to budget.

---

## SCENE 6 — Import CSV Tile

Some providers — Google Cloud, AWS, Azure — no real-time API. [pause] But they all export a billing CSV. [pause] So we built a tile for that. Click Import CSV, name it, pick a color, create. [pause] Drop your billing export on the tile. [pause] api-dash auto-detects the columns — service names, costs, line items, all of it. [pause] Works with GCP, AWS Cost Explorer, Azure — same flow every time.

---

## SCENE 7 — Add Repo: SQLite Tracking

Now here's the good part. [pause] Gemini, Venice, Modal, WaveSpeed — no billing APIs at all. So how do you track them? [pause] SQLite. Local database in your project repo. Three lines of code per API call — log provider, model, cost, timestamp. [pause] Click Add Repo, point it at your project folder — api-dash finds the database and builds a tile automatically. [pause] No accounts. No cloud. Just a file.

---

## SCENE 8 — The Logging Snippet

Here's the snippet. [pause] After each API call, calculate cost from token counts, insert one row. Provider, model, input tokens, output tokens, cost. [pause] If you're already logging your calls — and you should be — this is literally two extra lines.

---

## SCENE 9 — Throttle and Spike Detection

This one saved me a four-figure invoice. [pause] api-dash watches your spend rate per provider. If today's cost is spiking way above yesterday's run rate — [pause] tile goes red, desktop notification fires. [pause] You catch the runaway loop before it cleans out your account. Acknowledge and continue, or go fix it. [pause] Ask me how I know this matters.

---

## SCENE 10 — Co-pilot

There's also a co-pilot — chat interface with direct access to your spend data. [pause] Ask it things like — which provider spiked this week, what's my Anthropic trend, what's my monthly forecast at this rate. [pause] It can also edit the dashboard directly. Change tile colors, add providers, update budgets — without touching the code yourself.

---

## SCENE 11 — Wrap Up

api-dash. [pause] Real-time spend across every AI provider. Local-first, no accounts required, runs in the background while you build. [pause] Link in the description. npm install, copy the env file, drop in your keys. [pause] You're up in five minutes. Go.

---

## ElevenLabs Notes

- **Voice:** Liam (`TX3LPaxmHKxFdv7VOQHJ`) — Energetic Social Media Creator
- **Stability:** 0.55, **Similarity:** 0.80, **Style:** 0.45
- **Speaking rate:** fast — this script is written for an energetic delivery pace

---

## Scene Timings (approximate)

| Scene | Duration |
|-------|----------|
| 1 — Cold open | 0:18 |
| 2 — First launch | 0:18 |
| 3 — Dashboard overview | 0:22 |
| 4 — Tile detail | 0:20 |
| 5 — Period selector | 0:15 |
| 6 — GCP CSV | 0:22 |
| 7 — Add Repo / SQLite | 0:22 |
| 8 — Logging snippet | 0:15 |
| 9 — Throttle / spikes | 0:20 |
| 10 — Co-pilot | 0:18 |
| 11 — Wrap up | 0:15 |
| **Total** | **~3:05** |
