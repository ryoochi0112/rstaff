# External writer (`codex`) — reference companion to `../SKILL.md`

Read this **only when the persisted route's effective `impl` is an external backend**.
On the default `claude` route none of it applies — the dispatcher sends a fresh
`implementer` subagent with the brief and skips straight to review.

The loop, the rails, and the gate are identical on both routes. What changes is who
writes the diff and how the runner invokes and interprets it.

## Why an external writer strengthens writer ≠ reviewer

The external backend writes code inside the worktree and never reviews, commits, or
edits the ledger. Independence is *strengthened* here, not weakened: a different model
authored the diff, so the fresh Claude `reviewer` is a genuinely independent check
rather than a differently-prompted instance of the model that wrote the code. That is
why `route.js` always pairs a Codex writer with a Claude reviewer.

Feed it `AGENTS.md` as project guidance — the same file Codex already reads.

## Invocation

```
node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/delegate.js" <impl> execute
  --cwd <cwd/worktree> --prompt-file <briefFile> --timeout <secs>
  --model <writerModel> [--reasoning-effort <writerEffort>]
  --attempt <N>
  --label "<repo>/<slug>/<task-id>/implement"
```

`<N>` is the 1-based writer attempt number (1 on the task's first writer dispatch, +1 per retry; ledgers that start `attempts: 0` pass `attempts + 1`), so quota and review verdicts are recorded per attempt.

**Pass `--model`/`--reasoning-effort` exactly as resolved.** Omit `--model` only when
`writerModel` is `default`. A dropped flag silently reverts the task to codex's own
config default — which makes the resolved risk tier a fiction, because the task then
runs at whatever tier the CLI happens to be configured for rather than the one the
route authorized.

`--cwd` scopes the run to the runner's own working directory: the worktree under
`/dispatch`, or the product-repo root under `/build`'s dispatcher mode (see "Paths are
absolute" in `../SKILL.md`). codex adds `-C <cwd/worktree>` itself. `delegate.js` owns
the adapter's exact flags — do not hand-assemble them.

The external model writes files in that directory directly. The runner still never
commits on its behalf; the checkpoint commit remains the dispatcher's.

## Sandbox (mechanical, not advisory)

`delegate.js execute` sandboxes **codex** to `workspace-write`, **scoped to the
worktree**. It is never handed `danger-full-access` or any `--dangerously-bypass-*`
flag — delegate.js's sandbox guard refuses those regardless of caller.

## Interpreting the result

| Result | Action |
|---|---|
| `ok:false` or `timedOut:true` | `attempts++`; at ≥ 3 park the task, else retry fresh. A hung external CLI is killed by delegate.js's Node timeout. |
| `ok:true` | Hand off to review on the persisted route — same two blocking verdicts as the Claude path. |

**Never parse the external model's own `STATUS: done|parked` self-report.** The `ok:true`
branch goes to review without reading it. What actually gates "done" is the independent
reviewer's own `make verify` run, not a claim in the model's text — that is what keeps
the gate mechanical for every backend.

This is exactly the property `/consult`'s reconciliation cannot offer. There, the
external model gets no vote; here, its diff still has to survive an independent Claude
review to land at all.

## Preflight and availability

An explicitly named `impl:` is passed through untouched — availability for a named
backend stays a `/dispatch` preflight decision, where the human gets a say. Per
`AUTONOMY.md`, treat the first `--impl` dispatch run as an L1-first trial and instrument
its token spend before trusting it at the default concurrency cap.

If `locate.js rstaff-delegation` exits 1, say exactly once per run "rstaff-delegation not installed — all tasks use the Claude writer" and skip external routing and dispatch.
