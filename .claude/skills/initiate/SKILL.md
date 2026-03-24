---
name: initiate
description: Session startup — read handoff, check git state, orient on what's next
user-invocable: true
---

## Session Initiation Procedure

You are starting a new session. Run through these steps IN ORDER to get fully oriented, then present a concise briefing to the user.

### Step 1: Read the handoff report

Check if `scripts/output/session-handoff.md` exists. If it does, read it FIRST — this is the most direct summary from the previous session. It tells you what the product is, what just happened, and what's pending.

### Step 2: Check uncommitted changes

Run `git status` and `git diff --stat`.

Identify:
- Modified files (what areas of the codebase were touched)
- Untracked files (new features/files added)
- Staged vs unstaged changes

If there are changes beyond what the handoff report describes, note them — they may represent work done after the report was written.

### Step 3: Recent commits

Run `git log --oneline -10`.

Summarize what the last few commits accomplished. Note the gap between committed work and uncommitted work.

### Step 4: Check memory

Read the memory index (`MEMORY.md` in the project's memory directory) and scan for any memories that seem relevant to what's pending. Read the most important ones (especially feedback and project memories). Don't read all files — just the ones that matter for what's next.

### Step 5: Verify cost-aware mode

Check that you are running as **Sonnet** (not Opus). If you detect you are Opus, warn the user immediately:

```
⚠️ COST WARNING: This session is running on Opus. For cost efficiency, restart with Sonnet selected.
Opus should only be used as a subagent for frontier reasoning tasks (see /cost-aware skill).
```

If running as Sonnet, confirm briefly: `✅ Running as Sonnet (cost-aware mode active)`

Read the cost-aware skill (`.claude/skills/cost-aware/SKILL.md`) to load the escalation protocol. All subagents launched this session must use `model: "sonnet"` or `model: "haiku"` unless an explicit Opus escalation is triggered.

### Step 6: Present the briefing

Output a concise briefing in this format:

```
## Session Briefing

### Model
[Sonnet ✅ or Opus ⚠️ — with cost warning if Opus]

### Product
[One line — what this is, from handoff or CLAUDE.md]

### Last Session
[What was done, from handoff report]

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
