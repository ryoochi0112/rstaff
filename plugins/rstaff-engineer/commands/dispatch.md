---
description: Dispatcher — run several planned features in parallel, one git worktree + branch + feature-runner each, so you can do other work while the team builds. Stops each at ready_for_review; humans review/ship/merge.
argument-hint: <slug> [<slug> …] [--impl <claude|codex>] [--model <id>]
allowed-tools: Bash, Read, Grep, Glob, Write, Task, AskUserQuestion
---

Act as the **Dispatcher**. Fan out the features: **$ARGUMENTS**
Depth lives in `${CLAUDE_PLUGIN_ROOT}/skills/parallel-build/` (SKILL.md +
references). Run this from the product repo.

**Resolve the control repo first.** Set `CTRL="$RSTAFF_HOME"` (or the dir a walk-up
finds containing `rstaff.json`). Everything the runners must reach lives under
`$CTRL` — the kill-switch `$CTRL/var/.STOP` and each status file
`$CTRL/var/dispatch/<repo>/<slug>.md`. **These paths are ABSOLUTE.** A runner's
cwd is its worktree, so a *relative* `var/.STOP` would resolve inside the
worktree and the operator's kill-switch would be silently ignored — always pass absolutes.

### 1. Preflight (before spending any tokens)
Follow `${CLAUDE_PLUGIN_ROOT}/rules/loop-brakes.md`: a human challenge is a hard
stop requiring status plus lettered options, and the advisory breaker trips
after two consecutive whole-branch BLOCKs.
- Each slug needs its spec **and** ledger in the control repo
  (`$CTRL/var/specs/<repo>/<slug>.md` + `…/<slug>.tasks.md`) — if a ledger is missing,
  offer to run `/design`'s decomposition (or stop).
- **Overlap check:** if two features' ledger `files:` unions intersect, warn and
  recommend serializing that pair (first-merged wins; the other rebases at `/ship`).
- **Cap** concurrent features (default **3**; the profile's worktree setup cost is
  real — see `references/worktrees.md`).
- **Stale-run lock:** for each slug, read `$CTRL/var/dispatch/<repo>/<slug>.md`;
  if it exists with `state: building` and `updated` `<24h` ago, **STOP** unless the
  human explicitly overrides — do not create a second worktree/runner for a slug
  already in flight (two writers to one ledger/worktree corrupts it).
- **`--impl <backend>` (optional; default: leave the ledger's own header, which
  `/design` writes as `auto`):** pin the implementer backend for every feature
  dispatched this run, overriding `auto` per-task routing (a ledger can still
  override per-task — see `references/task-format.md`). For `codex`, check availability *before*
  spawning anything — the same probe `delegate.js` uses internally: `command -v
  codex` (or its exported `isAvailable()`). Unavailable →
  **STOP** and report why; or, only with the human's explicit ok (AskUserQuestion),
  fall back to `claude` for this run instead — never silently substitute a backend.
- Validate every task has `risk: low|medium|high`. Resolve `reviewer: auto` with
  `route.js`: Claude-authored low/medium tasks use Codex review when
  available; high-risk or externally-authored tasks use Claude. Record an
  automatic missing-Codex fallback in `route:`; fail preflight when Codex was
  explicitly requested as reviewer but is unavailable.
- **Confirm with the human** (AskUserQuestion) before spawning — this burns real tokens.

### 2. Set up each feature
Per `references/worktrees.md`: `git worktree add ../<repo>-worktrees/<slug> -b
feat/<slug>`, then run the profile's setup commands, and write the resolved
`--impl` backend into the ledger's HEADER `impl:` field only when one was passed
(`references/task-format.md`); otherwise preserve the header `/design` wrote.
Preserve/add header `impl: auto` and `reviewer: auto` when absent; the runner
persists each exact task route immediately before spawn. The spec + ledger already live in the control repo
(written by `/design`) — **do not commit them to the branch**; no rstaff process
artifacts belong in the product tree. Write the initial status file to its
**absolute** path under `$CTRL`.

### 3. Dispatch runners in parallel
Spawn one **`feature-runner`** Task per feature **in one message** (so they run
concurrently). Give each, in its brief: worktree path, the **absolute** spec/ledger
paths (`$CTRL/var/specs/<repo>/<slug>.{md,tasks.md}`), verify + setup commands, the
**absolute kill-switch path** `$CTRL/var/.STOP`, and its
**absolute status-file path** `$CTRL/var/dispatch/<repo>/<slug>.md`. The runner
reads its effective `impl` straight from the ledger (already written in step 2),
so nothing extra is needed for `claude`/`codex`. Each
runs the SKILL loop in its own worktree and rewrites that absolute status file
after every task.

### 4. Roll up + hand off
Runners stop at `ready_for_review` (or `needs_human`). Print a per-feature board
and point at `var/dispatch/<repo>/` (or `/cockpit`). Then, per feature:
`/review` (fresh whole-branch, in the worktree) → `/ship` (runs `verify:full`,
changeset per profile, opens the PR, offers worktree cleanup) → `/land`.
**Never** push/ship/merge here — humans decide.

If `locate.js rstaff-delegation` exits 1, say exactly once per run "rstaff-delegation not installed — all tasks use the Claude writer" and skip external routing and dispatch.
