# Harness certificate — template

Fill every `<…>`. This is a template, not a worked example; leave placeholders
unfilled where you don't yet have a real value — don't invent illustrative numbers or
hashes. A certificate is only meaningful when every bound hash is the actual current
hash of the thing it names.

```
# Harness certificate: <repo>/<harness-or-adapter-name>/<version>
status: valid | stale | invalidated
certified_at: <ISO timestamp of the check that produced this certificate>
certified_by: <who/what ran the certification — a person, or the automated check>

## 1. Bound hashes
# The certificate is valid ONLY while every hash below matches current state.
# Any single mismatch flips `status` to `stale` (not yet re-certified) or
# `invalidated` (checked and found to have changed the verdict).
cases_manifest_hash: <hash of the case/fixture set the graders run against>
graders:
  - name: <grader/checker id>
    impl_hash: <hash of the grader's implementation/config>
  - name: <...>
    impl_hash: <...>
judge:
  model: <resolved model id, not a floating alias>
  prompt_hash: <hash of the judge prompt/rubric text as actually delivered>
  decoding_params_hash: <hash of temperature/top_p/max_tokens/etc.>
tool_env_or_mirror_sha: <SHA of the tool-environment/mirror snapshot the harness runs against>
runtime_hash: <hash of the runtime — scaffold/agent-loop version, timeouts, retries>

## 2. Fixtures that passed
known_pass_fixtures:
  - id: <fixture id>
    result: pass | fail
# ALL known-pass fixtures must show `pass`, or status cannot be `valid`.
known_fail_fixtures:
  - id: <fixture id>
    result: caught | missed
# ALL known-fail fixtures must show `caught` (i.e. the grader correctly flagged the
# planted defect), or status cannot be `valid`. A `missed` entry means the grader is
# blind to that defect class — see harness-defect-examples.md for what this looks
# like in practice.
mutation_metamorphic_tests:
  - case: <the known-good case that was mutated>
    mutation: <the defect introduced — e.g. flip answer, drop required field, invert trap>
    expected: fail
    observed: <pass | fail>
  - case: <...>
    metamorphic_check: <paraphrase | position-swap | relabel-arms>
    expected: <verdict unchanged>
    observed: <unchanged | changed>

## 3. Judge calibration + bias audit
gold_set_agreement_rate: <agreement rate vs a human-labeled gold set>
judge_error_direction: <lenient | harsh | none-detected — and on which claim type>
position_bias_check: <pass | fail — verdict unchanged when arm order/label is swapped>
verbosity_bias_check: <pass | fail — longer-but-not-better answer doesn't win>
label_blinding: <blinded | not-blinded — was arm identity hidden from the judge>
repeated_judgment_N: <N ≥ 3 repeats> 
repeated_judgment_agreement: <agreement rate across the N repeats>

## 4. Environment reset / isolation
reset_check: <pass | fail — same case run twice at different schedule positions
  produces consistent behavior; a mismatch indicates shared state, not agent variance>

## 5. Invalidation triggers
# Which hash changes automatically void this certificate. List explicitly so a
# re-run of `make verify`/CI can check mechanically rather than by memory.
invalidates_on_change_of:
  - cases_manifest_hash
  - any graders[].impl_hash
  - judge.model / judge.prompt_hash / judge.decoding_params_hash
  - tool_env_or_mirror_sha
  - runtime_hash

## 6. Scope
applies_to: <which experiment(s)/ticket(s) this certificate is bound to>
```

## Notes for filling this in

- `status: valid` requires **every** known-pass fixture to pass, **every** known-fail
  fixture to be caught, **every** mutation test to show `observed: fail` (matching
  `expected: fail`), and every metamorphic check to show `observed: unchanged`. One
  failure anywhere in §2 or the mutation tests in §1's row means the certificate cannot
  be `valid` — fix the grader/mirror/judge and re-certify, don't mark it valid with a
  caveat.
- A certificate with `status: stale` means a bound hash changed since `certified_at` and
  it has not yet been re-run — treat it as `INVALID-HARNESS` for gating purposes until
  re-certified, exactly the same as `invalidated`.
- Per `rules/experiment.md` and `rstaff-ai:harness-validation`'s own rule: a harness change
  invalidates prior arm comparisons. If any hash in §1 changes after a comparison ran,
  that comparison's result does not transfer forward — both control and treatment must
  be re-run under the new instrument before the result can be trusted again.
