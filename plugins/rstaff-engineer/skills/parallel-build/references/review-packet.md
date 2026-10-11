# Cross-provider task review packet

Create a short temporary prompt containing only:

```text
Review the uncommitted task diff in <worktree>.
Spec: <absolute spec path>
Task: <task id and acceptance excerpt>
Verify: <exact command>

Run the verify command. Report only P0/P1 blockers. Return the required
task-review schema with independent spec and quality verdicts.
```

Run it through the sandboxed generic executor, not native `codex exec review`
(native review currently reports all-zero usage and has no explicit `-s` flag):

```bash
node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/scripts/delegate.js" codex advise \
  --cwd <worktree> --sandbox read-only --prompt-file <packet> \
  --model <resolved review model> --reasoning-effort <resolved effort> \
  --attempt <N> \
  --output-schema "${CLAUDE_PLUGIN_ROOT}/schemas/task-review.schema.json" \
  --label "<repo>/<slug>/<task-id>/review" --timeout 1800
```

`<N>` is the 1-based writer attempt number (1 on the task's first writer dispatch, +1 per retry; ledgers that start `attempts: 0` pass `attempts + 1`), so quota and review verdicts are recorded per attempt.

Accept the task only when `verify`, `specVerdict`, and `qualityVerdict` are all
`PASS`. Treat malformed output, timeout, or `ok:false` as a review bounce.

If `locate.js rstaff-delegation` exits 1, say exactly once per run "rstaff-delegation not installed — all tasks use the Claude writer" and skip external routing and dispatch.
