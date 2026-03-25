---
## Session started: 2026-03-24
Handoff found: no (first session with continuity system)
Session log recovered: no
---

[SESSION] [CONCEPT] "Tracked Repos" — point to parent folder, scan subdirs for Supabase creds, auto-discover providers from api_usage table, one tile per provider

[SESSION] [CONCEPT] Native OS folder picker via child_process.exec (PowerShell on Windows, osascript on Mac, zenity on Linux)

[SESSION] [CONCEPT] SUPABASE_SKIP set — excludes anthropic, openai, fal, elevenlabs, replicate from per-repo tile discovery (already have dedicated billing API tiles)

[SESSION] [CONCEPT] SUPABASE_PROVIDER_META — maps provider strings to display label + color for auto-discovered tiles

[SESSION] [CONCEPT] Co-pilot edit blocks — LLM outputs ```edit blocks with FILE/FIND/REPLACE; UI renders Apply buttons; auto-backup on first edit; /api/file/reset restores

[SESSION] [DECISION] "Add Google Project" → "Add Repo" rename throughout UI and code

[SESSION] [DECISION] Tile IDs use pattern `gp_${slug}_${provider}` — DELETE clears all matching `gp_${slug}*`

[SESSION] [CONCEPT] Supabase new key system: sb_publishable_... (replaces anon), sb_secret_... (replaces service_role) — asymmetric JWT, can't regenerate old format

[SESSION] [CONCEPT] ROMANTASY_LOGGING.md — pricing constants + logging snippets for all Romantasy providers (Anthropic, OpenAI, Venice, WaveSpeed, Akool, PiAPI, Modal)

[SESSION] [NOTE] Security incident: google-projects.json accidentally committed with Supabase service role key. Fixed via git amend + force push. Key rotated. File now gitignored.

[SESSION] [CONCEPT] Session continuity system ported from presentaHTML: memory init check in /initiate, mid-session logging protocol, session-log.md crash recovery

[SESSION] [FEEDBACK] User needs memory initialized BEFORE first terminate — empty memory dir causes "found no memories" failure on next session start

[SESSION] [CONCEPT] Document Picture-in-Picture API — proposed for floating dockable window; deferred

[SESSION] [GOAL] launch.py — entry point: check for LLM key → start server → open browser (not yet built)

[SESSION] [GOAL] Onboarding flow: co-pilot guided first-boot (scan repo → billing keys → Supabase migrations)
