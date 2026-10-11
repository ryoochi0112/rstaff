# Experiment record template — registration + run receipt

This file is the **structured registration + receipt** for one experiment. An
operator's `/rstaff-ai:experiment` run writes/updates it at:

```
$CTRL/var/experiments/<repo>/<slug>.md
```

— in the **control repo** (rstaff), keyed by the *target* repo and a slug for the
experiment. It is **never** written into the product tree being experimented on.

It is the receipt that makes a run **reproducible**: everything needed to redo the
comparison — hypothesis, frozen config, dataset hashes, provenance — lives here, not
in someone's memory or a chat transcript. A **resume is re-opening this file**: pick
up at the phase it last recorded, don't re-derive the plan from scratch.

Refer to cases, groups, and datasets **by id/hash only**. **No personal data, no
secrets** in this record or in any judge input it references — not a name, not a
free-text quote, not a company name. Scan every artifact this record points to
(transcripts, dispositions, provenance dumps) before committing it: a path-based
data gate is blind to PII pasted inside an allowed file type.

This is a template. Every `<…>` is a placeholder — leave it unfilled rather than
inventing an illustrative value. Do not fill §§ Front-matter after either arm has
produced a result (results-before-registration voids the ticket — start a new
version instead).

---

## Front-matter — the immutable confirmation ticket

This block **is** the confirmation ticket: the exact fields `/rstaff-ai:experiment` hashes at
freeze time. Its authoritative field-by-field description lives in
`${CLAUDE_PLUGIN_ROOT}/skills/experiment-design/references/registration-template.md` — **that**
template defines what each field means and how to fill it; this front-matter simply
carries the same frozen ticket alongside its run receipt so the two never drift
apart. If a field here needs explaining, read the field there — don't duplicate the
prose here.

```yaml
# --- identity ---
repo: <target repo>
slug: <experiment slug>
version: <ticket version — a version bump on any post-freeze change, never an in-place edit>
status: draft | frozen | executed | closed
lane: confirm   # this record is written only once a candidate is promoted into the confirm lane
registered_at: <ISO timestamp, set on freeze>
registration_hash: <hash of the confirmation ticket at freeze time>

# --- decision (ticket §1) ---
decision: <what ships/changes if this ACCEPTs>
risk_owner: <who accepts the downside if this is wrong>
population/use_case: <who/what this claim applies to>

# --- hypothesis (ticket §2) ---
hypothesis: <falsifiable, directional claim>
null: <what "no effect" looks like for the primary estimand>

# --- primary metric & estimand (ticket §3) ---
primary_metric: <name>
estimand: <normally the paired treatment−control difference per case>
practical_threshold: <minimum effect / non-inferiority margin>

# --- guardrails (ticket §4, non-compensable) ---
guardrails:
  - metric: <e.g. safety/privacy/hallucination/destructive-tool-use>
    breach_condition: <exact trigger>
  - metric: <...>
    breach_condition: <...>

# --- control arm (ticket §5) ---
control: <what runs as the contemporaneous baseline>
control_config_hash: <hash>

# --- candidate arm (ticket §6) ---
candidate: <what runs as the treatment>
candidate_config_hash: <hash>
declared_intervention_surface: <the ONE variable that differs from control>

# --- sample plan (ticket §7) ---
N_cases: <number of distinct cases, NOT trials>
N_trials_per_case: <repeats per case>
randomization/interleaving: <how control+candidate are interleaved in one batch/time window>

# --- error / missing-data policy (ticket §8) ---
error_policy: <how rate limits, tool failures, judge parse failures, missing transcripts are counted>

# --- stopping rule (ticket §9) ---
stopping_rule: <fixed in advance>

# --- provenance / datasets (ticket §10) ---
holdout_exposure: <declared exposure and candidate/cases chronology>
dataset_hashes:
  dev: <hash>
  hidden_confirmation: <hash>
  regression: <hash>
  temporal: <hash>
frozen_model_provenance:   # the INTENDED model/endpoint frozen at registration — pin snapshot ids, not floating aliases
  model_id: <resolved snapshot model id, NOT a floating alias>
  endpoint: <endpoint / region>
  api_version: <version>
  frozen_at: <ISO timestamp>
harness_certificate_id: <id from the harness-validation skill — missing/stale ⇒ INVALID-HARNESS>

# --- decision table (ticket §12) — the frozen rule the experiment-analyst applies mechanically ---
# | Condition                                                                 | Result state    |
# | Primary estimand clears practical_threshold AND no guardrail breach       | ACCEPT          |
# | Primary estimand misses practical_threshold, OR any guardrail breach      | REJECT          |
# | Evidence doesn't resolve the hypothesis at planned N (rate + uncertainty) | INCONCLUSIVE    |
# | harness cert missing/stale, OR any §6 structural-validity failure         | INVALID-HARNESS |
```

