# Evaluation rules (code graders and model judges) — always-follow

> The discipline for scoring **agent-generated output**. Used by `/rstaff-ai:eval` and the
> `rstaff-ai:eval-runner` subagent. rstaff dispatches the target repo's declared adapter.

- **Writer ≠ judge.** The output's author never scores it. `/rstaff-ai:eval` delegates to
  a fresh `rstaff-ai:eval-runner` context, which runs the declared code grader or judges
  model-graded output.
- **Code graders are authoritative.** Run the adapter's `grade` command on the supplied
  replies. Report per-case pass/fail and the score against `minScore`; do not add model
  judgement. A missing `minScore` or unavailable grade output is FAIL/blocked.
- **A rubric defines a model score.** Each model-graded metric needs a written rubric,
  scale, and `minScore` gate. No rubric → no score. Rubrics live with the harness in the
  product repo, not in the control repo.
- **Hybrid: deterministic first, judge second.** For model-graded adapters, run stable
  checks always (format, ID/secret leakage, non-empty, no raw error). Add a judge only
  for dimensions deterministic checks cannot measure (quality, groundedness, tone).
- **Ground the judge in evidence, not vibes.** When the claim is that output misrepresents
  data, give the judge actual tool results or other ground truth and score against them.
  An ungrounded quality score is an opinion, not a gate.
- **One judge run is noisy — N≥3 to gate.** For model-graded gating decisions near a
  threshold, score at least three times and report the distribution and variance.
- **Protect personal data and secrets.** Never put them into judge inputs or committed
  artifacts. Mask identity, keep raw run outputs local-only (gitignored), and scan
  committed artifacts for in-file personal data; a path-based gate cannot detect data
  pasted inside an allowed file type. A 2026-07-21 review found a report nearly carried
  personal records into git.
- **Report the verdict, not praise.** Give per-case results or per-dimension scores,
  PASS/FAIL against `minScore`, and failing case ids with evidence. A below-threshold
  score is FAIL; “the eval passed” needs the actual numbers as a receipt.
- **The harness lives in the product repo; rstaff drives it.** `/rstaff-ai:eval` invokes
  the repo's own eval harness through its adapter. rstaff holds the discipline, not an
  eval engine.
