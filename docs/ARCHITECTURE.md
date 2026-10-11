# Architecture

rstaff is a **virtual engineering team**, shipped as one repo with two parts:

1. **Plugins** (`plugins/`) — the portable team you install into product repos:
   role commands, on-demand subagents, methodology skills, and the always-on
   memory + security hooks. This is company-agnostic and shareable.
2. **Control repo** — this directory, marked by `rstaff.json`. Holds the operator
   state the loop reads via `$RSTAFF_HOME`: product profiles and gitignored
   working state. None of it is company-specific.

> Company/product **strategy** used to live here too. It was split into a separate
> private strategy repo on 2026-07-03 so rstaff could be a focused, shareable
> engineering team. rstaff no longer reads or writes any strategy state. *(This is
> the canonical statement of the split; other docs point here.)*

> **Design rationale** — the loop-engineering research this design draws on is
> archived at `docs/research/arch-research-260626.md`.

```
rstaff/
  rstaff.json                          # control-repo marker ($RSTAFF_HOME resolves here)
  .claude-plugin/marketplace.json      # marketplace manifest → plugin sources ./plugins/<layer>
  CLAUDE.md  AGENTS.md                  # owned host + external-agent routing
  plugins/<layer>/                     # one dir per layer: rstaff (core), rstaff-pm, rstaff-ds, rstaff-engineer, rstaff-ai, rstaff-delegation, rstaff-backlog, rstaff-usage
    .claude-plugin/plugin.json         # plugin manifest (name = the layer)
    hooks/hooks.json + *.js            # ALWAYS-ON foundation (memory + security)
    scripts/                           # collectors (health, cockpit, usage) +
                                        #   delegate.js (delegation + usage capture)
    rules/                             # always-follow conventions
    commands/                          # role commands (/spec /plan /build … /land)
    agents/                            # on-demand subagents (implementer, reviewer, …)
    skills/                            # rstaff-SPECIFIC methodology skills (parallel-build,
                                        #   grilling, experiment set); generic disciplines are
                                        #   delegated to the superpowers peer plugin
                                        #   (rules/superpowers-precedence.md)
    templates/                         # Makefile.sample (the verify contract)
  plugins/<owner>/evals/<name>-{trigger,compliance}/<case>/case.yaml # skill behavior eval suites (7-skill roster)
  profiles/<repo>.md                   # product profiles (verify/run/QA per repo) — tracked
  backlog/<repo>.md                    # per-repo ticket store — tracked
  var/                                 # gitignored: sessions/, dispatch/, specs/,
                                        #   experiments/<repo>/<slug>.md (experiment
                                        #   records), review-rounds/, codex-home/
                                        #   (delegate's own CODEX_HOME), usage.jsonl, cache, .STOP
  specs/                               # rstaff's OWN specs + ledgers — tracked
                                        #   (product-repo specs go to var/specs/)
  Makefile  install/  docs/  test/  THIRD_PARTY.md
```
Review rounds in `var/review-rounds/` stamp the reviewed tree; `/ship` and `/land` check that it is current.
The backlog parser and validator, `plugins/rstaff/scripts/lib-backlog.js`, live in
core so the completion gate and PM tools use the same implementation.
The notebook gate, `plugins/rstaff/scripts/nbgate.js`, also lives in core: the
`rstaff:nbgate` verify alias runs it, and `rstaff-ds` (analysis review) relies on it as the done signal.

## The memory spine
Always-on hooks (`plugins/rstaff/hooks/`, `plugins/rstaff-usage/hooks/`), clean-room adaptations of ECC's patterns:

- **SessionStart → `session-start.js`** injects the repo's **product profile**
  (verify/run/QA commands) as additional context (profile injection only; there are no checkpoints). It also runs a non-blocking
  **credential preflight**: warns when a dev token in the profile's `## credentials`
  section (metadata only — persona / refresh / optional `expires:`, never the value)
  is past/near expiry. No company strategy.
- The frozen review contract has reviewers read the profile's `## configuration facts` section for repo-specific reachability after SessionStart injects the profile.
- **PreToolUse(Bash) → `guard-bash.js`** denies `--no-verify`/hook-bypass as a policy guard (not a security boundary; see `SECURITY.md`); *asks*
  before clearly destructive commands.
- **PreToolUse(Skill) → `guard-skill.js`** denies oversized skill bodies in the
  coordinator, once per (session, skill) — enforcing since 2026-08-22, when a
  live coordinator probe confirmed no `agent_id`. It can only see model invocations of
  the `Skill` tool: it cannot see `/skill-name` typed by a human, and it silently
  does not fire when the main thread was started with `claude --agent <name>`.
