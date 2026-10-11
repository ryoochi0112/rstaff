# Experiment rules — controlled comparison + evidence governance — always-follow

> The discipline for running an agent/model/prompt/tool change as a **causal, pre-registered,
> harness-certified experiment**. Used by `/rstaff-ai:experiment` + the `rstaff-ai:experiment-analyst` agent; the
> general discipline that `evaluation.md` (rubric-quality measurement) sits under.

- **Control first.** Every claim needs a contemporaneous control arm, run in the same batch as
  the candidate. Last week's number is history, not a control — hosted models drift; "the old
  result is known" is not a baseline.
- **Pre-register before you run.** Hypothesis (falsifiable, directional) + primary metric +
  practical threshold + decision rule are frozen *before* execution. Results-before-registration
  is invalid — deciding the interpretation while reading results is HARKing.
- **Certify the instrument first.** No result is trusted until the harness is certified
  (product↔harness fidelity, known-pass/known-fail fixtures, grader calibration). A green report
  over a broken or drifted harness is the worst outcome — it looks like a pass. See the
  `rstaff-ai:harness-validation` skill.
- **Two lanes, never confused.** Exploration (visible dev cases, unrestricted iteration,
  diagnostic only, cannot promote) vs confirmation (frozen, hashed ticket, sealed holdout, fresh
  judge, runs once as registered). Iteration is unrestricted on dev evidence; promotion claims are
  restricted to untouched evidence.
- **Single isolated variable.** One treatment difference vs control per experiment; the actual
  diff must not exceed the declared intervention surface. Changing prompt+model+tool+temperature
  together destroys attribution.
- **Paired + interleaved, same batch.** Control and candidate run on the same cases in the same
  time window — never on different dates behind a floating model alias.
- **Report the rate, never "deterministic."** Separate `N_cases` from `N_trials_per_case`; 5/5 is
  a weak estimate of a failure rate, not determinism. Report the observed rate with uncertainty.
- **Severity ≠ reproducibility.** One valid privacy leak or destructive tool call is a blocking
  finding at 1/N. Replication estimates frequency; it never erases a rare catastrophic failure.
- **No silent exclusion.** Rate limits, tool/judge/parse failures, and missing transcripts stay in
  the denominator per the pre-registered error policy — they are not exclusions.
- **Author ≠ adjudicator.** The change author never applies the decision rule to their own
  evidence. A fresh `rstaff-ai:experiment-analyst` context does — the experiment-level analog of `/rstaff:review`.
- **The record is the receipt.** Every run writes/updates the structured record at
  `$CTRL/var/experiments/<repo>/<slug>.md` (config-under-test hashes, per-iteration rates,
  dispositions, decision) so a rerun is reproducible and a resume just re-opens it.
- **No personal data / secrets** in records or judge inputs; refer to cases/groups by id. Scan
  committed artifacts for in-file PII — a path-based data gate is blind to PII pasted inside an
  allowed file type.
- **Four result states, no others.** Every confirmatory decision is exactly one of
  `ACCEPT | REJECT | INCONCLUSIVE | INVALID-HARNESS`, derived mechanically from the frozen rule —
  never a narrative override because the aggregate "looks promising."
