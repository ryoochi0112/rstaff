# Autonomy, safety rails & cost (Phases 3–4)

How rstaff lets AI "keep working" **without** becoming a runaway. The principle:
earn autonomy gradually, and always keep a hand on the kill-switch.

## The three levels (set via `RSTAFF_AUTONOMY`, default `report`)
| Level | `RSTAFF_AUTONOMY` | What it does | Human role |
|---|---|---|---|
| **L1 report-only** | `report` | Discover tasks → `tasks.csv`. Zero edits. | Picks what graduates |
| **L2 assisted** | `assisted` | One worktree + PR per chosen task; `make verify` gates each. | Reviews/merges every PR |
| **L3 unattended** | `unattended` | `loop-operator`-supervised loop; each task gated by `make verify` **and** `/review`. | Sets caps; spot-checks |

Mirrors ECC's `minimal / standard / strict` hook profiles. **Always start a new
task type at L1.** Promote only after L2 PRs were consistently clean. When in
doubt, drop a level.

**Delegated batches (`--impl codex`) are L2-only.** Start a delegated
task type at report/L2 and instrument its spend before scaling; L3/unattended
delegation to a non-Claude backend is out of scope for now and deferred to a
follow-up (`batch.md` refuses it; `loop-operator.md` only ever runs `impl: claude`).

## Hard rails (enforced by `loop-operator`, Phase 3)
An unattended (L3) loop will not start without **all** of:
- an **explicit stop condition** (queue empty / N done),
- a **max-iteration cap** and a **budget cap** (tokens or time),
- the **kill-switch**: `touch var/.STOP` (or `RSTAFF_STOP=1`) halts before the
  next iteration,
- **dead-man stall detection**: K iterations with no verified progress → stop + escalate.

Worktree isolation (one `git worktree` per task) prevents parallel tasks from
clobbering each other.

## Feature dispatch rails (`/dispatch`, Phase 5)
`/dispatch` fans several planned features across worktrees, one `feature-runner`
each. Its rails **map onto loop-operator's** so there's one safety model, not two:
- **Stop condition** = the ledger (all tasks `done` → `ready_for_review`), plus the
  shared kill-switch `var/.STOP` (checked before each task).
- **Caps** = per-task attempt cap (3: implementer PARKED or review BLOCK → park) +
  a max concurrent-features cap (default 3).
- **Dead-man** = two consecutive different tasks failing verify → stop the feature.
- Runners **never** push/ship/merge/open PRs or run `verify:full` (serial,
  ship-time, human-gated). They stop at `ready_for_review`.
Progress is durable: checkpoint commits + the ledger make a run resumable after a
crash/compaction (`/dispatch <slug>` or `/build` in the worktree continues from the
first non-`done` task). Instrument the first run's spend before scaling to 3.

## Cost discipline (Phase 4)
The reference repos cite real bills (gstack ~$1k/mo heavy use; multi-model
cross-eval and parallel dispatch are token-heavy). Before scaling:
- **Instrument spend** — watch token usage on the first few L2/L3 runs; set the
  budget cap from real numbers, not guesses. Claude hooks and delegated runs
  append usage to `var/usage.jsonl`; inspect it with `/usage` or
  `node plugins/rstaff-usage/scripts/usage.js --days 30`. An unmeasured run is unknown, not free.
- **The delegation layer and wide `/dispatch` fan-outs are the expensive
  tools** — `/consult <model>` (`/codex` is now a thin alias for `/consult
  codex`) and an external `--impl` backend on `/dispatch`/`/build` both incur
  real cross-model spend; reserve `/consult` for high-stakes plans and risky
  diffs, and cap concurrent features. Both are gated behind *explicit*
  invocation; nothing triggers them automatically.
- **Executor rails** — an external `--impl` backend (`codex`) writing code is a
  *potential* cost lever, but that's a claim to **prove on real numbers**, not
  assume:
  - `/consult` stays explicit-invocation only. On the build side, `impl: auto`
    (the header `/plan` writes) lets `route.js` select **codex** as the writer
    at every risk band — risk moves the reasoning tier, not the provider. Pin a
    backend with `--impl` to opt out.
  - Run the first `/dispatch --impl <backend>` (or `/build --impl`) at
    **L1/report first and instrument its actual token/$ spend** before
    trusting it at the default concurrency cap or a wider fan-out.
  - **codex** writes are mechanically **worktree-scoped `workspace-write`**
    (`-s workspace-write -C <worktree>`), never `danger-full-access` —
    `delegate.js`'s sandbox guard refuses that regardless of caller.
  - The same **kill-switch, per-task attempt cap, and dead-man** stall
    detection apply unchanged — an external CLI that hangs or fails is
    parked, not retried forever.
- **No bulk MCP / persona loading** — every always-on token is paid on every turn.
- **No false currency conversion** — provider tokenizers, subscription quota,
  and API billing are separate accounting systems. Treat cross-provider token
  totals as directional evidence, not currency.

## Quick reference
```bash
export RSTAFF_AUTONOMY=report      # safe default
/batch report "lint fixes"         # L1: just tells you what it'd do
/batch assisted "dep bumps"        # L2: PRs you review
RSTAFF_AUTONOMY=unattended /batch unattended "deprecated API replacement"  # L3: capped + supervised
touch var/.STOP               # stop any running loop, now
```

> **Scheduling these levels** — optional cron recipes for running the recurring
> engineering rituals at these autonomy levels live in `docs/RITUALS.md`.
