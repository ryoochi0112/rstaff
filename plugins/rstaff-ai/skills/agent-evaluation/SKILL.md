---
name: agent-evaluation
description: Load when designing or revising the evidence used to measure an agent's capability, reliability, safety, or cost — choosing what cases to write, how to split dev vs hidden-confirmation vs regression vs temporal data, whether to grade the final output or the trajectory/outcome, which grader (deterministic/model/human) a claim needs, or whether a result needs `pass@1` or "must work every time" (`pass^k`). Do not load it to set a pass/fail threshold or declare a result (use rstaff-ai:experiment-design), to prove a grader catches the defect it claims to (use rstaff-ai:harness-validation), or to run one already-designed rubric scoring pass (use /rstaff-ai:eval).
---

# Agent evaluation — evidence design, not just scoring

The reusable judgment behind `/rstaff-ai:experiment` phases 2 and (feeding into) 8: **what evidence is
appropriate to collect** before anyone scores anything. The discipline this skill draws on is
`${CLAUDE_PLUGIN_ROOT}/rules/experiment.md` (two lanes, paired-same-batch, severity ≠
reproducibility, no-silent-exclusion) — this skill is *how you build* the cases, splits, and
graders that rule's evidence requirements assume already exist.

The anti-pattern it kills: a case suite that is really "the five examples that motivated the
prompt change," scored by whatever judge was easiest to wire up, read only for what the agent
*said* it did. That suite cannot generalize, cannot catch a class of failure it never sampled,
and cannot tell "the agent claimed success" from "the world actually changed."

## The one rule
**Coverage before scoring, outcome before text, cheapest-grader-that-works before a judge.** If
you can't say which capability/failure-mode a case exercises, which split it lives in, and what
in the *environment* (not the transcript) would prove it passed, you don't have evidence yet —
you have a transcript.

## Designing the evidence

1. **Capability + failure-mode coverage.** Enumerate what the agent must be able to do (its
   capabilities) and the ways it's known or suspected to fail (its failure modes) — normal use,
   edge cases, adversarial inputs, and the failure classes a prior incident or triage surfaced.
   A suite with only representative "happy path" cases cannot detect a regression that only shows
   up under an edge case; a suite with only motivating-bug cases cannot show the fix generalizes.
   Cases should be **representative** (typical real use), **adversarial** (deliberately probing
   for the failure, including prompt-injection/jailbreak-shaped inputs where relevant), and
   **sliced** (grouped by a dimension you'll report separately — language, tool availability,
   input length, user role — because an aggregate pass rate hides a slice that's failing 100%).

2. **The four-way split + why each exists.**
   - **Dev** — visible, unrestricted iteration; where you write cases, debug, and pick a
     candidate. Never used to back a promotion claim.
   - **Hidden-confirmation** — sealed from the change author; the only evidence a confirmatory
     `ACCEPT`/`REJECT` may cite.
   - **Regression** — permanent cases seeded from real production failures and past incidents;
     grows over time; never removed just because it currently passes.
   - **Temporal** — a fresh slice drawn *after* the candidate was frozen, so a result can't be an
     artifact of a case set the candidate (or its authors) has effectively seen.
   **Read `references/splits-and-graders.md` before building or auditing a split** — it holds
   the full split policy, the access rules, and the semantic-dedup requirement across splits.

3. **Outcome-vs-trajectory grading.** An agent *saying* "booking succeeded" or "I updated the
   record" is not evidence a booking exists or a record changed — it's evidence the agent
   produced that sentence. Grade the **final environment/tool state** (was the row written, was
   the email actually sent, does the ID resolve) as the primary signal for any task-completion
   claim; use the **trajectory** (which tools were called, in what order, with what arguments) as
   a secondary signal for *how* it got there — useful for diagnosing a wrong-but-lucky pass or a
   right-but-fragile path. A case that only checks the output string can be gamed by an agent that
   narrates success without doing anything.

4. **Grader selection — cheapest that works, first.** Prefer, in order: **deterministic** checks
   (format, ID/schema validity, secret/PII leakage, tool-call presence and arguments, final-state
   assertions) → **model-based judges** (quality, tone, groundedness — only for what deterministic
   checks structurally can't see) → **human** (safety-adjacent or genuinely subjective judgments,
   and to calibrate the model-based judge itself). Don't reach for an LLM judge to check something
   a regex or a DB query could check for free and without judge noise/drift. **When the right
   grader kind isn't obvious, read the decision table in `references/splits-and-graders.md`** —
   claim-type → grader-kind → what-to-feed-it.

5. **`pass@1` vs consistency (`pass^k`).** `pass@1` (does it work this one time) is the right
   estimand for exploratory/best-effort tasks where an occasional miss is tolerable and the user
   can retry. Where the product requirement is "must work every time this comes up" — a
   destructive action, a safety-relevant refusal, an irreversible external side effect —
   the correct estimand is **consistency**: the agent must pass on **every** repeated trial of the
   same case (`pass^k`, k repeats), not just once. Choosing `pass@1` for a must-work-every-time
   claim silently downgrades the guarantee the product is actually relying on.

6. **Further evidence rules (6-8)** — non-compensable gates, human gold-set calibration, production-feedback promotion: see `references/splits-and-graders.md` section "Further evidence rules".


## Seam vs `rules/evaluation.md` — read both, they compose

`rules/evaluation.md` governs **one execution pattern**: grounded deterministic checks running
first, an LLM judge second, scoring *generated output* the writer didn't score themselves (writer
≠ judge), with N≥3 judge runs to gate. It assumes the cases, splits, and grader choice already
exist and tells you how to run that one scoring loop correctly.

