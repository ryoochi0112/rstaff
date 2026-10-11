# Defect key

Line convention: each `file:line` is a real target-file line number on the
unified diff's new-file side, computed from its `@@` hunk header. For a
deletion-only issue, the reference is the first surviving new-file code line at
the deletion hunk's position.

## D1 — removed guard
- file: plugin/scripts/delegate.js:104
- must-report: The diff removes the existing `assertSandbox` call from `buildArgv`, so the danger-full-access sandbox guard is no longer enforced before argv construction.

## D2 — spec violation
- file: plugin/scripts/route.js:126
- must-report: Requirement 2 is not implemented because the override loop validates `--impl-effort` but silently omits the required `--review-effort` validation.

## D3 — cross-file inconsistency
- file: plugin/skills/token-efficient-delegation/references/routing.md:13
- must-report: The routing table says the high-risk `gpt-5.6-sol` tier uses `max`, while `route.js` defines that same tier with effort `high`.

## D4 — off-by-one/logic slip
- file: plugin/scripts/route.js:41
- must-report: The catalog loop slices off its last entry, so `/doctor` never checks the high-risk band even though requirement 4 says every band must be checked.

## D5 — missing-test gap
- file: test/route.test.js:205
- must-report: The diff deletes the existing route format/parse round-trip regression test, leaving the newly effort-bearing persisted route without that coverage.
