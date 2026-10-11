# Splits and graders — reference companion to `../SKILL.md`

Load-bearing detail for two decisions the skill body only summarizes: how the four-way split is
built and policed, and which grader kind a given claim actually needs.

## The split policy

| Split | Contains | Who can see it | Iteration policy |
|---|---|---|---|
| **Dev** | Representative + adversarial + sliced cases the author writes and debugs against; the motivating failure(s) that prompted the change | The change author, unrestricted | Edit, ablate, add, remove, pick the best of many — freely. Produces **no** shipping claim; a dev-only green never authorizes an `ACCEPT`. |
| **Hidden-confirmation** | A sealed manifest of cases (often overlapping in *kind* with dev, but distinct in *instance*) reserved for the one confirmatory run | Sealed from the change author until after the confirmation run executes; visible only to the fresh adjudicator (`rstaff-ai:experiment-analyst`) | None during design/iteration. Runs **once, as registered**, per confirmation ticket. |
| **Regression** | Permanent cases seeded from real production failures/incidents, past confirmed findings, and prior fixed regressions | Visible to everyone; part of every run going forward | Append-only in spirit — cases are added when a real failure is found; a case is not silently deleted because it currently passes (that erases the ability to detect the regression coming back) |
| **Temporal** | A fresh slice of cases/inputs drawn *after* the candidate is frozen — new user inputs, new time window, ideally cases nobody (author or model) has been exposed to | Same access rules as hidden-confirmation once drawn | Drawn fresh per confirmation cycle; cannot be reused verbatim across cycles or it becomes a second hidden-confirmation set with the same leakage risk |

### Access rules (the mechanics that make the split real, not just labeled)

- **The confirmation manifest is sealed from the change author.** The person iterating on the
  prompt/model/tool does not get to read the hidden-confirmation cases before or during
  iteration — if they can, "hidden" is fiction and every confirmatory pass is really a dev pass
  wearing a label.
- **An exposed holdout case is retired, not reused.** If a hidden-confirmation or temporal case
  has to be shown to someone (to debug a surprising result, to explain a red to the team), it is
  removed from that split and moved into dev, and a **new** case is written to replace it before
  the next confirmatory claim. It can never again back a promotion decision — once seen, it's
  contaminated for that purpose permanently.
- **Hash every manifest.** Each split's case list (ids + content, or a content hash per case) is
  hashed at registration time. The confirmation ticket records the hash. This is what makes "the
  same experiment run twice" verifiable — if the hidden-confirmation manifest hash differs between
  two runs claimed to be the same experiment, they aren't.
- **Semantic dedup across splits, not just exact-match dedup.** Two cases with different wording
  that exercise the same underlying scenario (same tool call, same edge condition, same intent
  paraphrased) count as the *same* case for split-assignment purposes. A dev case and a
  hidden-confirmation case that are near-paraphrases of each other leak the confirmation set
  through the back door — the author effectively saw (and optimized against) the confirmation
  case's substance even though the exact string differs. Check for this at design time: cluster
  cases by scenario/intent, not by literal text, before assigning them to splits.

## Grader-choice decision table

Rows are the *type of claim* a case is making. Columns are the grader kind, what evidence it must
be fed, and which estimand (`pass@1` vs `pass^k`) usually applies to that claim type. Always try
the leftmost applicable grader kind first — deterministic where it can possibly work, before
reaching for a judge.

