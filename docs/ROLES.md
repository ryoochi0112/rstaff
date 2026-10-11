# The team (roster)

Each role is **invoked on demand** (a command and/or a fresh subagent), never an
always-loaded persona. Sourcing notes show where the pattern comes from (see
`THIRD_PARTY.md`). rstaff is an **engineering** team; company strategy lives in the
separate strategy repo. Generic engineering disciplines (TDD,
systematic-debugging, verification-before-completion, brainstorming) are not
roles and not rstaff skills — the roles invoke them from the **superpowers peer
plugin** per `plugins/rstaff/rules/peer-plugins.md`.

| Role | Command | Does | Sourced from |
|---|---|---|---|
| **Product / PM** | `rstaff-pm` — `/rstaff-pm:interview`; fresh `rstaff-pm:critic` review | Turns a fuzzy idea into filed, falsifiable tickets: grill, adversarially test the load-bearing assumptions, show the proposal, then file only after explicit confirmation. | Reuses mattpocock `grilling`; adds the adversarial pass and critic |
| **Product / PM** | `rstaff-pm` — `/rstaff-pm:spec`; fresh `rstaff-pm:critic` review | Interrogates a rough feature idea into a one-page spec with explicit acceptance criteria — one question at a time, exploring the codebase instead of asking answerable questions. | gstack `office-hours`; mattpocock `grilling`; critic checks the criteria |
| **Data scientist** | `rstaff-ds` — `/rstaff-ds:review`; fresh `rstaff-ds:analysis-reviewer` review; `data-science` skill | Reviews an analysis notebook against a data-science checklist in a fresh context. Its done signal is the core `rstaff:nbgate` verify alias (`plugins/rstaff/scripts/nbgate.js`): run-order check plus a fresh-kernel run in a temporary copy. Needs Node ≥ 22.5 and a Python with `nbconvert` + `ipykernel`. | rstaff-original |
| **Eng Manager** | `/design` | Locks architecture before code: data flow, edge cases, failure modes, test matrix, the `make verify` DoD, and a task ledger. | gstack `plan-eng-review`; ECC `planner`/`architect` |
| **Implementer** | `/build`, `implementer` subagent | Implements a spec to the DoD; stops at `make verify` green. In dispatcher mode, one fresh `implementer` subagent per ledger task. | gstack `spec`; claude-skills `spec-driven-workflow`; Superpowers SDD |
| **Dispatcher** | `/dispatch`, `feature-runner` subagent | Runs several planned features in parallel (worktree + branch + runner each); each runner drives its ledger through implementer + task-mode review + checkpoint commits. Stops at `ready_for_review`. | Superpowers SDD + gstack checkpoints |
| **Reviewer** | `/review`, `reviewer` subagent | **Fresh-context, blocking-only** review of the diff vs spec + DoD. Writer ≠ reviewer. Task mode = two verdicts (spec + quality) per ledger task; whole-branch mode at ship. | claude-skills `pr-review-expert`; Superpowers two-verdict gate |
| **Loop brake** | `/replan` | Re-derives a stalled review loop from first principles in a fresh context; writes a new control-repo plan/ledger or asks a forcing question. Never implements. | rstaff loop-brakes protocol; efficiency harness evidence |
| **Security** | `/secaudit` | Deeper OWASP/secret/trust-boundary pass at PR time (the inline secret-scan hook is the cheap always-on layer). | gstack `cso` / ECC `security-reviewer` |
| **QA** *(optional)* | `/qa` | Drives a real browser to test a running app; files/fixes bugs. Needs a web UI. | gstack `browse`/`qa` |
| **Evaluator** | `/eval`, `eval-runner` subagent | **Fresh-context, blocking** scoring of agent-generated *output* against a rubric (deterministic checks + grounded LLM judge); per-dimension `minScore` gate. Writer ≠ judge. Drives the product repo's own eval harness via its profile. | a product repo's agent-evals loop |
| **Experimenter** | `/experiment`, `experiment-analyst` subagent | Repo-agnostic **controlled-experiment orchestrator**: pre-registers a hypothesis, certifies the harness, runs a two-lane comparison (baseline vs change), and hands back a fresh-context **ACCEPT \| REJECT \| INCONCLUSIVE \| INVALID-HARNESS** decision. `skills/experiment-design`, `skills/agent-evaluation`, and `skills/harness-validation` carry the methodology; agent behaviour (`behaviour-classifier` subagent, `skills/behaviour-triage`) is one adapter of it, not the whole thing. | Generalized from an agent behaviour-experiment loop |
| **Release Manager** | `/ship`, `/land` | Syncs, runs the gate, bumps version/CHANGELOG, opens the PR; `/land` merges + verifies prod. | gstack `ship`/`land-and-deploy`/`canary` |
| **Doc Engineer** | `/doc` | Generates/refreshes docs to match shipped changes. | gstack `document-*` |
| **Doc Writer (Gemini)** | `/write <what>` | Collects facts in a Claude brief, asks the Gemini adapter to draft human-readable prose, then writes the file you choose today, only after approval; Notion page creation lands once a Notion MCP is wired. | Gemini CLI via Vertex AI |
| **Researcher** | `/research` | Multi-source, cited research; "search before build". | ECC/claude-skills `deep-research` |
| **Second opinion** | `/consult <model>` | Routes a plan/diff/question to a registered external model (`codex`) for a read-only cross-model review; `/codex` is now a thin alias for `/consult codex`. | gstack `codex` |
| **Ops** | `/cockpit`, `/health`, `/rstaff:setup` | Live eng dashboard from ground truth; wiring self-diagnosis; control repo and product profile scaffold. | — |
| **Token routing** | `/rstaff-usage:spend`, `token-efficient-delegation` skill | Persists writer/reviewer routes and measures Claude plus delegated use. | Superpowers routing/ledger discipline |
| **Maintenance** | `/sweep`, `loop-operator` subagent | Runs many small independent tasks at a graded autonomy level with hard safety rails. | ECC loop patterns |

