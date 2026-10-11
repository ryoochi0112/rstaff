---
name: experiment-design
description: Load when turning a proposed agent/model/prompt/tool change into an attributable comparison and decision rule — writing a `/rstaff-ai:experiment` pre-registration, deciding whether a "try the new prompt" ask has a falsifiable hypothesis and a control, choosing a primary estimand/threshold, or classifying a result as ACCEPT/REJECT/INCONCLUSIVE/INVALID-HARNESS. Do not load it to pick cases, splits, or graders (use rstaff-ai:agent-evaluation), to prove a grader or judge actually works (use rstaff-ai:harness-validation), or to review ordinary code changes (use /rstaff:review).
---

# Experiment design — pre-registration, not "run it and see"

The reusable judgment behind `/rstaff-ai:experiment` phases 1, 4, 5 and 9. The discipline
this skill enforces is `${CLAUDE_PLUGIN_ROOT}/rules/experiment.md` (control-first,
pre-register-before-run, two-lanes, paired-same-batch, author≠adjudicator, four
result states) — this skill is *how you produce* the artifact that rule requires:
an immutable registration written **before** either arm runs.

**Read `references/registration-template.md` before writing a confirmation ticket** —
it is the field-by-field template this section describes, and the ticket is frozen
once written.

The anti-pattern it kills: "test the new prompt/model/tool and see if it's
better" — a request with no falsifiable claim, no control, no threshold, and no
stopping rule, where the interpretation gets picked *after* reading results
(HARKing). A green run under that regime authorizes shipping regardless of what
"green" was ever supposed to mean.

## The one rule
**If you can't write the hypothesis, the control, and the threshold before either
arm has run, you don't have an experiment — you have a demo.** Anything decided
while looking at results is not pre-registration; freeze it first, or admit the
run is exploratory and cannot promote.

## The registration, piece by piece

1. **Decision framing.** Name the actual decision this changes (ship / roll back /
   pick model A vs B), who owns the risk, and the population/use-case it applies
   to. If nothing downstream would change based on the number, it's ritual
   measurement — stop and ask why you're running it.

2. **Falsifiable directional hypothesis.** "Treatment increases X by ≥ Δ without
   worsening Y." Not "test the new prompt" — that has no failure condition. A
   hypothesis you cannot lose is not one.

3. **Contemporaneous control.** A baseline run in the *same batch, same time
   window* as the candidate — never last week's number behind a floating model
   alias. Hosted models and judges drift; "the old result is known" is not a
   control, it's history.

4. **Single-variable isolation (or a declared factorial/ablation).** One treatment
   diff vs control per experiment. If you genuinely need to vary more than one
   thing, say so explicitly and design a factorial/ablation — don't let
   prompt+model+tool+temperature move together and call it one experiment; you'll
   have a result with no attribution.

5. **Primary estimand.** Normally the **paired** treatment−control difference per
   case, not the treatment's raw pass-rate alone — a raw rate can't separate "the
   treatment is better" from "this batch of cases was easier."

6. **Practical threshold / non-inferiority margin.** The minimum effect size (or
   maximum tolerable regression) that matters to the *product*, fixed before
   execution. Statistical detectability is not product value — a significant
   0.3-point gain nobody would ship is not a threshold met.

7. **Non-compensable guardrails.** Safety, privacy, hallucination, destructive
   tool use, severe regressions. These never average away against a better
   primary metric or nicer tone — one guardrail breach blocks regardless of the
   aggregate.

8. **Trials, sample, and missing data (items 8-10)** — `N_cases` vs `N_trials_per_case`, sample + stopping plan, error/missing-data policy: see `references/registration-template.md` section "Trials, sample, and missing data".


11. **Result states — exactly four, decided mechanically from the frozen rule:**

| State | Means |
|---|---|
| `ACCEPT` | Primary estimand clears the threshold; no guardrail breach |
| `REJECT` | Primary estimand misses the threshold, or any guardrail breaches |
| `INCONCLUSIVE` | Evidence doesn't resolve the hypothesis at the planned N (report the rate + uncertainty, don't force a call) |
| `INVALID-HARNESS` | The instrument itself is uncertified/broken — worse than a red, because it looked like data |

    Never a fifth state, never a narrative override because the aggregate
    "looks promising."

12. **Provenance.** Snapshot model IDs (not floating aliases), resolved
    endpoint/region/API-version/timestamp, and config/prompt/tool-schema hashes
    for both arms. Without this, "the same experiment" run twice a week apart
    isn't — the model underneath may have moved.

## Exploration vs confirmation — the seam that keeps iteration fast

| | Exploration lane | Confirmation lane |
|---|---|---|
| Evidence | Visible dev cases | Sealed/hidden confirmation manifest |
| Iteration | Unrestricted — edit, ablate, pick the best of many | None — the ticket is frozen once registered |
| Purpose | Diagnostic only; forms the hypothesis and picks a candidate | Tests the *one* pre-registered claim |
| Can it promote? | **No** — never emits "passed" or a shipping claim | Yes — the only path to ACCEPT/REJECT |
| On a forced change | Just iterate again | Mints a **new** ticket/version; never edit the frozen one |

The one policy: **iteration is unrestricted on dev evidence; promotion claims are
restricted to untouched evidence.** If a holdout case had to be exposed to debug a
result, it is retired into dev and replaced before the next confirmatory claim —
it can never again back a promotion decision.

## Does NOT own

This skill decides **whether a change is framed as a valid decision** — nothing
about what evidence to collect or whether the instrument can be trusted:

- **What cases/splits/graders to use** → the `rstaff-ai:agent-evaluation` skill (dev vs
  hidden-confirmation vs regression vs temporal partitioning, outcome-vs-trajectory
  grading, `pass@1` vs `pass^k`, grader selection).
- **Whether the harness/judge actually measures what it claims** →
  the `rstaff-ai:harness-validation` skill (fidelity, known-pass/known-fail fixtures,
  calibration, the harness certificate).
- **Prompt wording itself** → `superpowers:systematic-debugging` for root-causing a real
  finding, and a future narrow `prompt-iteration` skill for the edit/ablate loop
  — neither chooses its own metric or declares its own success; this skill's
  frozen threshold and decision rule do that.

If you find yourself picking cases, building a grader, or wordsmithing a prompt
clause while filling out the registration template, stop — that work belongs to
one of the skills above, not here.
