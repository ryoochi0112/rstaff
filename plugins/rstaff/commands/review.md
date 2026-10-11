---
description: Reviewer — spawn an independent, fresh-context reviewer over the current diff. Blocking issues only. Enforces writer≠reviewer.
argument-hint: [base ref or PR number, optional]
allowed-tools: Bash, Read, Grep, Glob, Task
---

Run an **independent review** of the current change. This MUST be a fresh,
read-only reviewer — the author never approves their own work.

0. **Read the review-round breaker before delegating.** Follow
   `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-engineer)/rules/loop-brakes.md` for the advisory whole-branch
   breaker. If `locate.js rstaff-engineer` exits 1, say "Engineer layer absent; using the core review-round breaker directly." First run:
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib-review-rounds.js" status \
        --repo <repo dir name> --branch <current branch>
   ```
   Use the target repo directory name and current branch. If the result reports
   `tripped: true` on entry, the human has already been handed the memo and has
   not reset the breaker; surface that fact before starting work rather than
   silently starting another round.

1. **Assemble the review packet:**
   - **Confirm the target repo first.** Review the **product repo**, not the rstaff
     control repo — if cwd is the control repo (or `$RSTAFF_HOME`), the diff targets
     the wrong tree. Pass the reviewer the product repo's absolute path + an explicit
     `git diff main...HEAD`; loudly warn and stop if you can't confirm cwd is the
     product repo. (Exception: reviewing rstaff *itself* — then the control repo IS the target.)
   - Diff: `git diff $ARGUMENTS` (default `git diff main...HEAD`), or `gh pr diff <n>` if a PR number was given.
   - The spec it implements (`$CTRL/var/specs/<repo>/<slug>.md`, in the control repo)
     and the repo's **resolved absolute profile path** (`$CTRL/profiles/<repo>.md`,
     after resolving `$CTRL` (= `$RSTAFF_HOME`, or a walk-up to `rstaff.json`)),
     alongside the repo's verify command/DoD (`make verify`, or the command in that
     profile).
2. **Delegate to the `reviewer` subagent** via the Task tool (subagent_type
   `reviewer`). Pass `model: opus` when the feature's ledger has any `risk: high`
   task, or (no ledger) when the diff touches auth, permissions, persistence,
   migrations, money, or concurrency; otherwise `model: sonnet` (the Claude tier
   in
   `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-delegation)/skills/token-efficient-delegation/references/routing.md`; if delegation is absent, say "Delegation layer absent; using the stated Claude reviewer tiers.").
   Pass it the diff, the spec, the resolved absolute profile path, and
   the DoD. Do not review it yourself
   in this context — the point is independence.
3. **Relay the verdict verbatim**: `BLOCK | PASS` with P0/P1 findings only
   (file:line, failure mode, suggested fix). No praise, no style nits. Severity
   scale: `${CLAUDE_PLUGIN_ROOT}/rules/review-severity.md`.

4. **Record the verdict after relaying it:**
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib-review-rounds.js" record \
        --repo <repo> --branch <branch> --mode whole --verdict pass|block \
        --p0 <count> --p1 <count> \
        --goal "<restate from the spec's acceptance criteria>" \
        --why "<name the single structural gap these rounds keep circling>"
   ```
   Run `record` with cwd inside the product repo (or pass `--cwd <product repo>`) so the round is stamped with the reviewed tree.
   Before running `record`, replace both quoted angle-bracket values with a
   filled restatement from the spec's acceptance criteria and one structural
   gap supported by the actual rounds and their findings. The CLI refuses to
   emit a tripped memo while either value remains a placeholder.
   If `record` exits non-zero after reporting that the round was recorded, do
   not run `record` again; re-run `status --repo <repo> --branch <branch> --goal
   "<filled goal>" --why "<filled why>"`.
   Use the reviewer’s verdict and P0/P1 counts, with `pass` or `block` in
   lowercase for the CLI. `--mode whole` is mandatory: `/review` is the
   whole-branch reviewer, and only whole-branch verdicts feed the streak. Read
   the resulting `tripped` field and any memo printed to stdout.

5. **Close conditionally from the `record` result:**
   - **When `tripped: false`:** If the verdict is BLOCK, the change is not
     shippable — locate the engineer layer with
     `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-engineer)`
     and use its `/rstaff-engineer:build`, then re-review. If absent, say
     "Engineer layer absent; fix the blocking findings directly, then re-review." Only a PASS
     (or an explicit human override) clears it for `/ship`.
   - **When `tripped: true`:** The closing output MUST be the generated
     structural memo printed by `record`. Before handing it to the user, fill
     `Goal (restated):` from the spec’s acceptance criteria and fill
     `Why convergence is failing:` from the actual rounds and their findings.
     Use evidence from the spec and rounds only; do not invent either value and
     never hand the placeholder text to the user unfilled. Resolve
     `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-engineer)`
     before recommending `/rstaff-engineer:replan`. If absent, say "Engineer layer
     absent; ask the human to revise the plan." Recommend a human decision using
     the memo’s own lettered options; do not give the
     normal route-back guidance in this branch.

   A human who wants a 3rd round anyway can reset the advisory breaker with:
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib-review-rounds.js" reset \
        --repo <repo> --branch <branch> --reason "<why>"
   ```
   The breaker is advisory, so this reset is the explicit override.
