# Task ledger format — `<slug>.tasks.md` (control repo)

The **single source of truth** for a build's run state. `/design` writes it; `/build`
and `feature-runner` read and update it.

## Where it lives (control repo — never the product repo)
The spec, ledger, and QA runbook are rstaff **process artifacts**, not product code,
so they live in the **control repo** — never in the product repo or its PR:

```
$CTRL/var/specs/<repo>/<slug>.md        # spec = the contract
$CTRL/var/specs/<repo>/<slug>.tasks.md  # this ledger = run state
$CTRL/var/specs/<repo>/<slug>.qa.md     # QA runbook (optional)
```

- `$CTRL` = the control repo (`$RSTAFF_HOME`, the dir holding `rstaff.json`).
- `<repo>` = the product repo's directory name — the **same token** as its
  `$CTRL/profiles/<repo>.md` and its `var/dispatch/<repo>/` status files.
- `var/` is gitignored, so these are **local operator working state**: they survive
compaction and restarts (a file `/build` re-reads from `$CTRL`), but they are
committed nowhere and never travel in
  the product PR. rstaff makes **zero edits to the product repo.**

> **Why not commit the ledger onto the feature branch (the old convention)?** A
> branch-committed ledger let a teammate resume from just the branch — but it polluted
> the product repo and PR with rstaff process files that had to be hand-`git rm`'d
> before merge. For a solo/small-team operator a clean product repo wins, and resume
> still works because the ledger is read from `$CTRL` (see SKILL.md § Resume).

- **Spec** (`<slug>.md`) = the immutable contract. Never rewrite it during a build.
- **Ledger** (`<slug>.tasks.md`) = mutable run state. Only the dispatcher/runner writes it.

## Schema

```markdown
# Tasks — <feature title>
spec: $CTRL/var/specs/<repo>/<slug>.md
branch: feat/<slug>
verify: <verify command(s), pasted from the product profile or `make verify`>
status: planned | building | ready_for_review | needs_human | shipped
updated: <ISO8601> by plan|build|dispatch
impl: auto | claude | codex        # optional; default claude when absent.
                                    # `auto` = route.js picks the writer per task
                                    # from `risk`; a named backend implements
                                    # every task this run
reviewer: auto | claude | codex    # optional; default auto

| id | title | deps | status |
|----|-------|------|--------|
| T1 | Define X types + parser | -  | done |
| T2 | Wire service to parser  | T1 | in_progress |
| T3 | Endpoint + tests        | T2 | pending |

## T1: Define X types + parser
- status: done            # pending | in_progress | done | parked | blocked | not_attempted
- deps: -
- risk: low               # low | medium | high; required for deterministic routing
- class: logic            # logic | security | docs | config; defaults to logic
- impl: -                          # optional; overrides the header `impl:` for this task only.
                                    # `codex` HERE is the one-task opt-out to codex's own
                                    # config.toml model; a header/CLI `codex` takes the risk tier
- impl-reason: -                   # REQUIRED when the `- impl:` pin above contradicts the
                                    # automatic route (a `# …` note on the impl line counts)
- reviewer: -                      # optional; overrides header reviewer (`-` = inherit)
- route: claude/sonnet -> codex/gpt-6-luna@max  # resolved + persisted before
                                    # spawn, then REUSED — `<backend>/<model>[@effort]`
- route-reason: low-risk Claude-authored task uses cross-provider review
- files: src/x/types.ts, src/x/parse.ts, tests/unit/parse.test.ts
- interfaces: exports `parseX(raw: string): X`; consumed by T2, T3
- acceptance:
  - handles the 3 edge cases in spec §4
  - unit tests cover them; verify green
