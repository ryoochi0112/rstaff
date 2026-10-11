# rstaff — contributor guide for Claude Code

rstaff is a set of Claude Code plugins that give a repo a small virtual
engineering team: on-demand roles (planner, implementer, reviewer, QA, release,
docs, researcher) plus a few always-on safety hooks. This file tells Claude how
to work in this repository.

## Operating thesis
Invest in loops, memory, and quality gates, not in a roster of always-loaded
personas. The gates are enforced mechanically, not only prompted: a completion
gate blocks a stop when the tree changed without a green verify, and review
always runs in a fresh context. Keep context lean.

## Plugin routing
Each plugin lives under `plugins/<name>/` with its own `.claude-plugin/plugin.json`.
Commands, skills, agents, hooks, and rules sit inside the plugin that owns them.

- `rstaff` — core: shared hooks and scripts.
- `rstaff-pm` — product-management commands (interview, backlog flow).
- `rstaff-engineer` — the build loop: spec, build, dispatch, QA, land, review.
- `rstaff-delegation` — delegating work to external writers.
- `rstaff-ds`, `rstaff-ai` — data-science and AI workflow helpers.
- `rstaff-usage` — usage reporting.
- `rstaff-backlog` — the ticket backlog store and cockpit view.
- `rstaff-ai-datadog` — Datadog-backed AI observability helpers.

Commands invoke skills; skills do not invoke each other. Generic engineering
disciplines (TDD, systematic debugging, verification before completion,
brainstorming) come from the `superpowers` peer plugin. Commands name
`superpowers:*` skills directly, so install that plugin alongside rstaff.

## Non-negotiables
- **Writer is not reviewer.** Review runs in a fresh context. The author never
  approves their own work.
- **One verify command is the only "done" signal for code.** Run `make verify`.
  Never bypass it; `--no-verify` is denied by the bash policy hook, and the
  completion gate blocks a stop without a green verify.
- **Humans decide.** Claude recommends and drafts. Merge, deploy, and publish
  need an explicit human go.
- **Surgical changes.** Touch only what the task needs; no drive-by refactors.
- **Context is finite.** Add capability deliberately, one vetted piece at a
  time. No persona sprawl, no bulk MCP imports.

## Conventions
Read the relevant file in `plugins/*/rules/` before changing behavior:
`security.md`, `testing.md`, `evaluation.md`, `review-severity.md`,
`git-workflow.md`, `surgical-changes.md`, `session-hygiene.md`,
`superpowers-precedence.md`, `loop-brakes.md`.

Work test-first: write a failing test at a stable seam, watch it fail, then
write the code. After a new test passes, delete the guarded line once and
confirm the test goes red.

## Using rstaff in another repo
Install the plugin (`/plugin marketplace add <path-to-this-repo>`, then
`/plugin install rstaff@rstaff`). Declare the repo's verify command (`make verify`
by default) so the completion gate knows what "green" means. Run `/health` to
confirm the hooks are wired.
