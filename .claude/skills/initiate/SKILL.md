---
name: initiate
description: Session startup — read handoff, check git state, orient on what's next
user-invocable: true
---

## Session Initiation Procedure

You are starting a new session. Run through these steps IN ORDER to get fully oriented, then present a concise briefing to the user.

### Step 1: Initialize memory if needed

Check if the memory index exists at `C:\Users\aaron\.claude\projects\C--Users-aaron-Documents-a-i-rons-projects-api-dash\memory\MEMORY.md`.

If it does NOT exist, create it now:

```markdown
# Memory Index

No memories saved yet.
```

This prevents the "found no memories" failure on first run.

### Step 2: Read the handoff report

Check if `scripts/output/session-handoff.md` exists. If it does, read it FIRST — this is the most direct summary from the previous session.

If the handoff does NOT exist (crash or first session), check `scripts/output/session-log.md` instead — this is the running mid-session log and may contain concepts/decisions from a crashed session. Read the last 100 lines if it exists.

### Step 3: Check uncommitted changes

Run `git status` and `git diff --stat`.

Identify:
- Modified files (what areas of the codebase were touched)
- Untracked files (new features/files added)
- Staged vs unstaged changes

If there are changes beyond what the handoff report describes, note them — they may represent work done after the report was written.

### Step 4: Recent commits

Run `git log --oneline -10`.

Summarize what the last few commits accomplished. Note the gap between committed work and uncommitted work.

### Step 5: Check memory

Read the memory index and scan for any memories that seem relevant to what's pending. Read the most important ones (especially feedback and project memories). Don't read all files — just the ones that matter for what's next.

### Step 6: Start session log

Append a session-start marker to `scripts/output/session-log.md` (create it if it doesn't exist):

```
---
## Session started: [today's date + time]
Handoff found: [yes/no]
Session log recovered: [yes/no — did we read prior log for crash recovery?]
---
```

### Step 7: Verify cost-aware mode

Check that you are running as **Sonnet** (not Opus). If you detect you are Opus, warn the user immediately:

```
⚠️ COST WARNING: This session is running on Opus. For cost efficiency, restart with Sonnet selected.
Opus should only be used as a subagent for frontier reasoning tasks (see /cost-aware skill).
```

If running as Sonnet, confirm briefly: `✅ Running as Sonnet (cost-aware mode active)`

Read the cost-aware skill (`.claude/skills/cost-aware/SKILL.md`) to load the escalation protocol. All subagents launched this session must use `model: "sonnet"` or `model: "haiku"` unless an explicit Opus escalation is triggered.

### Step 8: Present the briefing

Output a concise briefing in this format:

```
## Session Briefing

### Model
[Sonnet ✅ or Opus ⚠️ — with cost warning if Opus]

### Product
[One line — what this is, from handoff or CLAUDE.md]

### Last Session
[What was done, from handoff report or session log]

### Uncommitted Changes
[If any beyond what handoff describes]

### Pending
[What's next, from handoff + memory]

### Key Reminders
[Any feedback memories that apply — budget discipline, git workflow, etc.]

### Ready
[Suggestions for what to pick up, or "Ready for instructions."]
```

Keep it tight. The user wants to glance at this and know exactly where things stand.

---

## Mid-Session Logging Protocol

**This is critical.** You must append to `scripts/output/session-log.md` throughout the session whenever:

- A new concept, term, or feature name is introduced
- A product decision is made
- The user describes a goal, preference, or direction
- You agree on an approach or architecture
- Anything happens that would be lost in a crash

Format each entry as:
```
[HH:MM] [TYPE] content
```

Types: `CONCEPT`, `DECISION`, `GOAL`, `FEEDBACK`, `NOTE`

Examples:
```
[14:32] [CONCEPT] "repo tracking" — any repo with Supabase gets per-provider dial tiles auto-discovered from api_usage table
[14:35] [DECISION] "Add Google Project" renamed to "Add Repo" — not Google-specific
[14:40] [FEEDBACK] User wants admin keys labeled clearly as "billing tile" not hidden
```

**Do not wait for the user to ask.** Log proactively as the conversation unfolds. This log is crash insurance.