- attempts: 1
- review: spec:PASS quality:PASS   # or "-" while pending / "spec:BLOCK(<why>)"
- commit: a1b2c3d                  # checkpoint sha; commit carries the trailer `rstaff-task: <slug>/T1`
- notes: -                         # on park: symptom / tried / hypothesis / need
```

## Rules
- **Single-token `- status:` lines** stay greppable; the summary table is for
  humans and `/cockpit`. Keep the two consistent.
- **Statuses:** `pending → in_progress → done`; `parked` (needs human / repeatedly
  failed verify); `blocked` (a dependency parked); `not_attempted` (feature stopped
  before reaching it, e.g. dead-man).
- **deps** gate readiness: a task is *ready* only when every dep is `done`.
- **Checkpoint sha ↔ ledger row.** The code lands in the product repo (worktree); the
  ledger row that flips a task to `done` is written to `$CTRL` immediately after. The two
  are reconciled at the **top of every dispatch iteration** by the commit's
  `rstaff-task: <slug>/<id>` trailer, matched **exactly** (anchored — `T1` must not match
  `T10`): a tagged task is marked `done`, an untagged `in_progress` task is reset to
  `pending`. So a crash in the gap never re-runs a committed task nor skips an
  uncommitted one. See SKILL.md § Resume.
- **impl** selects the backend that implements a task: `claude` (default, used
  when the field is absent), `codex`, or `gemini` (docs class only — it drafts
  prose and a Claude implementer applies it). The HEADER `impl:` sets this
  run's default; a task's own `- impl:` line overrides it for that task only
  (`-` = no override, inherit the header). It never changes the review/commit
  rules — every backend is still gated by the same independent review contract
  and one checkpoint commit (see `SKILL.md`).
  A per-task `- impl: codex` pin falls back to codex's own config default with no
  flag needed; a header or CLI `codex` takes the risk band tier instead. `claude`
  needs no flag either way.
- **impl-reason** is how a per-task pin earns its exception. When a `- impl:`
  pin resolves to a *different* backend than `impl: auto` would have, `route.js`
  **refuses** the task until the reason is recorded — as `- impl-reason: <why>`
  or as a `# …` note on the impl line. The reason is folded into the persisted
  `- route-reason:`, so the exception is auditable and a resumed run replays it.
  This is not a vote on who should write high-risk code; it stops the ledger and
  `route.js` from disagreeing in silence. Measured 2026-08-02: four high-risk
  tasks were pinned to Claude by a `/build` brief, quietly opting out of the
  cross-provider policy for a whole feature with nothing recording why. A pin
  that keeps needing the same reason is evidence to change the default in
  `route.js` — not to keep writing the pin.
  A CLI `--impl` is exempt: it is typed by a human in the moment and visible in
  the invocation, not buried in a ledger row.
- **class** defaults to `logic`. `docs` and `config` tasks skip the per-task
  reviewer gate; verify still runs and the checkpoint commit is still tagged.
  The whole-branch `/review` before ship remains mandatory for every class — a
  light path never waives it.
- **risk + impl + reviewer + route** make both routing decisions resumable and
  auditable. `/design` assigns `risk`; `impl` and `reviewer` default to `auto`.
  Before spawning, the runner must execute `node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/route.js" resolve --ledger
  <absolute path> --task <id> --write` and use its JSON result
  (`impl`/`writerModel`/`writerEffort`, `reviewer`/`reviewerModel`/`reviewerEffort`).
  - **Writer** (`impl: auto`): Codex at every band — low → `gpt-6-luna@max`,
    medium → `gpt-6.1-sol@medium`, high → `gpt-6.1-sol@xhigh`. Risk moves the tier,
    not the provider (`CODEX_TIER` in `route.js` is the authority; a test
    pins these rows to it). Exception: `class: docs` drafts on Gemini (`gemini-3.8-flash`)
    and the band's Claude implementer applies the draft.
  - **Reviewer** (`reviewer: auto`): a Codex-authored diff always gets a
    fresh Claude reviewer at the band's Claude tier (`CLAUDE_TIER`: `sonnet` for
    low/medium, `opus` for high — pass it as the Task `model:`); a Claude-authored
    low/medium task gets Codex review at
    the same tier; high risk stays on Claude (`opus`).
  - The two interlock: **an external writer is never its own reviewer** —
    `impl: codex` + `reviewer: codex` is refused even when both are explicit. So
    `impl: auto` + `reviewer: auto` yields Codex-writes/Claude-reviews at every
    risk band (a fresh Claude reviewer is the baseline gate, not a violation).
  Automatic Codex unavailability is recorded as a fallback on whichever axis
  requested it; an explicit `reviewer: codex` with no Codex is a preflight error.
  Never hand-compose `route:`.
- **`route:` is sticky.** Once resolved it is **reused**, not re-derived —
  re-resolving isn't idempotent across time, so a fallback recorded while Codex
  was down would flip to Codex once the CLI came back, mid-feature. `route.js`
  reuses any parseable `route:` and rewrites nothing; pass `--reroute` (or an
  explicit override) to change a stored route deliberately.
- **Sizing:** one fresh subagent should finish a task from spec + brief + repo
  alone — roughly ≤5 files, one verify cycle, tree green at the end. 3–8 tasks is
  typical. If a feature is ≤2 trivial tasks, skip the ledger and use plain `/build`.
- **Ordering:** sequence so each task's checkpoint commit is a working state.
- Only the dispatcher/runner edits this file. Implementers never touch it.

If `locate.js rstaff-delegation` exits 1, say exactly once per run "rstaff-delegation not installed — all tasks use the Claude writer" and skip external routing and dispatch.
