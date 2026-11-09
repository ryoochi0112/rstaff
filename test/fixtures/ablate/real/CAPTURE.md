# Real `claude` captures for the ablate shim

These files are sanitized output of the real `claude` CLI. `test/maintainer/ablate-shim-fidelity.test.js`
compares the key sets of `test/fixtures/ablate/claude-shim.js` against them. Every capture costs $0:
each command uses an invalid model id (`invalid-model-zzz` or `invalid-model-ablate-smoke`;
for `plugin eval`, also as `--judge-model`),
so no paid call is made. Never re-capture with a valid model id.

`claude --version`: `2.1.292 (Claude Code)`

Placeholders: `<ARM_DIR>` is a built full arm (`.../arms/full/rstaff-pm`), `<REPO>` is this repo,
`<HOME>` is the operator home, `<OUT>` is a scratch output dir, `<SCRATCH>` is a scratch dir.

Build the arm first:

    node maintainer/ablate/ablate.js --skill grilling --out <SCRATCH>/freeze --stop-after freeze

| file | command | exit | cost |
|------|---------|------|------|
| `eval-aggregate.json` | `claude plugin eval <ARM_DIR> --ablation none --model invalid-model-zzz --judge-model invalid-model-zzz --runs 1 --case grilling-compliance-one-question-before-design --no-publish --trust-plugin --output-dir <OUT>/` (the `aggregate-result.json` written) | 1 | `costUsd` 0 |
| `eval-no-case.txt` | the same command with `--case one-question-before-design` (the case dir name); stderr, and no aggregate is written | 1 | no run |
| `probe.jsonl` | `claude -p "reply OK" --model invalid-model-zzz --plugin-dir <ARM_DIR> --output-format stream-json --verbose --max-turns 1` | 1 | `total_cost_usd` 0 |
| `probe-judge-model.stderr` | `claude -p "x y" --model invalid-model-ablate-smoke --judge-model invalid-model-ablate-smoke --output-format stream-json --verbose --no-session-persistence` | 1 | $0; rejected before any run |
| `analyst.jsonl` | `claude -p --agent rstaff-ai:experiment-analyst --plugin-dir plugins/rstaff-ai --model invalid-model-zzz --output-format stream-json --verbose "x y"` | 1 | `total_cost_usd` 0 |

`probe-judge-model.stderr` was captured by the dispatcher on 2026-10-15 from a scratch directory
with `claude --version` reporting `2.1.292 (Claude Code)`. Stdout was empty (0 bytes); stderr was
exactly `error: unknown option '--judge-model'` followed by one newline. The fixture preserves those bytes.

Sanitizing: absolute paths become the placeholders above, the user name becomes `<USER>`, uuids become
`00000000-0000-0000-0000-000000000000`, request ids become `req_PLACEHOLDER`. The two stream files keep only
the `system/init` event and the `result` event; the large arrays in `init` (`tools`, `mcp_servers`,
`slash_commands`, `terminal_slash_commands`, `agents`, `skills`) are cut to three entries. `plugins` is whole.
The runs fail on the model id by design, so a run has `error` set and no `evidence`. A successful llm grader
additionally carries `evidence` and `judgeVotes`.
