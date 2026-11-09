# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.8] - 2026-11-10

### Fixed
- **rstaff-engineer** — `rstaff run`: the commit and the push now run in the run's own environment, so a git identity set for the run reaches them. Before, the runner's `git commit` read only the machine's global identity and failed with "Author identity unknown" on any machine without one; the public mirror's first CI run of the runner tests showed it (seven tests red). The runner also checks for a committer identity at setup, next to the login check, and stops with a plain message before a worktree is made or a worker is paid.

## [0.13.7] - 2026-11-09

### Added
- **rstaff-engineer** — `bin/rstaff job <repo> <ticket>`: a read-only author turns the backlog ticket into `var/jobs/<repo>/<ticket>/job.md` by exploring a scratch checkout of the product repo; a pre-flight then runs the job's checks on untouched main (at least one must be red), lists tracked files that mention an allowed path but are not on the list (a hash, a snapshot, a fixture), and gives the author one more pass with the findings. Exit 0 ready, 2 needs a look, 1 error; the report is six plain lines. Earned by the fifth ticket, whose hand-written job allowed a config file but not the report that hashes it.

### Changed
- **rstaff-engineer** — `rstaff run` and `rstaff job` check `claude auth status` before making a worktree and stop with "not logged in" instead of failing at the first model call (the CLI logged itself out twice in one day).

## [0.13.6] - 2026-11-09

### Changed
- **rstaff-engineer** — `rstaff run`: the kill switch (`var/.STOP`) now acts while a worker or referee is running, not only between steps: the runner polls it (every 2 s, `RSTAFF_RUNNER_STOP_POLL_MS`) and ends the model process at once; the receipt says `stopped` and the run ends with exit 3. Earned by the second stop of the first day, when a worker kept going for 22 minutes after the switch was raised.

## [0.13.5] - 2026-11-09

### Changed
- **rstaff-engineer** — `rstaff run`: the PR body's "What changed" sentence sits in a GitHub note callout so a reviewer sees it first (operator feedback after ticket 4).

## [0.13.4] - 2026-11-09

### Changed
- **rstaff-engineer** — `rstaff run`: a red test command is run once more before the red is sent back to the worker; both receipts stay on record and the PR body marks a second attempt. A job may list under `## Files` the paths the worker may change; the runner sends back any change outside that list before the referee runs. The PR body is short and structured: what changed (the referee now returns a one-sentence summary and at most five short reasons), the verdict line, then receipts and the job text in collapsed sections. All three pieces were earned by the first two real runs (see the autonomy spec's growth loop).

## [0.13.3] - 2026-11-09

### Added
- **rstaff-engineer** — `bin/rstaff run <repo> <ticket>`: the bare runner from week 1 of the autonomy redesign. One headless `claude -p` worker edits a fresh worktree of the product repo; the runner itself runs the profile's test command and the job's checks and writes receipts (command, exit code, HEAD, tree hash); a fresh read-only referee accepts or rejects; an accepted change becomes a draft PR carrying the job, the receipts and the verdict. Stops at once on `var/.STOP` or when the job's time or money cap is hit; one line per step in `var/jobs/<repo>/<ticket>/run.jsonl`.

### Changed
- **rstaff** — Completion gate: a tree whose only changes since the session baseline are under the `docs`, `specs`, `backlog` or `profiles` directories no longer needs a green `make verify` to stop. A `backlog` change inside the control repo needs the backlog validator green instead (the hook runs it; the block names `make backlog-check`).

## [0.13.2] - 2026-11-09

### Changed
- **rstaff-usage** — The context ceiling is configurable (`RSTAFF_CONTEXT_WARN`, `RSTAFF_CONTEXT_INSIST`, `RSTAFF_CONTEXT_CEILING=off`) and its defaults moved from 200k / 400k to 700k / 850k tokens so long-running sessions are not nudged to stop early.

## [0.13.1] - 2026-10-14

### Changed
- **rstaff-engineer** — `/land` step 2 reads the PR's required checks and refuses to merge when one is red, pending, or absent.
- **rstaff-engineer** — Git-workflow rule: backlog-only edits commit straight to main.
- **rstaff** — The bash guard no longer repeats quote passes on the top-level command, so long commands check faster.

## [0.13.0] - 2026-10-10
First public release.

### Added
- **rstaff** — Always-on security and verification gates with independent review, release, and diagnostic commands.
- **rstaff-pm** — Product/PM toolkit: interview ideas into falsifiable tickets and tickets into specs, each judged by a fresh-context critic.
- **rstaff-ds** — Data-science toolkit: notebook conventions and a fresh-context analysis reviewer; the notebook re-run gate lives in core.
- **rstaff-engineer** — Engineering workflow commands, parallel delivery skills, and implementation conventions.
- **rstaff-ai** — Optional AI evaluation and controlled experimentation tools for agent-generated output.
- **rstaff-ai-datadog** — Optional Datadog LLM Observability analysis; requires a Datadog account and the Datadog connector.
- **rstaff-usage** — Token usage accounting and context cost guards.
- **rstaff-backlog** — A live engineering dashboard.
- **rstaff-delegation** — External model consultation, routed task execution, and document drafting.
