# Sample label prompt — registration draft

Copy these fields into the experiment record and freeze before running either arm.
Resolve hashes, certificate id and timestamps at freeze time. If the model override
is used, record that resolved model id in the frozen ticket and both arms' provenance.

```yaml
repo: sample
slug: sample-label-prompt
version: 1
status: draft
lane: confirm
registered_at: <set on freeze>
registration_hash: <set on freeze>
decision: Adopt prompts/candidate.md for the sample sentiment task if ACCEPT.
risk_owner: sample operator
population/use_case: One-sentence product reviews in the public demonstration sample.
hypothesis: The candidate output contract increases exact-match rate by at least 15 percentage points.
null: The paired candidate minus control exact-match rate is below 15 percentage points.
primary_metric: Exact-match rate on split=confirm.
estimand: Paired candidate minus control exact-match rate, in percentage points.
practical_threshold: +15 pts
guardrails:
  - metric: Per-case regression count
    breach_condition: Cases control passes and candidate fails >= 1.
control: prompts/control.md
control_config_hash: <hash on freeze>
candidate: prompts/candidate.md
candidate_config_hash: <hash on freeze>
declared_intervention_surface: System-prompt file only.
N_cases: 12
N_trials_per_case: 1
randomization/interleaving: Shuffle all case x arm pairs in one batch with --seed equal to the ticket slug.
error_policy: Errors count as fail, stay in the denominator, and are never dropped; > 2 errored calls of 24 -> INCONCLUSIVE.
stopping_rule: One fixed batch of 24 calls; no retries or early stopping.
holdout_exposure: public demonstration sample; the candidate prompt was written before the cases
dataset_hashes:
  dev: <cases.jsonl hash on freeze; split=dev>
  hidden_confirmation: <cases.jsonl hash on freeze; split=confirm>
  regression: none
  temporal: none
frozen_model_provenance:
  model_id: claude-haiku-4-5-20251001
  endpoint: claude CLI on operator login
  api_version: CLI version recorded on freeze
  frozen_at: <set on freeze>
harness_certificate_id: <live certificate id on freeze>
```

The fresh experiment-analyst applies the frozen rule: missing or stale certification
or structurally invalid paired evidence yields INVALID-HARNESS. Otherwise more than
2 errored calls yields INCONCLUSIVE. With at most 2 errors, an improvement of at least
+15 pts and no regression yields ACCEPT; a smaller improvement or any regression
yields REJECT. This public demonstration supports a claim about these 12 cases only.
