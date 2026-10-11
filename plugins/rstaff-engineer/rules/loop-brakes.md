# Loop brakes (always-follow)

## When the human challenges the effort

If the human questions the effort — “why is this taking so long?”, “what are you
doing?”, “what are you trying for?”, or “なんでこんなに時間かかってるの” — STOP.
The only valid response is stop + status + lettered options. Never
explain-and-resume. Do not continue until the human chooses an option.

Status must state where the work actually is, what has been verified with
receipts versus merely claimed, and what each remaining option will cost.
Evidence for this hard stop is in `docs/research/efficiency-harness-260827.md` §1:
the measured arc ran 13 review rounds across 9 sessions (~28h wall), never
shipped; the user challenged twice, and the loop explained itself and resumed
building both times. Prose alone did not hold.

## Review circuit breaker

Track review state by repo+branch across sessions. The breaker trips at **2
consecutive whole-branch BLOCK verdicts** on the same repo+branch. A
whole-branch PASS or an explicit human override clears the streak.

Use `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-review-rounds.js` as the generator of
record. Its memo text is authoritative; do not restate the memo format here.
Use its CLI verbs as follows:

- `status` reads the current counter state for a repo and branch.
- `record` appends a verdict and P0/P1 counts, updating the whole-branch streak.
- `reset --reason "<why>"` records the human override and clears the streak.

Record task-mode verdicts as evidence, but do not feed them into the streak:
task mode already has the 3-attempt cap and the dead-man, so counting it would
trip the breaker on routine `/dispatch` runs.

The breaker is **ADVISORY**. A 3rd round is still possible after
`reset --reason "<why>"`. There is no PreToolUse guard because adding guard
surface is the exact over-investment this initiative exists to stop. Revisit
only with evidence that the advisory brake was ignored; record that evidence in
the review-round state.

Persist the state across session boundaries — that is the point. The measured
arc ran 13 rounds across 9 sessions precisely because nothing remembered across
them.
