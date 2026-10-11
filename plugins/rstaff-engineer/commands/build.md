---
description: Implementer — implement a spec/PLAN to the make-verify Definition of Done. Dispatches a task ledger through fresh subagents when one exists; single-shot otherwise. Stops at green; never self-approves.
argument-hint: <spec path or task> [--impl <claude|codex>] [--model <id>]
allowed-tools: Bash, Read, Grep, Glob, Write, Edit, MultiEdit, Task, AskUserQuestion
---

Act as the **Implementer**. Build: **$ARGUMENTS**

**Load the contract.** Resolve the control repo `$CTRL` (= `$RSTAFF_HOME`, or a
walk-up to `rstaff.json`). Read the spec at `$CTRL/var/specs/<repo>/<slug>.md` (or the
task) and the repo's verify command — `make verify`, or the command in its rstaff
**product profile**
(`$CTRL/profiles/<repo>.md`, surfaced at session start). If
there's no spec, run `/design` first or write a 5-line one.

**Branch first** if you're on the default branch (git-workflow rule).

**Work in the target product repo** — not the rstaff control repo. If your cwd is the
control repo, `git`/verify/review act on the wrong tree; briefs you pass to subagents
must name the **absolute product-repo path**, never assume cwd. (Exception: when the
*target* is rstaff itself — developing the control repo — cwd = control repo is correct.)

**Disciplines to follow** (load the skill, don't reinvent): implement **test-first**
(`superpowers:test-driven-development` — a failing test at a stable seam before the
code); when something breaks, debug root-cause-first
(`superpowers:systematic-debugging`); before any "done" claim, verify with fresh
evidence (`superpowers:verification-before-completion`). These live in the
**superpowers dependency**. Follow the composition precedence in
`${CLAUDE_PLUGIN_ROOT}/rules/superpowers-precedence.md`. Keep
the diff **surgical** — every changed line traces to the spec
(`${CLAUDE_PLUGIN_ROOT}/rules/surgical-changes.md`).
Also follow `${CLAUDE_PLUGIN_ROOT}/rules/loop-brakes.md`: a human challenge is a
hard stop requiring status plus lettered options, and the advisory breaker
trips after two consecutive whole-branch BLOCKs.

## Delegation preflight

Before the loop, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation`.
If `locate.js rstaff-delegation` exits 1, then for `impl: auto` route every task to a fresh Claude `implementer`.
Print exactly once per run:
`rstaff-delegation not installed — all tasks use the Claude writer`
Skip `route.js` resolve/require and external dispatch for the entire run. This
no-layer path overrides the route-dependent steps below: use a fresh Claude
`rstaff:reviewer` for every task (spec + quality both PASS), and keep verify,
review-round recording, attempt caps, and checkpoint gates. Do not look for
route JSON or repeat the notice per task. An explicit external backend request
requires delegation; report it unavailable instead of silently changing the pin.
When delegation is located, follow the persisted routing steps below.

### If a task ledger exists (`$CTRL/var/specs/<repo>/<slug>.tasks.md`) → dispatcher mode
Accepts an optional **`--impl <claude|codex>`** flag (default `claude`).
For `codex`, preflight availability the same way `/dispatch` does
(`command -v codex`, or `delegate.js`'s exported `isAvailable()`).
Unavailable (backend not installed) → stop and
report why, or fall back to `claude` only with the human's explicit ok. Before
the loop starts, write the resolved backend into the ledger's HEADER `impl:`
field (`references/task-format.md`).

Run the loop in `${CLAUDE_PLUGIN_ROOT}/skills/parallel-build/SKILL.md`: pop the
next ready task (deps done), check `$CTRL/var/.STOP`, implement it by the resolved
route's **`writerMode`** — `subagent`: a fresh **`implementer` subagent** (unchanged);
`execute` (codex): shell `node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/delegate.js" <impl> execute` scoped to the repo root (`/build`'s
dispatcher mode has no worktree) instead; `draft` (gemini, docs only): `delegate.js gemini
draft`, then an `implementer` applies the draft — as in the skill. If the request asks to keep certain tasks off
Codex, record that in the ledger as `- impl:` + `- impl-reason:` on those tasks —
a pin stated only in prose is invisible to `route.js`, which refuses an
unexplained pin that contradicts the automatic route. Before spawning, resolve and persist
the exact route with `node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/route.js" resolve --ledger <absolute ledger> --task
<id> --write`, then gate the dispatch on `node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/route.js" require --ledger
<absolute ledger> --task <id>` — it exits 1 while `route:` is still `pending`,
and a shelled Codex writer is denied by the guard-bash hook without a persisted route. Use the
resolved reviewer/model/effort exactly. Follow `${CLAUDE_PLUGIN_ROOT}/skills/parallel-build/SKILL.md` as the single
authority for the persisted `reviewRequired` decision from `route.js`; its
conditional flow gates through the independent Claude or sandboxed Codex reviewer
(spec + quality, both PASS) when required, then makes **one checkpoint commit** (code only, tagged
`rstaff-task: <slug>/<id>`) and write the ledger row in `$CTRL`, then continue.
You are the single writer of the ledger and the only one who commits. On resume,
reconcile the ledger against the branch's `rstaff-task` trailers (exact match)
**first** — a committed task is never re-run, an uncommitted one never skipped
(SKILL.md § Resume). Park per the SKILL's rules (don't thrash); stop at
`ready_for_review`.

### Otherwise → single-shot (legacy) — always `claude`; `--impl` doesn't apply
(there's no ledger and no fresh-subagent hand-off to gate an external backend
through — you, Claude, are implementing directly in this session).
1. **Implement to the Definition of Done**, in small steps, **test-first** (see
   `superpowers:test-driven-development` — write the failing test, watch it fail, then
   the code). Reuse existing patterns/utilities; match the surrounding code's style.
   Bug fixes start with a failing regression test.
2. **The gate is the goal.** Run `make verify` and iterate until it passes. Do not
   weaken tests or linter/formatter configs to make it pass — fix the code.
3. **Don't thrash.** If `make verify` still fails after ~3 focused attempts on the
   same root cause, STOP: write the blocker (symptom, what you tried, the hypothesis,
   what you need) to `$CTRL/var/specs/<repo>/<slug>.blocked.md` — never a `BLOCKED.md`
   in the product repo — and hand back. Don't keep guessing. (This is the *single-shot*
   park artifact; **dispatcher mode parks in the ledger + status file instead** and
   writes no blocker file — see the SKILL.)

### Always
**Hand off — never self-approve.** When the work is green, do **not** call it done.
Tell the user to run `/review` (a fresh, independent whole-branch reviewer). Commit
only if asked, or via `/ship`. Never use `--no-verify`. Keep the diff minimal and
on-topic — no unrelated churn.

**Don't silently redefine a task.** If you conclude a task should be built differently
than its spec/acceptance says (different shape or deliverable), that's a **spec change,
not an implementation choice** — STOP and get a human forcing-question first. A task
quietly redefined mid-build is an unreviewed spec edit.

**Smoke the running app for agent/UI features.** Unit + e2e green is *not* "it works"
for something a user talks to or sees. Before `ready_for_review`, if the feature is an
agent or has a UI: boot the app (the profile's `run` command), run **one** real
end-to-end exchange (a canonical prompt / the core user flow), and paste the transcript
into the feature's QA doc. This is an **operator-run, interactive** step (you, or an
interactive `/build`) — not a headless subagent action. `/qa` is the deeper pass; this
is the minimum "I actually talked to it once" gate that catches integration breaks unit
tests miss.