## How the roles chain
```
fuzzy idea:    /interview  →  filed ticket
one feature:                  /spec  →  /design  →  /build  →  /review (fresh)  →  /secaudit  →  /ship  →  (/qa, /land)
                                                ↑ DoD = make verify ──────────────────────────────────┘
many features: /design ×N  →  /dispatch (worktree + runner each; per-task two-verdict gate)
                            →  per feature: /review → /ship → /land
review loop:               /review BLOCK → circuit-breaker memo → /replan (step back) → /build
```
`/build` runs a task ledger (kept in the control repo) through fresh subagents when
one exists (else single-shot). `/dispatch` fans that across features so you can do
other work while the team builds. Detail: `plugins/rstaff-engineer/skills/parallel-build/`.

**Agent-output quality (not code):** `/eval <repo>` scores a product's agent *output*
against its rubric in a fresh `eval-runner` (writer ≠ judge), driving that repo's harness via
its profile — the behaviour-quality analog of `/review`. Discipline: `plugins/rstaff-ai/rules/evaluation.md`.

**Ship-safety gate for agent behaviour changes:** `/experiment` sits alongside `/review`
and `/eval` as a third gate — `/review` checks a diff against a spec, `/eval` checks agent
output against a rubric, and `/experiment` checks a *causal claim* ("did this model/prompt/tool
change actually help?") by certifying the harness, pre-registering the hypothesis, and running
a controlled baseline-vs-change comparison to a fresh-context decision. It can invoke `/eval`
as one rubric-quality measurement inside that comparison, but the decision is its own. Discipline:
`plugins/rstaff-ai/rules/experiment.md`.

**Executor (not a new role):** `/dispatch <slug> --impl codex` (or
`/build … --impl`) swaps a non-Claude model in for the `implementer` step of a
ledger task — it writes inside that runner's own working tree (a `git
worktree` under `/dispatch`, the repo root under `/build`'s dispatcher mode).
**codex** is mechanically sandboxed to `workspace-write` there. Every other
rail is unchanged: independent review, `make verify`,
and a checkpoint commit. Implementation stays explicit; `route.js` automatically
selects Codex review only for eligible Claude-authored tasks.

> No standing C-suite personas. The strategy loop (`/brief → /boardroom → /decide
> → /post-mortem`) lives in the separate strategy repo, not here.
