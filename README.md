# rstaff

## What you get

> [!NOTE]
> The colleague runner is week 1 of a four-week redesign.
> The older role toolkit still exists.
> You can still install the following roles in the same way as before:
> * PM role
> * Data scientist role
> * AI engineer role
> * Engineer role

You get a professional colleague. This colleague takes a ticket in your own words. It works alone for hours. It hands back a pull request (PR). A PR is a request to merge code changes. You can judge the PR yes or no in plain words.

A copilot asks for approval at every step. A colleague is trusted to decide how to work. It is judged on what it delivers.

The colleague owns the plan and decides the steps. It checks with you only before one-way doors. One-way doors are high-risk decisions that are hard to undo. These include deploys, deleting data, messaging customers, or spending big budgets.

To run the colleague runner from a checkout of this repo, use:
```
node bin/rstaff run <repo> <ticket>
```

## How a run goes

A run executes in a separate worktree and is checked by tests and a referee.

* **Job formulation**: Claude Code explores the repository and writes a job. The job is half a page of plain words. It lists three to six checks as commands. It defines a do-not-touch list. It also sets a time cap and a money cap. It does not ask you to approve the job. The job travels in the draft PR.

* **Headless execution**: The worker is a headless session. This means it runs with no interactive screen. It gets the job text and nothing else. It edits a fresh worktree. A worktree is a separate working copy of the repository on its own branch.

* **File limits**: The job can list allowed paths under `## Files`. If it does, any edits outside those paths are blocked. The runner sends the edits back to the worker.

* **Runner checks**: The runner itself executes the repository's test command and each check. It writes receipts. Receipts are recorded proofs of run commands. They include exit codes, HEAD commits, and tree hashes.

* **Verify retries**: The runner tries a red test command once more before holding it against the worker. Both receipts stay on record. The PR body marks the second attempt.

* **Referee review**: The referee is a fresh read-only session with limited tools. It has no write or edit tools. It reads the job, the diff, and the receipts. It answers accept or reject.

* **Outcome**: On accept, the runner commits, pushes, and opens a draft PR. A draft PR is a work-in-progress pull request. On reject, the reasons go back to the worker for up to three rounds.

* **Progress notes**: If a run passes one hour, the runner writes a progress note. It shows something you can open. This could be the worktree, the branch, or the patch. The runner then continues its work.

* **Stop control**: The runner stops at once when `var/.STOP` exists or caps are hit. Exit codes show the outcome.

## The colleague rules

A colleague earns trust through independent action and clear results.

What the colleague always does:

* Decides the plan and owns it.

* Takes your ask in plain words and writes the checks.

* Shows a prototype or a draft PR when there is something to look at.

* Writes down what is unverified and keeps going when unsure.

* Checks with you only before one-way doors.

* Earns bigger tickets and fewer check-ins as accepted work accumulates.

What the colleague never does:

* Asks you to approve a design, architecture, task list, or contract.

* Sends status reports with nothing to look at.

* Claims work is done without running the checks.

* Hides uncertainty from you.

What the operator does:

* Gives the ticket in plain words.

* Looks at prototypes and draft PRs.

* Says yes or no and explains what felt wrong.

* Answers the rare question about the outcome when the codebase cannot answer it.

* Decides one-way doors.

## The record so far

The colleague runner finished five real tickets on day one, November 9, 2026. The operator accepted all five.

These five tickets ran on two product repositories. Repo A is a TypeScript repository. Repo B is a Python repository.

| # | Repo | Rounds | Minutes | Cost (USD) | Referee | Operator |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | A (TypeScript) | 2 | 17.5 | 2.35 | accept | yes |
| 2 | A (TypeScript) | 1 | 56.6 | 2.58 | accept | almost yes |
| 3 | B (Python) | 1 | 4.4 | 1.54 | accept | yes |
| 4 | A (TypeScript) | 1 | 26.5 | 3.89 | accept | yes |
| 5 | A (TypeScript) | 1 | 46.2 | 4.03 | accept | yes |
| **Total** | | **6** | **151.2** | **14.39** | **5 of 5 accepted** | |

Nominal dollars are the estimated API costs reported by the Claude CLI for the tokens used. The operator runs on an enterprise subscription, so there is no separate bill.

Honest notes on our progress:

* **Still to prove**: All five target tickets were finished and accepted on day one; the written bar was three of five. We still must prove an accepted PR is not reverted within two weeks. We must also prove a run can go while the operator sleeps.

* **Stopped run**: Ticket 5's first run was stopped by hand after one round at $3.48. The job allowed editing a config file but not a report file that tests regenerate. The test failed twice for a reason the worker could not fix within its file list. This was a job-writing failure, not a runner failure. The second run, with a corrected job, is row 5 of the table; the $3.48 is not in the total.