This skill governs **which evidence is appropriate to collect in the first place**: what
capabilities/failure-modes the suite must cover, how cases are partitioned into dev/
hidden-confirmation/regression/temporal, whether the claim needs outcome or trajectory evidence,
whether the claim even needs a model-based judge at all (deterministic and human are equally valid
answers), and whether a `pass@1` or a `pass^k` claim is the one the product actually needs. Task
construction and split design are broader than "how do I run an LLM judge" — a suite can use
`evaluation.md`'s exact scoring pattern for every case and still be worthless evidence because the
cases leaked from dev to confirmation, or because every case only checked the output text against
a task that actually required a real tool-state outcome.

They compose, not overlap: this skill decides what cases exist, what split they live in, and what
kind of grader a given claim needs; when the answer is "a model-based judge scoring generated
output," `rules/evaluation.md` (and `/rstaff-ai:eval`/`rstaff-ai:eval-runner`) is the pattern that runs it.

## Seams vs its two peer skills

- **`rstaff-ai:experiment-design`** owns whether a change is framed as a valid decision at all: the
  falsifiable hypothesis, the contemporaneous control, the **practical threshold** and the
  mechanical `ACCEPT`/`REJECT`/`INCONCLUSIVE`/`INVALID-HARNESS` decision rule. This skill feeds it
  evidence; it does **not** pick the metric's pass/fail threshold or declare the result — that's
  `rstaff-ai:experiment-design`'s frozen decision rule.
- **`rstaff-ai:harness-validation`** owns whether the instrument built from this evidence can be trusted:
  product↔harness fidelity, known-pass/known-fail fixtures, mutation/metamorphic grader tests,
  environment reset/isolation, and the harness certificate. This skill does **not** certify that a
  grader actually catches the defect it claims to, or that the mirror matches production — that's
  `rstaff-ai:harness-validation`'s job, run against the splits and graders this skill designed.

If you find yourself picking a pass/fail threshold or declaring a result while writing cases, stop
— that's `rstaff-ai:experiment-design`. If you find yourself asking "does this grader actually work / is the
harness faithful to production," stop — that's `rstaff-ai:harness-validation`.
