---
description: Cockpit — a read-only engineering dashboard recomputed from ground truth (active /dispatch runs, managed repos, Claude/delegated token usage, open PRs/CI, and what needs you next). Never trusts hand-edited state.
argument-hint: [--write]
allowed-tools: Bash, Read, Grep, Glob
---

Give a live read on where the **engineering** work stands.

1. Run the collector and show its output **verbatim** (it's computed from
   `profiles/*`, `var/dispatch/*`, `var/usage.jsonl`, and `gh` — never from hand-edited state):
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/cockpit.js" --write $ARGUMENTS`
   (`--write` also caches `var/cockpit-latest.md`. Drop it for a pure read.)
2. Then add **≤3 bullets** of judgment the table can't compute — e.g. "the
   dispatch run parked on T3 is waiting on your exit-reason decision", or "that
   repo has 10 open PRs but none are yours — not your loop". No restating the table.
3. Stop there — `/cockpit` reads, it doesn't edit.

Runtime is a few seconds; GitHub sections skip unavailable data when `gh` is
unavailable (they print "skipped", never hang). Company strategy is not shown
here — it lives in the separate strategy repo.
