# The dispatch loop — full detail

SKILL.md carries the compact loop. This file is the full loop, the review-lessons
carry-over, the parking and dead-man rules, and the model/cost policy. Read it when
running or changing the loop, parking a task, or reasoning about routing cost.

## The dispatch loop (one feature)
```
loop:
  if the (absolute) .STOP kill-switch exists → stop (record "stopped")
  reconcile the ledger with git FIRST (idempotent — see SKILL.md § Resume): for each non-`done`
    task, if a branch commit carries its `rstaff-task: <slug>/<id>` trailer (exact match)
    → mark it done with that sha; else reset any `in_progress` task (crashed mid-flight,
    never committed) back to pending
  pick the next task whose status is pending AND all deps are done
  if none pending/ready → done (set feature status ready_for_review or needs_human)
  mark it in_progress; set status: building
  resolve + persist the exact writer/reviewer route (this decides the writer too —
  the ledger's `impl:` may be `auto`):
    node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/route.js" resolve
      --ledger <absolute ledger> --task <task-id> --write
    use the returned route/models/effort; never infer them in prose.
    take `reviewRequired` from that JSON; it is the machine-decided task gate.
    Never derive it from `class:` or any other ledger text.
    An already-persisted route comes back with `reused: true` and is NOT
    re-derived — that's what makes a resumed feature keep the writer/reviewer it
    started with. Only pass --reroute when you intend to change it.
  the route is the writer's AUTHORIZATION, not a suggestion. Before dispatching any
  writer, gate on:
    node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/route.js" require
      --ledger <absolute ledger> --task <task-id>
    which exits 1 for as long as `route:` reads `pending`. The Codex path is
    additionally denied by the guard-bash hook — guard-bash denies a `delegate.js … execute` whose
    `--label` names a ledger task with no persisted route — so a skipped resolve
    fails loudly instead of silently falling through to Claude.
  effective impl = the resolved `impl` from that JSON (never re-derive it)
  write the self-contained brief (references/task-brief.md) to a briefFile, then
  implement, branching on the JSON's `writerMode` (never infer the mode from `impl`):
    - subagent (claude) → dispatch a fresh `implementer` subagent with the brief   (UNCHANGED)
    - draft (gemini, `class: docs` only) → run `delegate.js gemini draft --brief <briefFile>
        -o <draft.md> --label "<repo>/<slug>/<task-id>/draft"` (read-only), then dispatch a
        fresh `implementer` (`model: sonnet`) with the draft attached to apply it to the
        task's files. Never `gemini execute` — that mode does not exist.
    - execute (codex) → run `node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/delegate.js" <impl> execute` exactly as specified in
        references/external-writer.md, labelled "<repo>/<slug>/<task-id>/implement".
        Pass the resolved --model/--reasoning-effort VERBATIM — a dropped flag
        silently reverts the task to codex's config default and makes the
        authorized risk tier a fiction. The external model writes files in the
        runner's own cwd; the runner still never commits.
  ├─ implementer returns PARKED, or the delegate.js result is `ok:false` / `timedOut:true`
  │    (a hung external CLI is killed by delegate.js's Node timeout) →
  │    attempts++; if attempts ≥ 3 → park (see below); else retry fresh
  └─ implementer returns done (verify green), or the delegate.js result is `ok:true` →
       if `reviewRequired` is false → SKIP reviewer dispatch. The DISPATCHER
         runs `make verify` itself before the checkpoint commit; skipping the
         reviewer never skips the verify gate.
         ├─ dispatcher verify red → attempts++; if attempts ≥ 3 → park; else retry fresh
         └─ dispatcher verify green →
              ONE checkpoint commit of the CODE ONLY, with `rstaff-task: <slug>/<id>` as its
                own trailer line in the message (unique per task — `T1` ≠ `T10`)
              then write the ledger row in $CTRL (status done,
                `review: skipped(class:<class>)`, not `-`, commit sha); `<class>` is
                recorded for audit and is not used to derive the route decision.
              rewrite the feature status file; continue
       else (`reviewRequired` is true) →
         review using the persisted route:
           - claude → fresh `reviewer` in TASK MODE; include
                      "rstaff-usage-label: <repo>/<slug>/<task-id>/review"
           - codex  → build references/review-packet.md and call sandboxed
                      `node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/delegate.js" codex advise` with the resolved model/effort,
                      task-review schema, and label "<repo>/<slug>/<task-id>/review"
         ├─ spec:BLOCK or quality:BLOCK → append findings to the brief;
         │    record the task-mode BLOCK evidence:
         │      node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-review-rounds.js" record \
         │        --repo <repo> --branch <branch> --mode task --verdict block \
         │        --label <repo>/<slug>/<task-id> --attempt <N>
         │    Use `block` if either review verdict is BLOCK; omit `--p0`, `--p1`,
         │    `--goal`, and `--why` because task mode defaults counts to zero and
         │    owes no memo fields. `<N>` is the same 1-based writer attempt
         │    number the writer's `delegate.js --attempt` got (1 on the first
         │    dispatch; a ledger at `attempts: 0` means N = attempts + 1); with
         │    `--label` it feeds /rstaff-usage:spend's pass rate per writer tier.
         │    attempts++;
         │    if attempts ≥ 3 (2 review bounces) → park; else retry fresh
         │    (handle findings per superpowers:receiving-code-review:
         │     verify each technically — no performative agreement, no quiet dismissal)
         └─ spec:PASS AND quality:PASS →
              record the task-mode PASS evidence:
                node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-review-rounds.js" record \
                  --repo <repo> --branch <branch> --mode task --verdict pass \
                  --label <repo>/<slug>/<task-id> --attempt <N>
              Use `pass` only when both review verdicts are PASS; omit `--p0`, `--p1`,
              `--goal`, and `--why` because task mode defaults counts to zero and
              owes no memo fields.
              ONE checkpoint commit of the CODE ONLY, with `rstaff-task: <slug>/<id>` as its
                own trailer line in the message (unique per task — `T1` ≠ `T10`)
              then write the ledger row in $CTRL (status done, review, commit sha)
              rewrite the feature status file; continue
