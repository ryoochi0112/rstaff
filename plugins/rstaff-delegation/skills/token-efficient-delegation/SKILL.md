---
name: token-efficient-delegation
description: Route engineering work across the current host, native subagents, and external Codex workers with resumable ledger state and measured usage. Use when planning parallel work, choosing a writer or reviewer, offloading Claude work to Codex, reducing repeated context, designing handoffs, or diagnosing an expensive agent loop — including plain-language symptoms: re-reading the same diff or log every few turns, wanting investigation or edits pushed off to another worker so the session's context stays small, being about to paste a subagent's raw output back into the conversation, or asking what a handoff actually cost. Do not load it to decide what to build, to run the ledger/review loop itself (use parallel-build), or to reconcile an external model's opinion on a diff (use /consult).
---

# Token-efficient delegation

Keep requirements, decisions, and integration in the coordinator. Delegate only
bounded work whose completion can be verified independently.

## Bound the context first

Delegation is the second lever; session length is the first. Context is billed per
turn, so a coordinator's cost is `turns × context` — measured at a median **151×**
re-read, with **64%** of spend falling after turn 250. Routing work to Codex wins
mainly because the edit/build residue (**58%** of all ingested tool output) never
enters the amplified context at all, not because its tokens are cheaper.

So: end a session at each unit of work, never run bulk edits or test suites in the
coordinator, and send read-heavy investigation to `codex advise` or a subagent.
If `locate.js rstaff-engineer` exits 1, say "Engineer layer absent; using the delegation discipline below."
Full rule + evidence: `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-engineer)/rules/session-hygiene.md`.

## Route

1. Decompose ambiguous work before delegating.
2. For a ledger task, assign `risk: low|medium|high`, leave `reviewer: auto`
   unless the operator overrides it, and set `route: pending`.
3. Resolve and persist the route mechanically:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/route.js" resolve \
  --ledger <absolute-ledger> --task <id> --write
```

4. Use the returned writer, reviewer, model, and effort exactly. **When a route needs
   overriding, escalating, or explaining, read `references/routing.md`** — the per-risk
   policy and escalation rules live there, not in this body.

## Hand off

Pass a file packet, not conversation history. Include the task boundary,
absolute spec/brief path, relevant interfaces, exact verify command, and compact
completion contract. Keep parallel writers in separate worktrees.

Label delegated phases `<repo>/<slug>/<task-id>/implement|review`. Delegates log
automatically; do not paste raw JSONL into the coordinator context.

## Gate

Keep writer and reviewer independent. Give the reviewer the spec, fixed diff,
and repository rules—not the writer's reasoning. Require the same verify,
spec-verdict, and quality-verdict contract on every route.

## Measure

```bash
/rstaff-usage:spend --days 30
```

Compare provider-native prompt, cache-read, cache-write, output, retries, and
pass rate. Treat unmeasured runs as unknown, never zero. Provider tokenizers,
subscription quota, and API billing differ; do not infer currency.
