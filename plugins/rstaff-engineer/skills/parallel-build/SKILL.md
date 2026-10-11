---
name: parallel-build
description: If you are about to invoke "the dispatch skill" or "the ledger/dispatcher skill" for this — that IS this skill, and its real, only-valid id is rstaff-engineer:parallel-build (there is no skill actually named dispatch, build, or spec; those are commands, and Skill{skill:"rstaff-engineer:dispatch"} does not exist and will fail). Runs a control-repo `&lt;slug&gt;.tasks.md` ledger through fresh writers, deterministic cross-provider routing, two-verdict review, and checkpoint commits. Use rstaff-engineer:parallel-build when decomposing a spec into a ledger of tasks, running or resuming ledger tasks one at a time, dispatching one or more ready tasks/features in parallel worktrees, or resuming a run after a crash or compaction. Do not load it for single-task work with no ledger, and never to push, ship, merge, or open a PR — runners stop at ready_for_review and humans decide.
---

# Parallel build — subagent-driven development for rstaff

Turns a spec into reviewed, committed increments by dispatching a **fresh subagent per
task**, so several features can run at once (in worktrees) while you do other work.

**vs `superpowers:subagent-driven-development`**: for rstaff ledger work THIS skill is
the engine — routes persisted by `route.js`, gates hook-enforced, state in the control
repo. Never write `.superpowers/sdd/**` files into a product repo; the ledger at
`$CTRL/var/specs/…` is the one run state
(`${CLAUDE_PLUGIN_ROOT}/rules/superpowers-precedence.md` § Precedence).

## Which reference to read, and when
Read each only at the step that needs it:

| Read | When |
|---|---|
| `references/dispatch-loop.md` | Running or changing the loop: full routing/writer/review branches, parking, dead-man, model & cost |
| `references/task-format.md` | Decomposing a spec into a ledger, or reading/writing any ledger row or `impl:`/`risk:`/`deps:` field |
| `references/task-brief.md` | Writing the brief for a task's writer (every task, both routes) |
| `references/external-writer.md` | The resolved `impl` is an external backend (`codex`) |
| `references/review-packet.md` | The persisted route sends review to Codex rather than a fresh Claude `reviewer` |
| `references/run-state.md` | Writing the feature status file, or reasoning about resume / git reconciliation |
| `references/worktrees.md` | Setting up or tearing down a per-feature worktree under `/dispatch` |

## Roles (writer ≠ reviewer holds at every layer)
- **Dispatcher** — the `/build` session, or one `feature-runner` per feature under
  `/dispatch`. Owns the ledger and is the ONLY thing that commits.
- **Writer** — a fresh `implementer` subagent (effective `impl: claude`, the default) or
  an external backend (`codex` via `delegate.js … execute`, sandboxed to
  `workspace-write`). It writes code to green and never commits, reviews, or edits the ledger.
- **Reviewer** — the route `route.js` persists: a sandboxed Codex reviewer or a fresh
  Claude `reviewer`. Both return two blocking verdicts: spec PASS/BLOCK and quality PASS/BLOCK.

## Paths are absolute (control repo — never the product tree)
Spec `$CTRL/var/specs/<repo>/<slug>.md`, ledger `$CTRL/var/specs/<repo>/<slug>.tasks.md`,
kill-switch `$CTRL/var/.STOP`, status file `$CTRL/var/dispatch/<repo>/<slug>.md`. Pass them
as **absolute** paths in every brief: a runner's cwd is its worktree, so a relative path
misses the operator's kill-switch and the real ledger. `$CTRL=$RSTAFF_HOME` (or a walk-up
to `rstaff.json`). rstaff writes **zero** process artifacts into the product repo.

## Delegation preflight

