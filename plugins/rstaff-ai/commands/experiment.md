---
description: Experimenter — run any agent/model/prompt/tool change through a controlled, pre-registered, harness-certified experiment to a causal ship/no-ship verdict. Governs the causal comparison and the decision; the actual measurement is delegated to a per-repo ADAPTER (rubric-judged /rstaff-ai:eval, model-compare, …). Sibling of /rstaff-ai:eval, /rstaff:review — writer≠judge enforced via a fresh adjudicator.
argument-hint: [repo] --hypothesis "<claim>" [--explore|--confirm] [--adapter eval|model-compare|…] [--case Y] [--repeat N]
allowed-tools: Bash, Read, Grep, Glob, Task
---

Run one **controlled experiment** to a reliable, attributable, reproducible ACCEPT /
REJECT / INCONCLUSIVE / INVALID-HARNESS verdict for an agent/model/prompt/tool change,
on any product repo. Discipline: `${CLAUDE_PLUGIN_ROOT}/rules/experiment.md`.

This command is a thin **protocol orchestrator** — a phase state machine over one
immutable comparison contract. It runs **no measurement itself**: it dispatches to the
**adapter** declared for the target repo (`$CTRL/profiles/<repo>.md` → `experiment.adapters:`),
e.g. `eval` (rubric-judged quality via `/rstaff-ai:eval`) or `model-compare`. `/rstaff-ai:eval` and any adapter's own command remain directly callable — this
loop simply invokes them as measurements and adds the causal/evidence-governance
machinery around them: contemporaneous control, pre-registration, harness
certification, and independent adjudication.

**Two lanes, never confused:**
- **`--explore`** — visible dev cases, cheap `N=1` shakeouts, unrestricted iteration,
  ablation, error analysis. **Diagnostic only.** It writes **no** confirmation ticket
  and can **never** emit "passed" or promote a candidate — there is nothing here to
  relay as a ship verdict, only findings that feed the next `--confirm` attempt.
- **`--confirm`** — promotes a candidate via the immutable confirmation ticket (phases
  2–5 below). **Refuses to proceed** without a frozen, hashed registration — see the
  structural refusals in step 4 and `rules/experiment.md`.

Default lane is `--explore` unless `--confirm` is given. Resume: re-open the record at
`$CTRL/var/experiments/<repo>/<slug>.md` and continue from its recorded phase.

## Bundled adapter resolution (before phase 3)

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/adapter.js" "$CTRL/profiles/<repo>.md"`
with `--adapter <name>` when supplied. Exit 0 selects the printed `{name,…entry}`.
Exit 1 stops with `no experiment.adapters entry in <profile>`; only an explicit
`--adapter` with no block permits the existing prose-adapter path. Exit 2 stops with
the reader's ambiguous/invalid diagnostic. Run declared commands from the entry's
`cwd`, filling only these placeholders (quote substituted paths as shell arguments):

| placeholder | value |
|---|---|
| `{slug}` | slug from the ticket |
| `{split}` | `dev` for smoke, `confirm` for confirmation |
| `{cert}` | `$CTRL/var/experiments/<repo>/<slug>/cert.md` |
| `{replies}` | `$CTRL/var/experiments/<repo>/<slug>/replies.jsonl` |
| `{grades}` | `$CTRL/var/experiments/<repo>/<slug>/grades.json` |

Create the output directories before invoking the commands. For phase 6 only,
place outputs under `$CTRL/var/experiments/<repo>/<slug>/dev/` instead, preserving
confirmation artifacts and the certificate.

## The phases

0. **Target gate.** Confirm the target is the **product repo**, not the rstaff control
   repo. If cwd is the control repo (or `$RSTAFF_HOME`), loudly warn and stop — the
   harness/adapters live in the product repo. (L03 targeting twin.) *Exception:* when
   the experiment's subject **is** rstaff itself (e.g. a plugin/skill/agent change), the
   control repo IS the target — proceed.

