---
name: initiate
description: Session startup — orient on projects, check git state, load memories
user-invocable: true
---

## Session Initiation Procedure

You are starting a new session in the **project manager** folder, which contains multiple repos. Run through these steps IN ORDER, then present a concise briefing.

### Step 1: Discover projects

List subdirectories that contain a `.git/` folder:

```bash
ls -d */
```

For each project repo found, run `git status --short` and `git log --oneline -3`.

### Step 2: Check for handoff reports

**Check the parent folder first:** glob `scripts/output/session-handoff-*.md` and `scripts/output/session-handoff.md` in the current working directory. This is the most likely "last session" when working from the parent portfolio folder.

Then check each sub-repo's `scripts/output/` folder for `session-handoff-*.md` and the legacy `session-handoff.md`.

**If only one handoff file exists:** read it and summarize in the briefing.

**If multiple handoff files exist for the same repo** (e.g., two concurrent sessions both terminated), list them with their timestamps and a one-line topic from the filename or first heading. Ask the user:

> "Found [N] handoffs for [repo] — want to continue from the most recent, a specific one, or have me combine them into a merged summary?"

Read whichever file(s) the user chooses. If "combine", synthesize the pending items from both into a single merged pending list, deduplicating where they overlap.

Also check for `notes/strategy.md` and the last 20 lines of `scripts/output/session-log.md` in this parent folder — these give current strategic context and recent session history.

Run the security scan on the keystroke buffer:
```bash
python scripts/keystroke-buffer.py --scan
```
If it reports redactions, show the user a brief warning. If clean, no need to mention it.

Check `notes/scratch.md` and `notes/keystroke-buffer.md` — if either contains anything beyond the header (actual content below the `---` divider), surface it immediately:

> "You have uncleared content in scratch.md: [first 3 lines]. Want to continue from this or clear it?"

This ensures free-association drafts written between sessions don't get lost.

### Step 2.5: Crash detection — recover unterminated sessions

For each project repo, check whether the most recent Claude transcript is newer than the most recent handoff file. If so, a session ended without `/terminate` and needs recovery.

**Detection (run for each repo, including the parent folder itself):**
```bash
# Most recent JSONL for parent project:
ls -t /c/Users/aaron/.claude/projects/C--Users-aaron-Documents-a-i-rons-projects/*.jsonl 2>/dev/null | head -1

# Most recent handoff for PARENT folder (check this too — not just sub-repos):
ls -t scripts/output/session-handoff*.md 2>/dev/null | head -1

# Most recent JSONL for a sub-repo (replace {repo} with folder name, e.g. romantasy-v1):
ls -t "/c/Users/aaron/.claude/projects/C--Users-aaron-Documents-a-i-rons-projects-{repo}/*.jsonl" 2>/dev/null | head -1

# Most recent handoff for a sub-repo:
ls -t {repo}/scripts/output/session-handoff*.md 2>/dev/null | head -1
```

Compare mtimes. If the JSONL file is **newer** than the newest handoff → crashed/unterminated session.

**Recovery (for each crashed session found):**
```bash
# Extract the last ~600 words of conversation from the transcript tail:
tail -c 15000 <jsonl_path> | grep -ao '"text":"[^"]\{30,\}' | sed 's/"text":"//; s/\\n/\n/g' | tail -40
```

This surfaces the last assistant response and any user messages near the crash point.

**In the briefing**, add a "Recovered Session" section for each repo where a crash was detected:
```
### Recovered Session: [repo]
Last exchange before crash:
[last user message + last assistant response, condensed to key points]
Likely next action: [what was about to happen]
```

If no crash is detected for any repo, skip this section silently.

### Step 2.6: Rolling Session Memory — ingest last 5 sessions

After crash detection, automatically load a condensed digest of the last 5 JSONL transcripts for the **current project**. This gives the session a rolling memory of recent conversations so the user can ask "remember when you said X two sessions ago?" and get an immediate answer — no lookup required.

**Find the last 5 JSONLs:**
```bash
# For the parent folder:
ls -t /c/Users/aaron/.claude/projects/C--Users-aaron-Documents-a-i-rons-projects/*.jsonl 2>/dev/null | head -5

# For a sub-repo (replace {repo} with folder name):
ls -t /c/Users/aaron/.claude/projects/C--Users-aaron-Documents-a-i-rons-projects-{repo}/*.jsonl 2>/dev/null | head -5
```

**Extract a condensed digest from each** (substantial messages only — skips tool calls and short exchanges):
```bash
tail -c 40000 <jsonl_path> | grep -ao '"text":"[^"]\{80,\}' | sed 's/"text":"//; s/\\n/\n/g' | head -60
```

This yields ~1–2KB per session. Five sessions = ~5–10KB total — negligible context overhead.

**Hold the digests as a compact "Session History" block.** Do not print them in the briefing — just hold them in context silently. When the user asks about something from a prior session, answer from this loaded context directly. For verbatim recall ("give me that exact prompt"), grep the specific JSONL:
```bash
grep -ao '"text":"[^"]*<keyword>[^"]*"' <jsonl_path> | sed 's/"text":"//;s/"$//' | head -20
```

**Never say "I don't have that" until you have checked the transcripts.** Memory is for persistent facts across sessions. Transcripts are the ground truth for what was actually said.

### Step 3: Check memory

Read the memory index (`MEMORY.md` in this project's memory directory) and scan for relevant memories. Read the most important ones (especially feedback and project memories).

**Past decision lookup:** If the user asks about a specific past decision (a chosen name, acronym, option picked, etc.) and the handoffs + memory don't contain it — grep the JSONL transcripts before asking the user to repeat themselves. The transcripts are the ground truth. Search with:
```bash
grep -ao '"text":"[^"]*<keyword>[^"]*"' <jsonl_path> | sed 's/"text":"//;s/"$//' | head -20
```
Use the most recent JSONL first (`ls -t /c/Users/aaron/.claude/projects/<project-id>/*.jsonl | head -3`). Do not surface "I can't find it" until you've checked the transcripts.

### Step 4: Verify cost-aware mode

Check that you are running as **Sonnet** (not Opus). If you detect you are Opus, warn the user immediately:

```
WARNING: COST WARNING: This session is running on Opus. For cost efficiency, restart with Sonnet selected.
Opus should only be used as a subagent for frontier reasoning tasks (see /cost-aware skill).
```

If running as Sonnet, confirm briefly: `Running as Sonnet (cost-aware mode active)`

Read the cost-aware skill (`.claude/skills/cost-aware/SKILL.md`) to load the escalation protocol. All subagents launched this session must use `model: "sonnet"` or `model: "haiku"` unless an explicit Opus escalation is triggered.

### Step 5: Present the briefing

```
## Session Briefing

### Model
[Sonnet or Opus — with cost warning if Opus]

### Projects
[For each repo: name, branch, clean/dirty status, last commit summary]

### Last Sessions
[Key points from any handoff reports found]

### Pending
[What's next across projects, from handoffs + memory]

### Key Reminders
[Any feedback memories — budget discipline, git workflow, etc.]

### Ready
[Suggestions for what to pick up, or "Ready for instructions."]
```

Keep it tight. The user wants to glance at this and know exactly where things stand.