Before the loop, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation`.
If `locate.js rstaff-delegation` exits 1, then for `impl: auto` route every task to a fresh Claude `implementer`.
Print exactly once per run:
`rstaff-delegation not installed — all tasks use the Claude writer`
Skip `route.js` resolve/require and external dispatch for the entire run. This
no-layer path overrides the route-dependent steps below: use a fresh Claude
`rstaff:reviewer` for every task (spec + quality both PASS), and keep verify,
review-round recording, attempt caps, and checkpoint gates. Do not look for
route JSON or repeat the notice per task. An explicit external backend request
requires delegation; report it unavailable instead of silently changing the pin.
When delegation is located, follow the persisted routing steps below.


## The dispatch loop (one feature)
The full loop, with every branch, is in `references/dispatch-loop.md`. Each iteration:
1. **Kill-switch.** If `$CTRL/var/.STOP` exists → stop (record "stopped").
2. **Reconcile the ledger with git first.** For each non-`done` task: a commit carrying
   its exact `rstaff-task: <slug>/<id>` trailer → mark it done with that sha; otherwise
   reset an `in_progress` task to pending. The ledger, not memory, is the task state.
3. **Select** the next pending task whose deps are all done. None → set the feature to
   `ready_for_review` (or `needs_human`) and stop.
4. **Route.** Mark it `in_progress`. Run `node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js"
   rstaff-delegation)/scripts/route.js" resolve --ledger <abs> --task <id> --write`, then
   gate on `route.js require` (the route is the writer's authorization).
   Use its `impl`, `writerMode`, models, and `reviewRequired` verbatim; never infer them.
5. **Implement.** Write the brief (`references/task-brief.md`) and dispatch a **fresh
   writer** by `writerMode`: `subagent` → fresh `implementer`; `draft` → gemini draft,
   then a fresh `implementer` applies it; `execute` → `delegate.js codex execute`.
   PARKED / `ok:false` / `timedOut` → attempts++, retry fresh, park at 3.
6. **Review.** `reviewRequired` false → the dispatcher runs `make verify` itself. True →
   **independent review**: a fresh `reviewer` in task mode (or Codex `advise`), which
   returns spec PASS/BLOCK and quality PASS/BLOCK. Either BLOCK → append the findings
   to the brief, attempts++, retry fresh (park after 2 bounces), and record:
   ```
   node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-review-rounds.js" record \
     --repo <repo> --branch <branch> --mode task --verdict block \
     --label <repo>/<slug>/<task-id> --attempt <N>
   ```
   Both PASS → record the same command with `--verdict pass`:
   ```
   node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-review-rounds.js" record \
     --repo <repo> --branch <branch> --mode task --verdict pass \
     --label <repo>/<slug>/<task-id> --attempt <N>
   ```
7. **Checkpoint commit.** ONE commit of the code only, with `rstaff-task: <slug>/<id>`
   as its own trailer line. Then write the ledger row in `$CTRL` (done, review, sha),
   rewrite the status file, and continue with the next ready task.

"Done" is gated by the reviewer's own `make verify`, never a writer's self-report. Carry
systemic review findings forward in a `## Review lessons so far` block in every new brief.
**Park** a task after 3 verify failures on one root cause, 2 review bounces, or a human
decision (`git stash push -u`, never `git clean`/`reset --hard`); two consecutive
different tasks failing verify stops the feature (dead-man).

## Resume & run state
Re-running `/build` (or `/dispatch <slug>`) reads the ledger **from `$CTRL`** and continues
from the first non-`done` task, so it survives compaction, restarts, and a discarded
worktree. The reconcile in step 2 is what makes that safe: match the trailer **exactly**
(`git log --grep '^rstaff-task: <slug>/<id>$'`) — a bare substring makes `T1` match `T10`.
`references/run-state.md` has the status-file format `/cockpit` parses.

## Boundaries
- Serial **within** a feature; parallelism is per feature (`/dispatch`, one worktree each).
- Per-task review or a task-mode SKIP never waives the whole-branch `/review` before ship.
- Golden-conversation smoke for agent/UI features is an operator gate, not a runner action.
- Runners stop at `ready_for_review` — they never push, ship, merge, or open PRs.
  Humans decide.