```
The per-task review (when required), commit, and rails — kill-switch check,
3-attempt cap, dead-man, resume — are unchanged across backend routes. On every
backend, what gates "done" is the independent
reviewer's own `make verify` run, **never a writer's own self-report**, when
`reviewRequired` is true — the `ok:true` branch hands off to review without parsing
the external model's "STATUS:" line at all. When `reviewRequired` is false, the
dispatcher runs `make verify` itself before the checkpoint commit; the reviewer
SKIP removes no verify gate.

**Carry review lessons forward (cross-task).** Beyond the same-task retry findings in
the loop, keep a short running list of **systemic** review findings for the feature
(e.g. "guard tests must survive mutation", "list endpoints must paginate") and prepend
it to **every new task's** implementer brief — so a lesson the reviewer caught on task
N stops recurring on N+1. This is the manual carry-over that makes later tasks pass
review first-try; make it standard. (Format: a `## Review lessons so far` block in the
brief — see `references/task-brief.md`.)


## Parking & dead-man (don't thrash, don't run away)
- **Park a task** when: verify fails 3× on one root cause, 2 review bounces, or it
  needs a human decision. Action: `git stash push -u -m "rstaff parked <slug>/<id>"`
  (never `git clean`/`reset --hard`). Record `notes:` = symptom / tried / hypothesis
  / need. Mark dependents `blocked`; keep going on independent tasks.
- **Dead-man:** if **two consecutive different tasks** fail verify, stop the whole
  feature (likely systemic — broken base or bad setup); mark the rest `not_attempted`.
- Ledger mode does **not** write `BLOCKED.md` (the ledger + status file replace it).

## Model & cost
`feature-runner` runs on `sonnet`. `route.js` resolves the writer and reviewer axes per
task from `risk` and persists them; **writer and reviewer are never the same provider on
one task**. The per-risk model/effort tables, the independence interlock, and the
stickiness rule are owned by one source of truth —
`$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/skills/token-efficient-delegation/references/routing.md`. Read it
rather than restating the policy here.

Delegates log usage automatically; SessionEnd/SubagentStop hooks capture Claude usage.
Inspect both with `/rstaff-usage:spend`. Per
AUTONOMY.md, instrument the first dispatch before scaling to the default cap of 3
concurrent features. Provider tokenizers and billing are distinct; do not translate
token counts into dollars.

