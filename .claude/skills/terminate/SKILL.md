---
name: terminate
description: End-of-session — generate handoff report, suggest commit, and wrap up
user-invocable: true
---

## Session Termination Procedure

The user is ending this session. Generate a handoff report so the next session can pick up instantly.

### Step 0: Commit check (do this FIRST)

Run `git status` and `git diff --stat`. If there are uncommitted changes:

⚠️ **Stop and tell the user before proceeding.** Uncommitted work forces the next session to spend tokens reconstructing state from diffs instead of reading clean commit history. That exploration costs real money.

Suggest a commit message covering the session's work and ask the user to commit before you continue with the handoff. Only proceed to Step 1 after the user responds (commit, skip, or defer).

### Step 1: Gather state

Run these in parallel:
- `git status` and `git diff --stat` — find uncommitted work
- `git log --oneline -5` — recent commits

### Step 2: Write the handoff report

Before writing, read `scripts/output/session-log.md` (last 150 lines) to capture any concepts/decisions logged mid-session. Incorporate these into the handoff — this ensures crash recovery in the next session even if the log is all that survived.

Write to `scripts/output/session-handoff.md` (create the directory if needed). Keep it under 80 lines. Include:

1. **The Product** — one paragraph: what this app/service does, who it's for
2. **Stack** — one line: framework, language, DB, key APIs/services
3. **Business Context** — one line: who's building it, what stage, what's the goal
4. **Current State** — today's date, current branch, what just got done this session, what's pending/blocked
5. **Key files** — only files the next session will definitely need to touch
6. **Quick verify** — a shell snippet to confirm the app runs and recent work is intact

Do NOT include: full architecture docs, file trees, API specs, or anything already in CLAUDE.md or memory files. The goal is minimal context that gets a fresh session productive in 30 seconds.

### Step 3: Update memory if needed

If anything happened this session that future sessions should know about (feedback, corrections, project decisions), save it to the appropriate memory file. Don't duplicate what's already in memory.

### Step 4: Confirm clean state

If the user committed in Step 0, verify with `git status` that the working tree is clean. If they skipped, note the uncommitted files in the handoff report under a `## ⚠️ Uncommitted work` section so the next session knows to deal with it immediately.

### Step 5: Sign off

Output a brief summary:
```
## Session Complete

**Committed:** [yes/no — commit hash if yes]
**Handoff:** scripts/output/session-handoff.md
**Key takeaway:** [one sentence — what was accomplished or decided]

Ready to close. Next session: run `/initiate` to pick up where we left off.
```
