---
description: Maintenance factory — process many small, independent tasks at a graded autonomy level (report → assisted → unattended) with worktree isolation and the loop-operator's safety rails.
argument-hint: [report|assisted|unattended] <task type, e.g. "lint fixes", "dep bumps"> [--impl <claude|codex>] [--model <id>]
allowed-tools: Bash, Read, Grep, Glob, Write, Edit, Task, AskUserQuestion
---

Run the **maintenance factory** for: **$ARGUMENTS**

Autonomy level comes from the first arg or `RSTAFF_AUTONOMY` (default **report**).
Mirrors ECC's minimal/standard/strict profiles. **Always start at report** for a
new task type and only climb after it proves safe.

**`--impl <backend>` (optional; default `claude`):** the implementer backend for
every task in this run. Batch has no ledger (unlike `/dispatch`/`/build`), so
this is a single **run-level** flag, not per-task. `--model <id>` passes through
to the backend. Absent flag = today's behavior, unchanged.

### Preflight (before spawning/looping anything)
For `codex`, probe availability the same way `/dispatch` does:
`command -v codex` (or `delegate.js`'s exported `isAvailable()`). If it is not
available, **STOP** — name the fix, spawn nothing:

> STOP: --impl codex requires the codex CLI on PATH (codex login).
>       No tasks were spawned.

Backend not installed → **STOP** and report why, or — only with the human's
explicit ok (AskUserQuestion) — fall back to `claude` for this run instead.
**Never silently substitute a backend.**

### L1 — report-only (default; never modifies files)
Discover up to 20 low-risk, independent tasks of the requested type and write
`tasks.csv` (and a readable summary):
`task_id, files, expected_change, risk(low/med/high), verify_command, independent(y/n)`
Do not edit anything. This is the safe default — the human picks what graduates.
**`--impl` is a no-op at L1** — no code is written, so the report is identical
regardless of the flag.

### L2 — assisted (one PR per task, human reviews each)
For the chosen low-risk tasks only:
- create a **git worktree per task** (isolation prevents cross-task conflicts;
  recipe: `${CLAUDE_PLUGIN_ROOT}/skills/parallel-build/references/worktrees.md`),
- make the change — for `impl: claude` (default), do it directly as today; for
  `codex`, instead shell `node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/delegate.js" <impl> execute --cwd
  <task-worktree>` (the `/build` executor path) to author the diff,
- then, **unchanged regardless of who authored the diff**: run that task's
  `verify_command` / `make verify`; on green, open a PR; on failure, park the
  task with the reason. Delegation only changes who authors the change — the
  gate never changes.
Stop and report; the human reviews/merges. No unattended looping yet.

### L3 — unattended (supervised loop)
**STOP before handing anything to the loop-operator** if `--impl` is
`codex` **and** the level is L3/unattended (from the first arg **or**
`RSTAFF_AUTONOMY=unattended`); `--impl claude` at L3 is unaffected:

> STOP: L3/unattended delegation to a non-Claude backend is out of scope.
>       Use --impl codex at L2 (assisted), or run L3 with --impl claude.

Otherwise, hand the queue to the **loop-operator** subagent (Task tool). It
REQUIRES, and you must supply: an explicit stop condition, a max-iteration cap,
a budget cap, and the kill-switch path (`var/.STOP`). Each task runs in its own
worktree, must pass `make verify` **and** `/review` before opening a PR, and the
operator heartbeats + halts on the kill-switch or a stall. Never launch L3
without all caps set.

> Rollout discipline: a task type earns L3 only after L2 PRs were consistently
> clean. When in doubt, drop a level. Touch `var/.STOP` to halt any running loop.

If `locate.js rstaff-delegation` exits 1, say exactly once per run "rstaff-delegation not installed — all tasks use the Claude writer" and skip external routing and dispatch.