1. **Frame the decision.** When the adapter names `ticket`, read that file relative
   to `cwd` as the registration draft; ask no framing questions. In phase 4 copy its
   fields into the record front-matter, resolve hashes and timestamps, hash the
   registration, and set `status: frozen` before any arm runs. Preserve its decision
   table and `holdout_exposure` declaration. The bundled draft registers exact-match
   rate on `split=confirm`, paired candidate − control, threshold +15 pts, a breach
   when cases control passes and candidate fails ≥ 1, errors counted as fail and
   > 2 errored calls of 24 → INCONCLUSIVE, `N_cases=12`, `N_trials_per_case=1`, and
   one fixed batch. Otherwise name: the actual decision this changes (ship / roll back /
   pick candidate A vs B), the population/use-case it applies to, the intervention
   (the one thing that differs from control), the expected causal effect, and who owns
   the risk if the call is wrong. Set the lane: `--explore` or `--confirm`. In
   `--explore`, loop here and in step 2 freely — pick a candidate, then re-invoke with
   `--confirm` to promote it.

2. **Partition the evidence.** Load the `rstaff-ai:agent-evaluation` skill. Split into dev /
   hidden-confirmation / regression / temporal-&-adversarial slices, each versioned and
   hashed. `--explore` only ever touches dev.

3. **Qualify the instrument.** Load the `rstaff-ai:harness-validation` skill. Require a valid
   **harness certificate** for the target adapter (fidelity, known-pass/known-fail
   fixtures, grader calibration, reset/isolation checks). Missing, stale, or invalidated
   ⇒ **abort with `INVALID-HARNESS`** — a green report over an uncertified instrument is
   the worst outcome, because it looks like a pass. Do not proceed to pre-registration.
   For a bundled entry, run its `certify` command with `{cert}` filled. Any nonzero
   exit stops with `INVALID-HARNESS: certificate <path> status invalidated (known-fail caught x/12)`.
   Name the certificate path and actual fixture count; never run either arm after
   certification fails.

4. **Pre-register the claim.** Load the `rstaff-ai:experiment-design` skill. Freeze and **hash**
   the confirmation ticket — hypothesis/null, primary metric + estimand, practical
   threshold, non-compensable guardrails, sample plan (`N_cases` vs `N_trials_per_case`
   kept separate), randomization/interleaving, error/missing-data policy, stopping rule,
   decision table — into the record via `${CLAUDE_PLUGIN_ROOT}/templates/experiment-record.md` at
   `$CTRL/var/experiments/<repo>/<slug>.md`. **`--confirm` refuses to proceed** past this
   phase without a frozen, hashed registration (see the refusal list below).

5. **Freeze the comparison.** Contemporaneous control + a single isolated treatment
   diff (the actual candidate↔control diff must not exceed the declared intervention
   surface) + exact config hashes + a paired, interleaved, same-batch schedule. Nothing
   in phases 1–5 may be edited once frozen — a forced change mints a **new ticket
   version**, never an in-place edit.

6. **Shake out cheaply.** A non-gating `N=1` smoke on canaries/dev only, via the
   selected adapter. Any fix it forces mints a **new** ticket version before executing
   for real — never patch a frozen ticket to make a shakeout finding disappear.
   For the bundled adapter run `run` with `{split}=dev` and outputs under
   `<slug>/dev/`; this smoke is non-gating.

7. **Execute the registered plan.** Run both arms clean, from a clean starting state,
   per the sealed schedule, via the selected **adapter**'s run command. Retain
   everything — every attempt, error, cost, trajectory, output, and outcome; nothing is
   silently excluded from the denominator outside the ticket's error policy.
   For the bundled adapter run `run` then `grade` with `{split}=confirm`. A runner
   exit 1 still leaves complete replies: grade them and count errors per the ticket;
   bad input stops the run. Paste the per-case table for both arms into the record
   body §2/§3, retaining the grader and cases hashes printed by `grade.js` and saved
   in `grades.json`. Keep every planned case, including errors.