- **PreToolUse(Write|Edit|Bash) + UserPromptSubmit → `secret-scan.js`** blocks known
  secret formats from being written, run, or sent.

### Two delivery paths (and why it matters which one a guard is on)
Guards reach a machine two ways, with **opposite freshness semantics**. The
directory a module lives in decides which, and `/rstaff:health` reports both separately —
"the plugin is current" says nothing about the second path, or vice versa.

| | plugin-delivered | worktree-delivered |
|---|---|---|
| lives in | `plugins/*/hooks/*.js` | `plugins/*/scripts/*.js` |
| invoked by | `hooks.json`, via `${CLAUDE_PLUGIN_ROOT}` | a `.git/hooks/*` shim, via `git rev-parse --show-toplevel` |
| actually runs from | `~/.claude/plugins/cache/rstaff/rstaff/<version>/` | the **working tree** |
| an edit goes live | only after a **version bump + re-install** | **immediately** |
| coverage | every session, every repo | only repos where the installer ran |

The cache is keyed by **version**, so a same-version edit is never picked up —
`claude plugin update` will answer *"already at the latest version"* while the
hooks you wrote sit unused. `session-start.js` therefore announces install drift
every session (`maintainer/lib-install.js`), and `/rstaff:health` reports it as
`installed copy current`.

Two traps this creates, both now mechanically closed:
- **`.git/hooks` is untracked**, so a fresh clone has *no* worktree-delivered
  guard at all. That is how the L16 customer-name leak reached `main` twice.
  `/rstaff:health` reports a missing shim as **FAIL**, and a foreign `pre-push` as WARN.
- **A worktree-delivered module is still copied into the plugin cache**, where
  nothing invokes it and where it silently diverges once the working tree moves.
  That stale copy greps as the real guard, so `lib-pii-guard.js` **refuses to run**
  from a `.claude/plugins/cache/` path, non-zero, preserving fail-closed.

Pinned by `test/hook-delivery.test.js`: every module in `plugins/*/hooks/` must be
wired in `hooks.json`, `hooks.json` commands must never anchor on the working tree,
and the `pre-push` shim must never reach into the cache.