* **Stop file**: In one run, a worker kept going for 22 minutes after the stop file was raised, because the switch was read only between steps. Since 0.13.6 the runner also polls `var/.STOP` every two seconds while a worker or referee runs, and ends it at once.

* **Not built yet**: We cannot resume a stopped run. We do not check `claude auth status` before the worktree is made. The CLI logged out twice in one day, which forced the run to wait for the operator.

Our pre-registered target for the four-week redesign is to finish at least three of five real tickets alone. The operator must accept them under their money caps. No accepted PR can be reverted within two weeks. Fewer than two means the approach is rejected.

We also measure colleague behavior. We count questions asked, which should be at most one about the outcome. We target zero approval requests outside one-way doors. We track if long runs show progress. Each week we ask: would I let this colleague work while I sleep? Trust grows with the record, like a new hire. Autonomy is earned only by the record.

The following table shows what each failure added after week one:

| Version | Feature | Triggering Failure |
| :--- | :--- | :--- |
| 0.13.4 | verify re-run | A 30-second machine timeout caused a red test. This sent the worker into an unwinnable round. |
| 0.13.4 | `## Files` list | The worker edited an unrelated test. The referee accepted it anyway. |
| 0.13.4 | Short, structured PR body | The PR body was 66 lines long. The operator felt the text was too long. |
| 0.13.5 | Highlighted callout | The operator requested to highlight the "What changed" line after reviewing four PRs. |
| 0.13.6 | Stop file ends a running worker | A worker kept going for 22 minutes after the stop file was raised; the switch was read only between steps. |

## What the gates guarantee, and what they do not

The threat model of the gates covers honest mistakes only. The gates catch an agent that says done without verifying, or that takes an obvious shortcut. They do not resist an agent or a user that deliberately forges evidence, edits gate state, or evades hooks. The bash deny is a policy guard, not a security boundary. Read [SECURITY.md](SECURITY.md) for details.

| Gate | Guarantees | Does not guarantee |
| :--- | :--- | :--- |
| Completion gate | Blocks a stop after the tree changes. The block lasts until a green verify run is recorded on that exact tree. Trees with changes only under `docs`, `specs`, `backlog`, or `profiles` can stop without verification. | That the verify command is a good test. That records are genuine, because they are not signed. The gate gives up after 3 blocks per session and tree. A hook that times out fails open. It does not run if `RSTAFF_GATE=off`. |
| Fresh review | Runs `/rstaff:review` in a separate subagent context. The author never approves its own work. | That the reviewer is correct. If the review is skipped, only the `/rstaff:ship` tree-match check remains. |
| Colleague runner | The Write tool is refused outside the worktree under the worker's permission mode. The runner needs a profile in the control repo, which is the central repository that manages jobs. It needs a logged-in `claude` CLI and `gh`. | That shell redirects like `echo > file` outside the worktree are blocked. They go through. We leave them unverified for now. |

## Install

One line per role. Each line adds the marketplace and installs the plugin.

| Role | What you get | Install command |
| :--- | :--- | :--- |
| PM | requirement/spec, falsifiable acceptance criteria, adversarial pass. | `claude plugin marketplace add ryoochi0112/rstaff && claude plugin install rstaff-pm@rstaff` |
| data scientist | notebook, clean re-run of the notebook in a fresh kernel, fresh analysis reviewer. | `claude plugin marketplace add ryoochi0112/rstaff && claude plugin install rstaff-ds@rstaff` |
| AI engineer | prompt/model/tool change, pre-registered experiment verdict, fresh adjudicator. | `claude plugin marketplace add obra/superpowers-marketplace && claude plugin marketplace add ryoochi0112/rstaff && claude plugin install rstaff-ai@rstaff` |
| engineer | code change, your verify command (for example `make verify`), fresh reviewer. | `claude plugin marketplace add obra/superpowers-marketplace && claude plugin marketplace add ryoochi0112/rstaff && claude plugin install rstaff-engineer@rstaff` |

The colleague runner ships inside `rstaff-engineer`; run it from a checkout of this repo with `node bin/rstaff run <repo> <ticket>`. Quick starts for each role follow.

## PM quick start

This path creates specs without superpowers. Install with the PM line in the table above.

Create control repo `acme` and start Claude Code:

```text
/rstaff:setup acme
```

```sh
export RSTAFF_HOME=~/rstaff-home
cd ~/rstaff-home && claude
```

Interview an idea and create a spec:

```text
/rstaff-pm:interview <idea>
/rstaff-pm:spec <TICKET-ID>
```

An invalid ticket blocks Stop. Fix in `backlog/acme.md`, run `node '<core>/scripts/lib-backlog.js' validate`, then Stop is allowed.

