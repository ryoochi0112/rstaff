# Third-party attribution

rstaff cherry-picks *mechanisms* (patterns, structure, occasional adapted text)
from several MIT-licensed projects. We **adapt** rather than copy wholesale, and we
install nothing from them automatically. No upstream file is vendored verbatim.
Licences verified 2026-10-10 with `gh api repos/<owner>/<repo>/license`; holder and
year are copied from each upstream LICENSE file.

| Source | License | What rstaff borrows | How |
|---|---|---|---|
| [garrytan/gstack](https://github.com/garrytan/gstack) | MIT © 2026 Garry Tan | The role-chain *shape* (`spec → review → qa → ship → canary`), `/office-hours` product interrogation (→ `/spec`), the `/qa` health-score rubric + self-regulation caps, `/codex` second-opinion pattern, checkpoint-commit handoff, template→SKILL.md anti-drift idea, browser-QA daemon (optional upstream install). | Pattern/shape reference; `plugins/rstaff-pm/commands/spec.md`, `plugins/rstaff-engineer/commands/qa.md`. The browser daemon, if used, is installed upstream, not vendored. |
| [obra/superpowers](https://github.com/obra/superpowers) | MIT © 2025 Jesse Vincent | **Now a peer plugin, not a source to vendor** (since v0.8.0): rstaff's role commands invoke `superpowers:{test-driven-development,systematic-debugging,verification-before-completion,brainstorming,receiving-code-review,writing-plans}` directly; the previously vendored TDD + systematic-debugging adaptations were removed so identical skill names don't shadow each other. Still borrowed as *patterns*: subagent-driven development (file-based handoffs, two-verdict per-task gate), risk-scaled model selection, compaction-surviving progress ledger. | Peer-plugin contract: `plugins/rstaff-engineer/rules/superpowers-precedence.md` (+ `/rstaff:health` pairing check). Pattern ancestry: `plugins/rstaff-engineer/skills/parallel-build/`, `plugins/rstaff-delegation/skills/token-efficient-delegation/`. |
| [mattpocock/skills](https://github.com/mattpocock/skills) | MIT © 2026 Matt Pocock | The **grilling** interview discipline (one question at a time; explore the codebase instead of asking answerable questions), the user-invoked orchestrator/model-invoked discipline split, compact handoffs that point to existing artifacts, and isolated two-axis (spec vs quality) review. | `plugins/rstaff-pm/skills/grilling/`, `plugins/rstaff-delegation/skills/token-efficient-delegation/`; the command/skill split across `plugins/`. |
| [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) | MIT (declared in upstream README; no LICENSE file upstream) | **Surgical-changes** taste rules (every changed line traces to the request; no drive-by refactor; cheap "is this overcomplicated?" self-tests) + the "state the tradeoff / escape hatch" convention. (Canonical repo; `multica-ai/…` is a fork — attribution corrected 2026-08-09.) | `plugins/rstaff-engineer/rules/surgical-changes.md`. |
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) | MIT © 2025 AgentLand Contributors | The **reality-checker** review stance (default skeptical; demand receipts; a claim of "works"/"pre-existing" is not a fact until shown) + the bounded retry-then-escalate loop. | `plugins/rstaff/agents/reviewer.md` stance; dispatch retry caps. |
| [affaan-m/ECC](https://github.com/affaan-m/ECC) | MIT © 2026 Affaan Mustafa | Hook-lifecycle memory spine (SessionStart/PreCompact/SessionEnd), security hook patterns (secret scan, `--no-verify` block), `rules/common/*` conventions, selective-install manifest pattern, security checklist, worktree orchestration + `loop-operator`. | Clean-room re-implementation of the *patterns* in `plugins/*/hooks/*` and `plugins/*/rules/*`; checklist adapted into `SECURITY.md`. No ECC code copied. |
| [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) | MIT © 2025 Alireza Rezvani | Single-reviewer (`pr-review-expert`) rubric used by `plugins/rstaff/agents/reviewer.md`. (The Chief-of-Staff decision loop this repo once borrowed moved to the separate strategy repo when strategy was split out.) | Rubric adapted in `reviewer.md`. |

**Deliberately NOT adopted:** the C-suite / agency **persona rosters**
(agency-agents' 232 agents, gstack's `plan-*`/`design-*` persona suite + iOS tier,
ECC's 67 agents / 271 skills / 14 bundled MCP configs). We take the *one good
mechanism* from each and refuse the roster breadth + context bloat — consistent with
the thesis that leverage is in loops/memory/gates, not personas. rstaff's own
differentiator (mechanically-enforced verify + fresh-context writer≠reviewer) is
absent from all of them.

> Anything vendored from these repos is scanned before use; see "Vendored skills are
> code" in `SECURITY.md`.
