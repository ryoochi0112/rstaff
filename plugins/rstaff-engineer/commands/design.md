---
description: Eng Manager — lock the architecture for a task before any code is written. Produces a reviewable PLAN with the make-verify Definition of Done.
argument-hint: <feature or task to plan>
allowed-tools: Bash, Read, Grep, Glob, Write, Edit, WebSearch, AskUserQuestion
---

Act as the **Eng Manager**. Lock the architecture for: **$ARGUMENTS**

Read first: this repo's product profile (`$CTRL/profiles/<repo>.md` via RSTAFF_HOME) for
its verify/run/QA commands and stated focus, and the relevant existing code. Search
before designing — reuse what exists.

Resolve the control repo `$CTRL` (= `$RSTAFF_HOME`, or a walk-up to `rstaff.json`).
The spec + ledger live there — `$CTRL/var/specs/<repo>/<slug>.{md,tasks.md}`, never in
the product repo — where `<repo>` is the product repo's directory name (its
`$CTRL/profiles/<repo>.md` token). If `/spec` already wrote `$CTRL/var/specs/<repo>/<slug>.md`,
**augment it** (keep its Problem/Users/Acceptance sections; add the engineering
sections below). Otherwise create it. Produce that spec with:

1. **Problem & user value** — the end-to-end outcome, not the mechanism.
2. **Approach** — the chosen design and *why over the alternatives*.
3. **Data flow** — inputs → transforms → outputs; a small diagram if it helps.
4. **Edge cases & failure modes** — what can go wrong and the handling.
5. **Test matrix** — cases × layers (unit / integration / e2e).
6. **Definition of Done** — `make verify` green + explicit acceptance criteria
   ("a user can …"). If the repo has no `make verify`, propose creating one from
   `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/templates/Makefile.sample` and list the real commands.
   **Validate the gate is adequate:** for every package/workspace the ledger's
   `files:` will touch, verify must run *that package's* type-check + tests — an
   app-scoped gate gives a silent false-green on unwired shared-package code. If the
   profile's verify misses a package the tasks touch, widen it (e.g.
   `pnpm --filter <pkg> type-check && test`) and record it in the ledger's `verify:` line.
7. **Risks / out-of-scope** — and anything that needs a human decision.

8. **Decompose into a task ledger** — after the spec, write
   `$CTRL/var/specs/<repo>/<slug>.tasks.md` per
   `${CLAUDE_PLUGIN_ROOT}/skills/parallel-build/references/task-format.md`: each
   task sized for one fresh subagent (≤5 files, one verify cycle, leaves the tree
   green) and written for a writer with **zero project context** — the
   `superpowers:writing-plans` discipline; the
   ledger + brief formats stay rstaff's own — with `deps`, `risk` (`low|medium|high`), `class: logic` (use `docs`/`config` only for documentation- or configuration-only tasks; a `docs` task under `impl: auto` is drafted by Gemini and applied by a Claude implementer), `impl: -`, `impl-reason: -` (a pinned `impl:` that contradicts the automatic route requires `impl-reason:`; route.js refuses an unexplained pin), `reviewer: -`,
   `route: pending`, `files`, `interfaces`, and `acceptance`; set the ledger
   header `impl: auto` and `reviewer: auto` so `route.js` picks the writer and
   reviewer per task from `risk` (implementation goes to Codex at **every** band —
   risk moves the reasoning tier, not the provider — with a fresh Claude reviewer
   as the gate on whatever Codex writes). `risk` is a real judgment call — use the
   thresholds in `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/skills/token-efficient-delegation/references/routing.md`, and escalate
   to `high` when uncertain: auth/security, permissions, privacy, migrations,
   destructive or billing operations, concurrency, or any irreversible external
   effect. A *bounded, reversible* interface change with strong tests is
   `medium`, not `high`. Order them so every checkpoint commit is a working state.
   **Skip** the ledger for a trivial ≤2-task
   feature (plain `/build` handles it). This ledger is what lets `/build` and
   `/dispatch` run tasks (and whole features) in parallel and resume after a crash.

Use **forcing questions** (AskUserQuestion) for any genuine ambiguity in scope,
acceptance, or constraints — don't guess. Keep the plan tight enough to scan,
concrete enough for `/build` to execute. Do **not** write implementation code here.

If `locate.js rstaff-delegation` exits 1, say exactly once per run "rstaff-delegation not installed — all tasks use the Claude writer" and skip external routing and dispatch.