| Claim type | Deterministic | Model-based judge | Human | Feed it | `pass@1` vs `pass^k` |
|---|---|---|---|---|---|
| **Format / ID / schema / secret-leakage** | Yes — regex/schema validation, ID-format check, PII/secret scanners, non-empty/no-raw-error checks | Rarely needed — deterministic checks structurally cover this | Only to write/update the pattern list | The raw output string/structured field | `pass@1` unless the leak is safety-adjacent (then `pass^k`, see safety row) |
| **Factual / grounded** (does the claim match the source data) | Partial — exact-value lookups against a known ground-truth table | Yes, when the claim is free text that must match retrieved evidence not just a literal string | To adjudicate ambiguous grounding calls near the judge's own uncertainty band | The output **plus the actual retrieved/tool evidence it should be grounded in** (never grade groundedness against the output alone) | `pass@1` typically; `pass^k` if the product promises the fact is always checked before stating it |
| **Task-completion / tool-outcome** (did the booking/update/send actually happen) | Yes, and this should be the primary check — query/inspect the **final environment state** (DB row, sent-mail log, created ticket) directly | Optional secondary — judge the trajectory (tool call order/args) for *how* it got there, never as the sole pass signal | Rarely, except spot-auditing tool-argument correctness on ambiguous cases | Final environment/tool state **plus** the full trajectory (tool calls, args, order) — never the agent's narration alone | `pass^k` whenever the task is "must complete every time it's requested" (irreversible or user-blocking); `pass@1` for best-effort/assistive tasks |
| **Quality / tone** (helpfulness, clarity, style) | No — this is exactly what deterministic checks can't see | Yes — the canonical use case for a model-based judge, per `rules/evaluation.md` (N≥3 to gate) | To calibrate the judge against a gold set, and to break ties near threshold | The output, the conversational context, and the rubric; grounded in retrieved evidence where the rubric references facts | `pass@1` with N≥3 judge repeats reported as a distribution, not a single verdict |
| **Safety / privacy** (refusal correctness, PII exposure, destructive action guardrails) | Partial — known-pattern PII/secret scanners, known destructive-tool-call blocklists | Only as a secondary/shadow signal — never the sole gate for a safety claim | Yes — safety-adjacent judgments are exactly where a human check (or human-calibrated deterministic rule) belongs; treat this as **non-compensable** | Full trajectory + final state + the specific policy/rule being tested against | `pass^k` (consistency) almost always — a safety guarantee that only holds "usually" is not the guarantee the product needs; severity ≠ reproducibility still applies (one breach is a blocking finding at 1/k, not averaged away) |

Notes on reading the table:

- **"Deterministic: Yes" does not mean "skip a judge forever."** It means try the deterministic
  check first; add a judge only for the residual the deterministic check can't structurally see
  (e.g. a schema check catches malformed IDs but not whether the *right* ID was chosen for the
  *right* reason — that residual may still need a judge or a final-state check).
  Cheapest-that-works is a floor, not a ceiling — combine checks when a claim has multiple facets.
- **Task-completion is the row most often graded wrong.** The most common evidence-design bug is
  grading the agent's *sentence* about the outcome instead of the outcome itself. If a case's
  grader only inspects the model's final text response for a task-completion claim, it is not
  measuring task completion — it is measuring narration quality, and a confidently-wrong or
  confidently-successful-sounding agent will pass it every time.
- **Safety/privacy rows are gates, not scores.** Never let a safety-row result be blended into an
  aggregate quality metric; it either blocks or it doesn't, independent of how well everything
  else scored.

## Further evidence rules (moved from SKILL.md, items 6-8)

6. **Non-compensable gates.** Safety, privacy, and destructive-tool-use checks are gates, not
   metrics — they never get averaged into an aggregate pass rate alongside quality/tone scores. A
   93% overall pass rate next to one leaked PII case is not "93% good with one outlier"; it's a
   failing suite. (Mirrors `rules/experiment.md`'s non-compensable-guardrail bullet, applied at the
   evidence-design layer: design the case so the breach is a hard fail flag, not an averaged-in
   sub-score.)

7. **Human calibration against a gold set.** Any model-based judge must be checked against a small
   human-labeled gold set before it's trusted for gating — agreement rate, direction of
   disagreement (is the judge lenient or harsh, and on what claim type), and re-checked whenever
   the judge model, prompt, or rubric changes. A judge that was calibrated once, a model version
   ago, is an uncalibrated judge.

8. **Production-feedback promotion.** A real failure found in production (an incident, a customer
   report, a red from live monitoring) gets turned into a **regression case** and promoted into
   the permanent suite — with the failing input, the correct expected outcome, and enough context
   to reproduce it in the harness. This is how the suite's coverage compounds instead of staying
   frozen at whatever the original case-writer thought to test.
