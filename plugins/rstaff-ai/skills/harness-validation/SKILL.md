---
name: harness-validation
description: Load before trusting, changing, or certifying an eval runner, case, checker, rubric, judge, mirror, tool simulator, or test environment — deciding whether a grader actually catches the defect it claims to, whether a mirror/harness is faithful to the real prompt/scaffold/tool-schema/runtime/data/deployed-config, auditing a model-based judge for bias, or determining whether a harness change invalidates a prior result. Do not load it to choose which cases or splits to write (use agent-evaluation), to set a threshold or declare ACCEPT/REJECT (use experiment-design), or to debug ordinary product code (use superpowers:systematic-debugging).
---

# Harness validation — certify the instrument, not the result

The reusable judgment behind `/rstaff-ai:experiment` phase 3 (Qualify the instrument): before any
result from `rstaff-ai:agent-evaluation`'s cases and graders is allowed to feed
`rstaff-ai:experiment-design`'s decision rule, the **instrument itself** must be shown to work.
The discipline this skill draws on is `${CLAUDE_PLUGIN_ROOT}/rules/experiment.md`
("certify the instrument first" — a green report over a broken or drifted harness is
the worst outcome, because it looks like a pass) — this skill is *how you produce* the
artifact that rule requires: a harness certificate.

**Read `references/certificate-schema.md` before emitting or reading a certificate** —
it defines the exact bound-hash fields and status values step 6 depends on.

The anti-pattern it kills: reading a green or red result straight off a runner nobody
has demonstrated works — a grader that never actually fires on the defect it claims to
check, a mirror that has quietly drifted from the deployed prompt/schema/runtime, a judge
that was calibrated once and never rechecked, or a shared test environment that leaks
state between cases. Every one of these produces a plausible-looking number. None of them
is evidence.

## The one rule
**A green result over an unvalidated instrument is worse than a red — it looks like a
pass.** Certify the harness before you trust anything it reports: demonstrate the grader
catches the defect it claims to, prove the harness is faithful to what actually ships,
and re-certify whenever any of that moves. An uncertified or stale harness blocks the
gate — it does not get a pass by default.

## Certifying the instrument, piece by piece

1. **Product↔harness fidelity — beyond source equality.** The harness must match what
   actually runs in production along every axis a result could be attributed to: the
   **prompt** (not a stale copy — the exact deployed text), the **scaffold/agent loop**,
   the **tool schema** (names, argument shapes, required/optional fields — not just tool
   presence), the **runtime** (model version, decoding params, timeouts, retries), the
   **data** the case feeds in (not synthesized padding that quietly changes the ground
   truth), and the **deployed config** (feature flags, routing, region). A harness that
   is byte-identical in its own source but diverges on any of these is not faithful — the
   result it produces describes the mirror, not the product.

2. **Known-pass / known-fail fixtures.** For every grader/checker, maintain a small fixed
   set of inputs with a known correct verdict: at least one input that must pass and one
   that must fail, plus a reference (gold) solution for each. Run the grader against its
   own fixtures before trusting it against real cases. A grader that can't correctly score
   its own known-bad input is not measuring anything — it's noise wearing a rubric.

3. **Mutation & metamorphic grader tests — the core check.** A grader must be
   *demonstrated to catch the defect it claims to catch*, not assumed to. Take a known-good
   case and mutate it to introduce the exact failure the grader exists to detect (flip an
   answer, drop a required field, invert a trap, truncate the input the grader depends on)
   — then run the grader on the mutated input. **If it still passes, the grader is blind**,
   and every prior result it produced is suspect until re-derived. Metamorphic checks
   (paraphrase the input, swap presentation order, relabel arms) should not change the
   verdict when the underlying behavior hasn't changed; if they do, the grader is measuring
   something other than the claim.

4. **Environment reset / shared-state detection.** Every case must start from a clean,
   isolated state — no leftover rows, cached responses, warmed connections, or session
   state carried from a prior case or a prior arm. Prove isolation by running the same case
   twice in different positions in the schedule and confirming identical inputs produce
   consistent behavior; a result that changes with schedule position is evidence of shared
   state, not agent variance.

5. **Judge calibration + bias audits.** Any model-based judge is itself a model under
   test: check it against a human-labeled gold set (agreement rate, and which direction it
   errs — lenient or harsh, on which claim type) before trusting it to gate anything, and
   re-check whenever the judge model, prompt, or rubric changes. Audit for the standard
   biases — **position bias** (swap which arm is presented first/labeled A vs B and confirm
   the verdict doesn't flip), **verbosity bias** (a longer answer scoring higher for length
   alone), and **label leakage** (blind the arm identity from the judge; a judge that can
   see which side is "the candidate" is not independent). Repeat the judgment (N≥3) and
   report agreement, not a single call.

6. **The harness certificate — keyed to hashes, auto-invalidating.** Once 1–5 are checked,
   emit a certificate binding the hashes of everything checked: the cases/fixtures
   manifest, each grader/checker's implementation, the judge's model+prompt+decoding
   config, the tool-environment/mirror SHA, and the runtime. The certificate is **valid
   only while every bound hash matches current state** — any single hash changing (a
   grader edit, a judge prompt tweak, a mirror redeploy, a new model snapshot) makes the
   certificate `stale`/`invalidated` automatically, not by a manual revoke step
   it. See `references/certificate-schema.md` for the exact fields and status values.

7. **A harness change invalidates prior arm comparisons.** If any bound hash moves after a
   comparison has run, that comparison's result no longer transfers — it was measured
   under a different instrument. The only valid path forward is to **re-run both the
   control and the treatment arm under the new instrument**; re-running only the treatment
   and comparing it against the old control's number is comparing two different
   experiments and will misattribute the harness change to the agent.

## Does NOT own

This skill decides **whether the instrument can be trusted** — nothing about what the
evidence should contain or what counts as a valid decision:

- **What cases/splits/graders to design in the first place** → the `rstaff-ai:agent-evaluation`
  skill (dev vs hidden-confirmation vs regression vs temporal, outcome-vs-trajectory
  grading, grader-kind selection, `pass@1` vs `pass^k`). This skill certifies the
  instrument built from *that* evidence; it does not choose what evidence to collect.
- **Whether a change is framed as a valid decision, or what threshold/decision rule
  applies to a result** → the `rstaff-ai:experiment-design` skill (falsifiable hypothesis,
  contemporaneous control, practical threshold, the four result states). A certified
  instrument is a precondition for that skill's decision rule to mean anything — it is
  not the decision rule itself.

If you find yourself picking which cases to write or what the pass/fail threshold should
be while auditing a grader, stop — that work belongs to one of the two skills above, not
here.

**When a harness looks fine and you need to see how that claim fails in practice, read
`references/harness-defect-examples.md`** — three worked defects, kept as the example
of exactly the regression this skill exists to prevent.
