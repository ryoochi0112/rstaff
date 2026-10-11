# Confirmation-ticket template — the immutable pre-registration

Fill every `<…>` **before either arm runs**. Once frozen (hashed), this document
does not change — a forced revision mints a **new version**, it never edits this
one in place. This is a template, not a worked example; leave placeholders
unfilled where you don't yet have a real value — don't invent illustrative
numbers.

```
# Confirmation ticket: <repo>/<slug>/<version>
status: draft | frozen | executed | closed
lane: confirm   # always `confirm` — this artifact IS the confirmation ticket; exploration writes no ticket
registered_at: <ISO timestamp, set on freeze>
registration_hash: <hash of this file at freeze time>

## 1. Decision
decision: <what ships/changes if this ACCEPTs — e.g. "promote candidate prompt to production">
risk_owner: <who accepts the downside if this is wrong>
population/use_case: <who/what this claim applies to>

## 2. Hypothesis
hypothesis: <falsifiable, directional — "treatment increases <X> by ≥ <Δ> without worsening <Y>">
null: <what "no effect" looks like for the primary estimand>

## 3. Primary metric & estimand
primary_metric: <name>
estimand: <normally the PAIRED treatment−control difference per case, not raw treatment pass-rate>
practical_threshold: <minimum effect / non-inferiority margin the product cares about>

## 4. Guardrails (non-compensable)
guardrails:
  - metric: <e.g. safety/privacy/hallucination/destructive-tool-use>
    breach_condition: <exact trigger — any single occurrence, a rate above X, etc.>
  - metric: <...>
    breach_condition: <...>
# A guardrail breach REJECTs regardless of the primary metric result. Never averaged away.

## 5. Control arm
control: <what runs as the contemporaneous baseline — model/prompt/tool/config id>
control_config_hash: <hash>

## 6. Candidate / intervention
candidate: <what runs as the treatment>
candidate_config_hash: <hash>
declared_intervention_surface: <the ONE variable that differs from control — if the actual diff
  exceeds this, the run is invalid (multi-variable creep)>

## 7. Sample plan
N_cases: <number of distinct cases — NOT trials>
N_trials_per_case: <repeats per case, measures within-case variance, NOT independent examples>
randomization/interleaving: <how control+candidate are interleaved in one batch/time window>

## 8. Error / missing-data policy
error_policy: <how rate limits, tool failures, judge parse failures, missing transcripts are
  counted — they stay in the denominator per this policy, never silently excluded>

## 9. Stopping rule
stopping_rule: <fixed in advance — e.g. a sequential test with named alpha/power, or
  "run all N_cases × N_trials_per_case, no early stop.” NOT "stop when green.">

## 10. Provenance
dataset/split hashes: <dev / hidden-confirmation / regression / temporal manifest hashes>
candidate_config_hash: <repeat of §6, kept alongside for a single provenance block>
control_config_hash: <repeat of §5>
model/endpoint provenance: <resolved model id (not floating alias), endpoint, region,
  API version, timestamp>
harness_certificate_id: <id of the certificate from the harness-validation skill; missing/stale ⇒
  INVALID-HARNESS, do not proceed>

## 11. Lane
lane: confirm
# This artifact exists ONLY in the confirmation lane — a frozen ticket that runs once as
# registered. Exploration (diagnostic only, cannot promote) writes NO ticket; if you are still
# exploring, you are not filling this out yet.

## 12. Decision table (outcome → result state)
| Condition | Result state |
|---|---|
| Primary estimand clears practical_threshold AND no guardrail breach | ACCEPT |
| Primary estimand misses practical_threshold, OR any guardrail breach | REJECT |
| Evidence does not resolve the hypothesis at the planned N (report rate + uncertainty) | INCONCLUSIVE |
| harness_certificate_id missing/stale/invalidated, OR SUT fidelity differs from this ticket | INVALID-HARNESS |
```

## Notes for filling this in

- Do not write §3–§9 after looking at any result from either arm. If a value is
  already known from having run something, the ticket is void — start a fresh one
  and record why the prior attempt doesn't count.
- `N_cases` and `N_trials_per_case` are always both present, even if one is `1`.
  A ticket with only one of them is under-specified.
- The decision table (§12) admits exactly the four result states. Do not add a
  fifth or collapse two together to force a call.
- A version bump (new `<version>` in the ticket id) is required for *any* change
  after freeze — including a shakeout-forced fix. The old version is closed, not
  edited.

## Trials, sample, and missing data (moved from SKILL.md, items 8-10)

8. **`N_cases` vs `N_trials_per_case`, kept separate.** Running one case 5× measures
   *within-case variance* (how noisy is this one scenario), not 5 independent
   examples of the behaviour. Both numbers get pre-registered; neither substitutes
   for the other.

9. **Sample + stopping plan, fixed in advance.** Chosen from effect size,
   acceptable failure rate, risk, and cost — before the first result is read.
   Cost-aware sequential testing is fine if the rule is written down first;
   "stop when it looks green" is not a stopping rule, it's cherry-picking the
   lucky run.

10. **Error/missing-data policy.** State up front how rate limits, tool failures,
    judge parse failures, and missing transcripts are counted. They stay in the
    denominator per the policy — they are never silently dropped as
    "exclusions" after the fact.
