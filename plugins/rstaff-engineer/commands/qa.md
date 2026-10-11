---
description: QA — drive a real browser to test a running app, find bugs, fix them atomically, add regression tests, and re-verify. Tool-agnostic (Playwright MCP / Claude-in-Chrome / gstack /browse). Use --report-only to find without fixing.
argument-hint: [url] [quick|standard|exhaustive] [--report-only]
allowed-tools: Bash, Read, Grep, Glob, Write, Edit, AskUserQuestion
---

Act as the **QA Lead**. Systematically test the app and drive defects to zero.
(Adapted from gstack `qa`/`qa-only` — the *methodology*, not its browser daemon.)

### 0. Target + browser capability
- **Target:** the URL in `$ARGUMENTS`, else detect a running dev server (common
  ports), else start the app per the repo's run command. Confirm it loads.
- **Browser:** use whatever is configured, in this order — a **Playwright MCP**
  (`mcp__playwright__*`), **Claude Preview** (`mcp__Claude_Preview__*`),
  **Claude-in-Chrome** (`mcp__Claude_in_Chrome__*`), or gstack's `/browse` CLI if
  gstack is installed. If none is available, say so and offer HTTP/DOM-level
  checks as a fallback, plus how to enable a browser (install gstack, or add a
  Playwright MCP server — one server, vetted, per `docs/SECURITY.md`).

### 1. Scope by tier (from `$ARGUMENTS`, default **standard**)
- **quick** — happy path of the 1–2 most critical flows.
- **standard** — all primary user flows + obvious edge cases + console/network errors.
- **exhaustive** — flows × roles × states, error paths, empty/long/invalid input, a11y tree.

### 2. Test loop
For each flow: navigate, interact like a real user, **screenshot key states**, and
watch for: console errors, failed network requests (4xx/5xx), broken navigation,
visual breakage, missing validation, slow interactions.

### 2b. Score health (gstack rubric)
Compute a 0–100 **health score** so runs are comparable: weight Functional flows
(30%), Console errors (20%), Network/4xx-5xx (15%), Visual breakage (15%),
Accessibility tree (10%), Performance/slow interactions (10%). Report the score and
the biggest deductions — it's the headline, and it makes "did QA improve things?"
answerable across runs.

### 3. For every bug found
- Reproduce and capture evidence (steps + screenshot/console).
- **`--report-only`** → just log it (file a clear bug report — write any report file to
  the control repo, `$CTRL/var/specs/<repo>/<slug>.qa.md` (`$CTRL` = `$RSTAFF_HOME`, or a
  walk-up to `rstaff.json`; `<slug>` = the feature under QA, or a short run name for a
  standalone run), never the product repo); change nothing.
- Otherwise → find the root cause via **`superpowers:systematic-debugging`** (no fix
  without a reproduced root cause; follow the composition precedence in
  `${CLAUDE_PLUGIN_ROOT}/rules/superpowers-precedence.md`), fix **atomically** (`fix(qa): <short>` per bug),
  add a **regression test**, and **re-verify in the browser** that it's gone.

**Self-regulation caps (don't run away, don't thrash — from gstack `/qa`):**
- **Max ~25 fixes** in one run; beyond that, stop and hand the rest back as a report.
- **Stop after 2 fixes that had to be reverted** — the tree is unstable; report and stop.
- **High-uncertainty fixes → report, don't fix.** If you can't name the root cause
  (high "WTF-likelihood"), file the bug with evidence instead of guessing a patch.
- Keep each fix surgical (`${CLAUDE_PLUGIN_ROOT}/rules/surgical-changes.md`) — no drive-by refactors.

### 4. Gate + hand-off
Run `make verify` after fixes. Do **not** self-approve — recommend `/review`
(fresh context) before `/ship`. Report: the **health score**, bugs found, bugs
fixed, regression tests added, and before/after screenshots.
