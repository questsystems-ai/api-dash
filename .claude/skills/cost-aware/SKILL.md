---
name: cost-aware
description: Run as Sonnet by default, escalate to Opus subagents only when needed, track and report costs
user-invocable: false
---

## Cost-Aware Session Protocol

**You are Sonnet.** You handle the entire session. You are fast, cheap, and capable of 95%+ of all tasks. You only escalate to Opus when you hit a specific trigger — and when you do, you launch it as a contained subagent, get the result, and continue.

### Pricing Reference (per million tokens, as of 2025)

| Model | Input | Output | Relative Cost |
|-------|-------|--------|---------------|
| Haiku 4.5 | $0.80 | $4.00 | 1x (baseline) |
| Sonnet 4.6 | $3.00 | $15.00 | ~4x Haiku |
| Opus 4.6 | $15.00 | $75.00 | ~19x Haiku, ~5x Sonnet |

**Every Opus token costs 5x a Sonnet token.** This compounds fast in long sessions.

---

### What Sonnet Handles (everything except the list below)

- Planning, scoping, and task breakdown
- File reading, exploration, search
- Writing and editing code (features, bug fixes, refactors)
- CSS, HTML, config, markdown, YAML
- Writing docs, READMEs, plans
- Git operations, commits, PRs
- Running tests, interpreting output
- Simple architecture decisions
- All subagent exploration/research tasks (`model: "sonnet"` or `model: "haiku"`)
- Conversation with the user

### When to Escalate to Opus

Launch an Opus subagent ONLY when ALL of these are true:

1. **The task requires deep, novel reasoning** — not pattern-matching or following established conventions
2. **Sonnet has already tried and produced a subpar result**, OR the task is clearly beyond Sonnet's capability before attempting (e.g., you can tell it requires holding 8+ files of complex interrelation in working memory)
3. **The task is bounded** — you can describe it as a specific deliverable, not an open-ended session

**Specific Opus triggers:**
- Multi-file architectural refactor requiring simultaneous reasoning about 5+ tightly coupled files
- Debugging a subtle concurrency, state management, or race condition bug after Sonnet's attempt failed
- Designing a novel system architecture with non-obvious tradeoffs (not applying a known pattern)
- Complex code generation requiring deep domain knowledge (e.g., compiler, cryptography, distributed systems)
- Creative writing that requires top-tier quality (launch copy, investor pitch)

**NOT Opus triggers (common mistakes):**
- "This file is long" — Sonnet handles long files fine
- "This is important" — importance != difficulty
- "I want to be safe" — Sonnet is not less correct, just less creative at the frontier
- Exploration or research tasks — always Sonnet or Haiku
- Anything involving mostly reading and summarizing

---

### How to Escalate

When you identify Opus-grade work:

**Step 1: Announce the escalation**
```
OPUS ESCALATION
Task: [one-line description]
Reason: [which trigger from the list above]
Estimated scope: [small/medium/large — how many files, how complex]
```

**Step 2: Launch the Opus subagent**
Use the Agent tool with `model: "opus"`. Give it a **complete, self-contained prompt** — the Opus agent has no conversation history. Include:
- Exact task description and deliverable
- All relevant file paths
- Constraints and acceptance criteria
- "Return your result and a brief summary of what you did"

```
Agent(
  model: "opus",
  description: "3-5 word task summary",
  prompt: "Complete task description with all context..."
)
```

**Step 3: Report the result and cost**
When the Opus agent returns, print:

```
OPUS COMPLETE
Task: [description]
Tokens: [from agent result metadata]
Est. cost: $X.XX (vs $X.XX if Sonnet — saved/spent $X.XX)
Result: [brief summary of what Opus delivered]
```

---

### Running Session Cost Ledger

Maintain a mental running tally. After any Opus call, and at session end, print:

```
SESSION COST ESTIMATE
---
Sonnet (main session)
  Input:  ~XXXk tokens x $3.00/M  = $X.XX
  Output: ~XXXk tokens x $15.00/M = $X.XX

Opus escalations: N calls
  #1 [task]: ~XXXk tokens          = $X.XX
  #2 [task]: ~XXXk tokens          = $X.XX

Sonnet subagents: N calls
  [tasks]: ~XXXk tokens total      = $X.XX
---
TOTAL ESTIMATE:                     $X.XX
If all-Opus session:               ~$X.XX
SAVINGS:                            ~XX%
```

**Note:** Token counts are estimates based on message length and agent metadata. Exact billing comes from the Anthropic console.

---

### Subagent Model Selection Guide

| Task Type | Model | Why |
|-----------|-------|-----|
| File exploration, search | `"sonnet"` or `"haiku"` | Just reading and summarizing |
| Code generation (standard) | `"sonnet"` | Sonnet writes good code |
| Code generation (frontier) | `"opus"` | Novel architecture, subtle correctness |
| Research, web search | `"sonnet"` | Information retrieval, not reasoning |
| Test running, validation | `"sonnet"` | Mechanical task |
| Complex debugging | Try `"sonnet"` first | Escalate to `"opus"` only if Sonnet fails |
| Creative/strategic writing | `"opus"` | When quality ceiling matters |

---

### Session Budget: Context Volume, Not Message Count

**Message count is a bad proxy for cost.** A 3-message session that reads a large file costs more than 20 messages of strategy discussion. The real driver is **context volume** — how many tokens are in the window at each turn.

**The right trigger to restart: task switching, not message count.**

Each distinct task should be its own session:
- Build a feature → session 1
- Write a paper → session 2
- Fix a bug → session 3

Same work, fraction of the context cost. Context compounds quadratically — every message re-sends the full history.

**Warning signs the context is getting expensive:**
- You've read several large files (>200 lines each)
- You've built something substantial (new component, new feature, full paper)
- The task you're starting now is unrelated to what you just finished

**When you see these signs:** suggest `/compact` or a fresh session before starting the next task.

- **Commit often** — clean git state means next session recovers instantly
- At session end, print the cost ledger before suggesting a restart
- The cost ledger helps the user see exactly where their money went

---

### Why This Matters

A typical planning/shipping session on all-Opus costs ~$5-10.
The same session on Sonnet with 1-2 Opus escalations costs ~$1-3.
Over a week of daily sessions, that's **$15-50 saved**.
Over a month: **$60-200 saved**.

The savings compound because most work is Sonnet-grade. The skill isn't "use the cheap model" — it's "use the right model for each task, and prove it with numbers."
