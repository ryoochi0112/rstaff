# Session hygiene — bound the context, not just the reads

Context is billed **per turn, not per read**. A token you pull into a session is
re-sent on every turn that follows it, so the cost of a session is roughly
`turns × context`, not `bytes read`. Long sessions are the expensive failure mode,
and they don't feel expensive — they feel productive.

## The evidence (measured 2026-08-01, 14-day window, 124 transcripts)

- **12.7M tokens** of genuinely new tool output was ingested. Roughly **10B** was
  billed. Median session re-read its own context **151×**; the worst hit **605×**.
- **79%** of spend landed on turns carrying **≥200K** of context.
- Cost per turn climbs with session age: **$0.40** (turns 1–100) → $0.57 → $0.89 →
  **$1.06** (turns 501–1000). **64% of spend occurred after turn 250.**
- Sessions ran to a median of 218 turns, p90 737, max 1,317 — one lived a month.
- Subagents ran *more* turns than main threads (35K vs 28K) for **15%** of the cost:
  **$0.095/turn against $0.71**. Small contexts, discarded on completion.
- Execution residue — `Edit` results (30%), `Bash` (18%), `Write` (10%) — was **58%**
  of everything ingested. None of it has value after the turn it lands in.

### One turn, 146M tokens (measured 2026-08-02, session `16d2bf7f`)

A coordinator invoked the `claude-api` skill at turn 77 to answer a single pricing
question. The skill body was **601 KB — 231,471 tokens** in one turn (context
147K → 378K). The session then ran **629 more turns**, so that one call billed
**146M tokens: 46% of the session's entire context re-read**, for a handful of
facts. The same session also never ended — 12 human messages, 10 ledger tasks,
12h34m, 329M of context re-sent, peak 759K. Both failure modes below, in one run.

## The rules

- **One session per unit of work.** Finish a feature, a bug, an investigation →
  `/clear`. Do not carry a session across tasks because the context "might be
  useful"; a fresh session that re-reads two files beats a 600-turn one that
  re-sends forty.
- **Never do bulk execution in the coordinator.** Editing, building, and
  test-running belong in a delegate (`route.js` → Codex) or a subagent. The
  coordinator should receive the verdict, not the residue. See
  `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/skills/token-efficient-delegation`.
- **Load heavy reference material in a delegate, never the coordinator.** A skill
  body, a vendored doc set, a pasted spec — all are injected once and then re-sent
  on every turn that follows, for the life of the session. This is the most
  expensive single action available in a session, and it looks like one tool call.
  Send the *question* out instead: `Agent(general-purpose, "load <skill>, answer X,
  return ≤2K of facts")`, and keep only the answer.
- **Delegate read-heavy investigation.** "Go find out how X works" produces a large
  Grep/Read/Bash pile and a small answer. Send it to `node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/delegate.js" codex advise`
  (read-only) or an `Explore` subagent and keep only the answer.
- **Read narrowly.** Grep to the line before you Read the file; use `offset`/`limit`
  on anything large. A whole-file Read you needed 30 lines of is billed for the rest
  of the session.
- **Compaction is a symptom, not a fix.** Hitting auto-compact means the session
  should have ended one or two tasks ago. Treat it as a signal to `/clear` at the
  next clean boundary, not as headroom to keep going.
- **Don't reopen a large session for a small question.** Ask it in a new one.

## The self-tests (cheap, run them at task boundaries)

- *"Is anything still in this context that I will actually reference again?"* If no,
  `/clear`.
- *"Am I about to run a loop of edits or a test suite in the coordinator?"* Delegate it.
- *"Is what I'm about to load larger than the answer I want out of it?"* Then a
  subagent should load it. Multiply the load by the turns left in the session
  before deciding it's cheap.
- *"Would this investigation be a two-line answer to someone else?"* Then it should
  have been a subagent.

## Escape hatch

A genuinely interdependent piece of work — a refactor whose every step depends on
the last — is allowed to run long. The point is to stop sessions that are long by
*accretion* rather than by necessity. When a session must run long, keep the
execution residue out of it; that is what makes the length affordable.

If `locate.js rstaff-delegation` exits 1, say exactly once per run "rstaff-delegation not installed — all tasks use the Claude writer" and skip external routing and dispatch.