---

## Body — the run receipt

Everything below is appended/updated as the loop executes (spec §3 phases 6–10). It
never edits the frozen front-matter above — a forced change to the ticket mints a
new `version`, closes this record, and opens a fresh one.

### 1. Shakeout log (phase 6)

Non-gating `N=1` smoke on dev/canaries only. Any change this forces bumps the
ticket `version` — record why here, then re-freeze before executing.

```
<date> — shakeout finding: <what broke> → <fix> → new version: <version>
```

### 2. Per-iteration evidence (phase 7 execution)

One entry per executed batch. Report the **rate with uncertainty** — `N_cases` and
`N_trials_per_case` are always reported separately; never collapse a small `N` into
"deterministic."

```
#### Iteration <n> — <ISO timestamp>

- N_cases: <n>   N_trials_per_case: <n>
- control pass-rate: <x/y> (<rate>, <uncertainty e.g. CI or SE>)
- candidate pass-rate: <x/y> (<rate>, <uncertainty>)
- paired estimand (candidate − control): <value ± uncertainty>
- guardrail results: <per-guardrail pass/breach, with counts — never averaged away>
- excluded-from-denominator: <none, per error_policy — list anything that WOULD have
  been excluded and why it is NOT, or state "none">
```

### Per-case results

Retain both arms for every planned case, including errors counted under the ticket's
policy. Copy scores/statuses from the grading evidence; no silent exclusions.

| case id | split | control | candidate |
|---|---|---|---|
| `<case-id>` | `<dev or confirm>` | `<score/status>` | `<score/status>` |

grader hash: `<grades.json hashes.grader>`
cases hash: `<grades.json hashes.cases>`
certificate: `<certificate path>`

### 3. Per-failure dispositions

Every failing case/trial gets one row. No silent exclusions.

| case id | run id | arm (control/candidate) | disposition | evidence pointer |
|---|---|---|---|---|
| `<case-id>` | `<run-id>` | `<arm>` | `<real regression \| known-flake-with-rate \| harness-defect \| judge-error \| guardrail-breach>` | `<path/hash/transcript-id — no PII>` |

### 4. Provenance

```yaml
code_shas:
  control: <sha>
  candidate: <sha>
model_provenance:
  control:
    model: <resolved model id, not a floating alias>
    endpoint: <endpoint>
    region: <region>
    api_version: <version>
  candidate:
    model: <resolved model id>
    endpoint: <endpoint>
    region: <region>
    api_version: <version>
run_window: <start ISO timestamp> – <end ISO timestamp>
request_ids: <list or pointer to a log of per-call request ids — no PII>
cost: <total cost, currency + units, split control/candidate if known>
```

### 5. Decision (phase 9)

Applied by a **fresh `rstaff-ai:experiment-analyst` context**, never the change author.

```yaml
result: ACCEPT | REJECT | INCONCLUSIVE | INVALID-HARNESS
derivation: <mechanical trace from the frozen decision table (ticket §12) to this
  result — which condition matched, with the actual numbers plugged in>
adjudicated_by: experiment-analyst
adjudicated_at: <ISO timestamp>
```

### 6. Confirm / preserve / monitor (phase 10)

- held-out/temporal confirmation: `<pointer / result, or "not yet run">`
- regression cases promoted: `<list of case ids added to the regression manifest, or "none">`
- production monitor: `<what was set up to watch for drift/regression, or "none yet">`
- next hypothesis: `<what this result motivates trying next, or "none">`

### 7. Resume pointer

```
last completed phase: <0–10, per specs/experiment-loop.md §3>
next action: <what re-opening this record should do next>
```