## Data scientist quick start

This path gates analysis notebooks. Create the environment and start `claude`:

```sh
python3 -m venv .venv && . .venv/bin/activate && pip install nbconvert ipykernel
claude plugin marketplace add ryoochi0112/rstaff
claude plugin install rstaff@rstaff
claude plugin install rstaff-ds@rstaff
claude
```

Point setup at your analysis folder and start Claude Code:

```text
/rstaff:setup <analysis-path>
```

```sh
export RSTAFF_HOME=~/rstaff-home
cd <analysis-path> && claude
```

The gate (`rstaff:nbgate`) checks notebooks:
- **Run order:** cells have counts 1..N in order.
- **Fresh run:** notebooks run in a fresh kernel.

`RSTAFF_NBGATE_PYTHON` sets Python (default `python3`). `RSTAFF_NBGATE_TIMEOUT` sets timeout in seconds (default 600). Skip notebooks using `.rstaff-nbignore` globs.

For a fresh-context review, run:

```text
/rstaff-ds:review <notebook>
```

To try, copy `~/.claude/plugins/marketplaces/rstaff/plugins/rstaff-ds/samples/analysis` to a new directory, run `git init`, then `/rstaff:setup <that-dir>`.

## AI engineer quick start

This path tests prompts using your Claude login. Log in:

```sh
claude auth login
```

Install plugins and copy the sample task:

```sh
claude plugin marketplace add obra/superpowers-marketplace
claude plugin marketplace add ryoochi0112/rstaff
claude plugin install rstaff@rstaff
claude plugin install rstaff-ai@rstaff
cp -R ~/.claude/plugins/marketplaces/rstaff/plugins/rstaff-ai/samples/label-task <work-dir>
claude
```

Setup the work folder and start Claude Code:

```text
/rstaff:setup <work-dir>
```

```sh
export RSTAFF_HOME=~/rstaff-home
cd <work-dir> && claude
```

Run the experiment:

```text
/rstaff-ai:experiment --confirm
```

To score the current prompt alone, run `/rstaff-ai:eval`.

Keep these files for custom tasks: `cases.jsonl` (inputs/answers), `prompts/control.md` and `prompts/candidate.md` (prompts), `grade.js` (scorer), `run.js` (runner). Run `/rstaff:setup <work-dir>` again after swapping files.

The optional `claude plugin install rstaff-ai-datadog@rstaff` needs Datadog and its connector.

## Engineer quick start

This path fixes failing tests. Log in:

```sh
claude auth login
```

Install plugins. Installing `rstaff-engineer` also installs `rstaff-pm` and `superpowers`.

```sh
claude plugin marketplace add obra/superpowers-marketplace
claude plugin marketplace add ryoochi0112/rstaff
claude plugin install rstaff@rstaff
claude plugin install rstaff-engineer@rstaff
```

Copy the sample and initialize git:

```sh
cp -R ~/.claude/plugins/marketplaces/rstaff/plugins/rstaff-engineer/samples/slugify <work-dir>
cd <work-dir>
git init && git add -A && git commit -m sample
claude
```

Setup the work folder and start Claude Code:

```text
/rstaff:setup <work-dir>
```

```sh
export RSTAFF_HOME=~/rstaff-home
cd <work-dir> && claude
```

Ask Claude to do the task in `<work-dir>/TASK.md`. Then run the check:

```sh
make verify
```

Ask for a fresh review:

```text
/rstaff:review HEAD
```

## Allowlisting your verify command

An allow rule like `Bash(make verify)` does not match the rewritten verify command. The fix is the anchored allow rule `Bash(node '<plugin root>/scripts/verify-run.js':*)`. Never use a wildcard rule for `verify-run.js`.

## More

- [docs/index.md](docs/index.md) - The plain-words explainer: a colleague, not a copilot (home page of the Pages site)
- [USAGE.md](docs/USAGE.md) - Full walkthrough of the role toolkit, also Codex delegation
- [AUTONOMY.md](docs/AUTONOMY.md) - Safety rails, caps and the kill switch
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - System architecture
- [ROLES.md](docs/ROLES.md) - The on-demand roles
- [SECURITY.md](SECURITY.md) - Security policy and threat model
- [CONTRIBUTING.md](CONTRIBUTING.md) - Guidelines for contributing
- [CHANGELOG.md](CHANGELOG.md) - History of changes
- [THIRD_PARTY.md](THIRD_PARTY.md) - Third party licenses and attributions
- [LICENSE](LICENSE) - MIT license terms

## License

MIT, copyright Ryo Ochi. Borrowed mechanisms are MIT-licensed and attributed in `THIRD_PARTY.md`.