8. **Adjudicate independently.** Delegate to the `rstaff-ai:experiment-analyst` subagent (Task
   tool, `subagent_type: rstaff-ai:experiment-analyst`) in a **fresh context**. Pass it the frozen
   ticket, the harness certificate, and both arms' evidence. Do **NOT** judge the result
   yourself in this session — writer ≠ judge, the experiment-level analog of `/rstaff:review`.
   For the bundled adapter pass only the record path, certificate path, and
   `grades.json` path to that fresh analyst context.

9. **Decide.** Relay the analyst's mechanical verdict exactly: one of `ACCEPT | REJECT |
   INCONCLUSIVE | INVALID-HARNESS`, derived from the frozen decision table — never a
   narrative override because the aggregate "looks promising."
   For the bundled adapter print the summary below with the actual frozen ticket,
   certificate, paired counts, analyst verdict, and record path. The sample numbers
   illustrate the format; never substitute them for measured results.

   ```text
Experiment: sample-label-prompt  (ticket a3f9…, frozen 14:02)
Harness:    certified 14:01 — grader exact-match, known-fail 0/12, known-pass 12/12
Arms:       control 7/12 · candidate 11/12   (paired, same batch, N_cases=12, N_trials=1)
Analyst (fresh context): ACCEPT
  primary: exact-match +33 pts ≥ threshold +15 pts · guardrail: no case regressed
Record: ~/rstaff-home/var/experiments/sample/sample-label-prompt.md
   ```

10. **Confirm, preserve, monitor.** Where the claim calls for it, run a held-out/temporal
    confirmation. Write the full receipt into the record (provenance, dispositions,
    decision). Promote any newly-found regression cases into the regression manifest.
    Set up production monitoring for drift. State the next hypothesis. **Resume** for
    this experiment is re-opening the record and continuing from its last completed
    phase — never re-deriving the plan from memory.

## Structural refusals — what `--confirm` FORCES, not advises

`/rstaff-ai:experiment --confirm` (and the `rstaff-ai:experiment-analyst`) **refuse to proceed**, or mark the
run `INVALID-HARNESS`, when any of these hold — this is the anti-corner-cutting core,
not a checklist to talk your way past:

- No explicit decision or falsifiable hypothesis exists.
- No control arm is declared, or it wasn't run paired in the same batch as the candidate.
- No primary metric + practical threshold was frozen *before* execution.
- Candidate results already exist but the record claims to be pre-registered
  (results-before-registration).
- The holdout manifest is missing, or exposure violates the frozen ticket's
  `holdout_exposure` declaration.
- The harness certificate is missing, stale, or invalidated.
- SUT fidelity differs from the registered manifest.
- The actual candidate↔control diff exceeds the declared intervention surface
  (multi-variable creep — prompt+model+tool+temperature changed together).
- The harness / rubric / judge / cases / environment changed without re-baselining both
  arms.
- Planned cases or repeats are missing, or errors were silently excluded from the
  denominator.
- The stopping rule was changed after partial results.
- The change author is also the final adjudicator.

None of these are advisory — a `--confirm` run that hits one stops there and reports
which refusal fired; it does not proceed to execution or adjudication.

## Adapter dispatch

Read `experiment.adapters:` from `$CTRL/profiles/<repo>.md`. Each adapter entry names its run
command(s), its grader kind (code-graded / model-judged / human), its manifest/holdout
location, and its independent-judge assignment — the orchestrator invokes exactly that,
unchanged. `/rstaff-ai:eval` and other adapter commands remain directly callable outside this loop;
inside it, they are simply the measurement steps 6–7 dispatch to.

For structured entries use the reader's selection (sole entry, single default, or
explicit name); ambiguity stops with exit 2. Use the prose path only under the
explicit `--adapter` exception above.

## Relay verbatim, no praise

Report: the per-metric verdict, pass-rates with uncertainty (never "deterministic"),
the guardrail table, and the routed follow-ups (product-repo prompt/tool fix vs
adapter/harness fix vs re-declare). A red or failure left unclassified is not a pass —
it blocks `ACCEPT`. The product repo / playground gets **zero process artifacts**: the
record, ticket, and transcripts stay in `$CTRL/var`; only routed fixes land in the
product repo.
