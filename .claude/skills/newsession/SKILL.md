---
name: newsession
description: Terminate current session, spawn fresh terminal with claude, ready to go
user-invocable: true
---

## New Session — Terminate & Restart

This is a pushbutton session swap. Run terminate, then spawn a fresh Claude Code instance.

### Step 1: Run the full terminate procedure

Do everything from the `/terminate` skill:
1. Gather state (`git status`, `git diff --stat`, `git log --oneline -5`)
2. Check for uncommitted changes — if any, ask the user if they want to commit first
3. Write the handoff report to `scripts/output/session-handoff.md`
4. Update memory if anything changed this session
5. Show the "Session Complete" summary

### Step 2: Tell the user to start fresh

Output:
```
## Session Complete

Handoff written. To start fresh:
1. Open a new terminal (Ctrl+Shift+` in VS Code)
2. Type: claude
3. Close this tab

The new session will auto-initiate via CLAUDE.md.
```

IMPORTANT: Do NOT skip the terminate steps. The handoff report is what makes the new session instant.