**Control-repo resolution** (`lib.js → resolveHome`): `$RSTAFF_HOME` → walk up
from cwd for an `rstaff.json` → `~/.rstaff`. So when the plugin runs inside a
product repo, set `RSTAFF_HOME` to this control repo and the team reads its
profiles from here. If no control repo is found, hooks warn loudly
(silent memory loss was v1's failure mode) unless `RSTAFF_QUIET=1`.

## Backlog: the layer above a feature
`backlog/<repo>.md` is the tracked ticket store. Tickets sit **above** a feature:
`/interview` can file several falsifiable tickets with different routes, and a
selected ticket can later become a feature through `/spec`. The feature's spec
and task ledger remain below that layer in
`var/specs/<repo>/<slug>.{md,tasks.md}`. A ticket may point at a ledger; it never
becomes one.

## The `make verify` contract
Every target repo defines a single `make verify` that runs typecheck + lint +
tests + "no stray diff". It is the **only** signal that a code change is done.
`/build` implements against it; `/review` (fresh context) checks against it;
`/ship` refuses to cut a PR if it fails. Verify resolution checks the product
profile first, then `Makefile`'s `verify` target. As a third rule, when neither
exists, the core completion gate runs the PM validator,
`node '<core>/scripts/lib-backlog.js' validate`, if the control repo has
`rstaff.json`, the control repo's real path is the Git top level, and Git ignores
`var/gate/`; otherwise the PM fallback is inactive. A starter `Makefile` is generated by
`/plan`/`/build` from `plugins/rstaff/templates/Makefile.sample` when a repo lacks one.
A repo without `make` declares its verify command in its product profile.

### Structural skill lint

`test/maintainer/skill-conventions.test.js` pins `maintainer/lib-skill-lint.js`:
F1–F5 cover frontmatter/file structure, S1–S2 cover skill layout and the pinned
roster, and R1–R5 cover cross-references (peer tokens in skills/commands/agents/rules/templates plus command/skill references and concrete plugin paths in descriptions/bodies). When lint goes red, fix the artifact or consciously
edit the pinned allowlist in `lib-skill-lint.js` — never loosen a check or
regex to make a violation disappear.

The control repo's skill-eval layer stores `plugins/<owner>/evals/<name>-{trigger,compliance}/<case>/case.yaml`
for the 7-skill roster. `claude plugin eval plugins/<owner>` grades the repo plugin tree by
default, but it cannot load plugin dependencies, so it disables every sub-plugin. `make evals`
therefore runs the full sweep on a dependency-free copy of each plugin under `var/evals/tmp/`
and removes the copy afterwards. Results land in `var/evals/<plugin>/<ts>/`. The knobs are
`SKILL=<name>` (scopes one skill), `CASE=<glob>` (replaces the default case glob; needs
`SKILL`), `RUNS=<n>` (runs per case), and `KEEP_TEMP=<any non-empty value>` (keeps the copy,
even for `0`). The dependency skills (rstaff core, rstaff-pm, superpowers) are absent from this
sandbox, so trigger scores do not reflect competition from those skills. A backlog ticket tracks loading them. `/ship` has a skill-diff gate for touched skills. Native
migration is tracked in the backlog.

## Evaluating agent output (`/eval`)
`make verify` gates *code*; **`/eval`** gates a product's **agent output**. It runs that
repo's own eval harness (via its profile) and scores the results in a fresh `eval-runner`
subagent — deterministic checks + a grounded LLM judge, per-dimension `minScore`. Same
writer ≠ judge discipline as `/review`, applied to the behaviour artifact instead of the
diff; rstaff stays thin (no eval engine here — it drives the product repo's harness).
Discipline: `plugins/rstaff-ai/rules/evaluation.md`.

**`/experiment`** is the causal-comparison gate above `/eval`: a repo-agnostic
controlled-experiment orchestrator (`experiment-analyst` subagent) that pre-registers a
hypothesis, certifies the harness, and runs a two-lane baseline-vs-change comparison to a
fresh-context ACCEPT|REJECT|INCONCLUSIVE|INVALID-HARNESS decision; agent behaviour
(`behaviour-classifier` subagent) is one adapter, not the engine. Discipline:
`plugins/rstaff-ai/rules/experiment.md`.

## The eng cockpit (state from ground truth)
Deterministic Node collectors under `plugins/*/scripts/` (zero-dep, `require`
`hooks/lib.js`) recompute a dashboard rather than trusting hand-edited state:
- **`lib-state.js`** — parses the control repo's engineering state: managed repos
  (from `profiles/*.md`) and active `/dispatch` runs (from `var/dispatch/*`).
- **`cockpit.js`** — `/cockpit`'s read-only dashboard: a ranked "What to work on
  next" queue from `backlog/*.md`, active dispatch runs, captured
  Claude/delegated token use, managed repos with open PRs + last CI + last commit
  (`gh`, degrades gracefully), and the existing attention heuristic.
  `--write` caches `var/cockpit-latest.md`.
- **`usage.js`** — `/usage`'s deterministic token rollup from
  `var/usage.jsonl`, grouped by adapter, model, and role. It deduplicates stable
  session IDs, rotates the active log at 10 MiB, and caches unchanged summaries.
- **`route.js`** — resolves each ledger task's writer/reviewer/model from
  `risk`, `impl`, and `reviewer`, then persists the exact route before spawning.
- **`health.js`** — `/rstaff:health` wiring self-diagnosis (plugin registered/enabled,
  `RSTAFF_HOME` valid, hooks actually fired via the liveness marker, profiles, gh).

## Parallel build
`/plan` writes the spec + a **task ledger** to the control repo — never the product
repo (`$RSTAFF_HOME/var/specs/<repo>/<slug>.{md,tasks.md}`); `/build` detects the
ledger and runs **dispatcher mode** — a fresh `implementer` subagent per task, a fresh
`reviewer` in **task mode** (two verdicts: spec + quality), then one checkpoint commit
per task (code only, tagged `rstaff-task: <slug>/<id>`). `/dispatch <slug> …` fans this
across features, one `git worktree` + branch + `feature-runner` each, so several
features progress in parallel. Runners keep `var/dispatch/<repo>/<slug>.md` status
files (read by `/cockpit`) and stop at `ready_for_review` — humans `/review → /ship →
/land`. Resume reads the ledger from the control repo and reconciles it against the
branch's `rstaff-task` tags, so a crash never re-runs a committed task. Methodology +
formats live in `plugins/rstaff-engineer/skills/parallel-build/`. Rails map onto loop-operator's
(`docs/AUTONOMY.md`).

The review circuit breaker is `plugins/rstaff-engineer/rules/loop-brakes.md`; the `/replan`
step-back is `plugins/rstaff-engineer/commands/replan.md`.

## Model-agnostic delegation
`plugins/rstaff-delegation/scripts/delegate.js` is the zero-dep delegation core (mirrors
`lib-state.js`/`health.js`) — the *one place* that knows each external CLI's
flags: an adapter registry (`codex`, `gemini`; open to more later), pure
argv-builder + output-normalizer functions, an availability probe, a sandbox
guard (refuses `danger-full-access`), and a Node-side timeout-wrapped runner
(`spawnSync({timeout})`, which kills a hung CLI without depending on a
`timeout` binary). Two entry points call through it instead of duplicating
CLI wiring:
- **`/consult <model> [plan|diff|review|"question"]`** — a read-only,
  cross-model **advisor**. `/codex` is now a thin alias for `/consult codex`.
  Claude reconciles AGREE/DIVERGE; the external model gets no vote.
- **`/write <what> [--to <path> | --notion <parent>]`** — Claude gathers a brief
  for a human-read document, then `delegate.js gemini draft` produces the prose;
  Claude writes the file you choose today, only after approval. Notion page
  creation lands once a Notion MCP is wired.
- **`/dispatch … --impl <backend>`** / **`/build … --impl <backend>`** — the
  **executor**: a non-Claude model implements one ledger task in its own
  working tree (`delegate.js <adapter> execute`). **codex** is mechanically
  sandboxed to `workspace-write` there (`-s workspace-write -C <worktree>` — a
  `git worktree` under `/dispatch`, the repo root under `/build`'s dispatcher
  mode). It then
  hands off to the persisted independent review gate, `make verify`, and a
  checkpoint commit. Implementation
  remains explicit; review is mechanically resolved from task risk and writer.

Both gates — fresh-context review and `make verify` — are model-agnostic and
mechanically enforced, so writer ≠ reviewer is *strengthened* when an external
model writes: a different model authored the diff, so Claude's review is a
genuinely independent check, not a differently-prompted pass by the model that
wrote the code.

Codex adapters run with `--json`. `delegate.js` normalizes the final message,
thread id, and accumulated `turn.completed.usage`; every run is logged
automatically, with all-zero payloads marked unmeasured. Parsed failures never
fall back to raw JSONL. SessionEnd and SubagentStop hooks fold deduplicated Claude
usage into the same schema without storing transcript content. `/usage` and
`/cockpit` show provider-native counts without guessing dollar cost.

## Peer plugin: superpowers
rstaff is designed to run **alongside** [obra/superpowers](https://github.com/obra/superpowers),
not to replace it. superpowers owns the generic *how-to-think* disciplines
(`superpowers:test-driven-development`, `superpowers:systematic-debugging`,
`superpowers:verification-before-completion`, `superpowers:brainstorming`, …);
rstaff owns the *loop* (role commands, mechanical gates, control-repo state,
delegation, eval/experiment). v0.8.0 removed rstaff's vendored copies of the two
overlapping disciplines so the plugins compose instead of shadowing each other.
The composition contract — discipline resolution, degraded mode when superpowers
is absent, and the precedence rule that keeps superpowers' artifact paths
(`docs/superpowers/**`, `.superpowers/sdd/**`) out of product repos — is
`plugins/rstaff-engineer/rules/superpowers-precedence.md`. `/rstaff:health` reports the pairing (WARN when missing).
Subagents without the Skill tool (implementer, reviewer) carry the discipline
essence inline in their agent prompts instead.

## Status (v0.13.0)
- **Foundation:** ✅ manifests, owned CLAUDE.md/AGENTS.md, memory + security hooks,
  rules, `rstaff.json` control-repo marker, install manifest, docs.
- **Peer-plugin seam:** ✅ generic disciplines delegated to superpowers
  (`rules/superpowers-precedence.md`), vendored TDD/systematic-debugging skills removed,
  `/rstaff:health` pairing check.
- **Coding chain:** ✅ `/interview /spec /plan /build /review /replan /secaudit /qa /eval /doc /write /ship /land /research
  /consult` (`/codex` alias), the read-only `reviewer` + `eval-runner` subagents, the `make verify` contract.
- **Experiment gate:** ✅ `/experiment` — pre-registered, harness-certified causal
  comparison via the `experiment-analyst` subagent; agent behaviour
  (`behaviour-classifier`) is one adapter, not the engine.
- **Maintenance factory:** ✅ `/batch` (L1→L2→L3) + `loop-operator` subagent with
  hard rails. See `docs/AUTONOMY.md`.
- **Eng cockpit:** ✅ activation (`--install`) + `/rstaff:health`; `/cockpit` from ground truth.
- **Product intake:** ✅ `/interview` files falsifiable tickets into the tracked
  `backlog/`; `/cockpit` ranks them and SessionStart pushes only a one-line count.
- **Parallel build:** ✅ task ledgers, worktrees, two-verdict gates, resume-after-crash.
- **Strategy split:** ✅ company strategy + the Chief-of-Staff loop moved to the
  separate strategy repo (2026-07-03).
