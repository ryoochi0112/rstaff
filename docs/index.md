# rstaff: a colleague, not a copilot

## In ten-year-old words

Imagine you have a helpful friend who can fix things in your computer code.
You tell them what you need in plain words.
They do not ask you to approve a complex development plan.
Instead, they go to work alone on a separate copy of the files.

Another friend checks their work very carefully to make sure everything is right.
This second friend makes sure they do not make simple mistakes.
When they finish, they show you a pull request (a proposal to change code).
You look at their finished work and simply say yes or no.

## How a run goes

A run is started with the command `node bin/rstaff run <repo> <ticket>`.
The process goes through five clear steps to deliver a safe change.

| Step | Who | What happens |
| :--- | :--- | :--- |
| 1. Job | Explorer | A Claude Code session explores the repository first. It writes three to six checks that run as commands. It sets what not to touch and caps. |
| 2. Worker | Headless Worker | A headless (running with no interactive screen) Claude session gets the job text. It edits a fresh worktree (a separate working copy). |
| 3. Checks | Runner | A simple runner program runs test commands. It writes receipts (written proof showing what ran, its exit code, and the unique commit ID). |
| 4. Referee | Referee | A referee (a separate safety session with read-only tools) reviews the diff and receipts. It accepts or rejects the changes. |
| 5. Draft PR | Runner | On accept, the runner opens a draft PR (a pull request marked not ready to merge). It includes a "What changed" summary and costs. |

You can stop any run at once by creating the stop file `var/.STOP`.
The run also stops immediately if it reaches its time or money limits.
If a run passes one hour and the first version is green, the runner writes a short progress note.
You can open this note to check the worktree, the branch, or the patch.
The runner never merges your code because merging is always your decision.

## What makes it a colleague

The core of rstaff is being a trusted professional colleague, not a copilot.
A copilot asks you to approve every small step, but a colleague takes ownership.

- **Never asks you to approve a plan.** It decides how to build the solution and owns the entire implementation.
- **Asks at most one question per ticket, about the outcome.** It asks only when the repository cannot answer the question.
- **Shows a draft PR instead of a status report.** You receive a working prototype to review instead of empty text updates.
- **Writes down what it could not verify.** It keeps going and clearly lists any unverified details.
- **Checks first only before a one-way door.** It asks for permission only for actions that cannot be easily undone (a one-way door).
- **Is judged on the chat as well as the code.** You judge the colleague on its behavior, chat answers, and communication.
- **Earns trust like a new hire.** It starts with small tasks and earns bigger tickets as it completes work.
- **Never hides uncertainty.** It shows exactly what is unverified and never claims a task is done without running the checks.
- **Requires minimal operator effort.** You give the ask in your own words, answer rare questions, and decide on one-way doors.

## The record so far

The system has completed five real tickets across two product repositories on day one, and the operator accepted all five.

| # | Repo | Rounds | Minutes | Cost (USD) | Referee | Operator |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | A (TypeScript) | 2 | 17.5 | 2.35 | Accept | Yes |
| 2 | A (TypeScript) | 1 | 56.6 | 2.58 | Accept | Almost Yes |
| 3 | B (Python) | 1 | 4.4 | 1.54 | Accept | Yes |
| 4 | A (TypeScript) | 1 | 26.5 | 3.89 | Accept | Yes |
| 5 | A (TypeScript) | 1 | 46.2 | 4.03 | Accept | Yes |
| Total | | 6 | 151.2 | 14.39 | | 5 Yes |

Cost figures are nominal dollars (the token price reported by the API), but the enterprise subscription has no separate bill.

The first run of ticket 5 was stopped by hand when a test failed due to file list limits.
The worker was allowed to change a config file but not a generated report file.
The second run was left entirely unwatched for 46 minutes while the operator was away.

Every feature in the tool is earned by a real failure.

| Failure | Piece added |
| :--- | :--- |
| A flaky test failure sent the worker into an unwinnable round | Verify re-run feature (0.13.4) |
| Worker edited an unrelated test file and the referee accepted it | Enforced file list from diff (0.13.4) |
| A PR had an overly long 66-line description | Short structured PR body with five reasons (0.13.4) |
| Operator wanted a clearer overview during reviews | Highlighted "What changed" callout sentence (0.13.5) |
| A worker kept going for 22 minutes after the stop file was raised | The runner polls the stop file while a worker runs and ends it at once (0.13.6) |

## What it is not

This page is honest about the limits of the system.

- **Not a copilot.** It never asks you to approve plans or tasks. Any plan approval request counts as a run failure.
- **Not finished.** It is in week one of a four-week redesign. It still needs to resume stopped runs and to check the Claude login before a run starts.
- **Not a claim beyond the record.** The goal is to finish three of five tickets alone with zero reverts. It still must prove overnight runs and zero reverts.
- **Not a security boundary.** It blocks honest mistakes but does not stop deliberate evasion. The Write tool restriction has a gap where shell redirects can still write outside the worktree. Read more in [SECURITY.md](https://github.com/ryoochi0112/rstaff/blob/main/SECURITY.md).

## Where to go next

Explore the files to get started with the system.

- Read the [README](https://github.com/ryoochi0112/rstaff#readme) for installation steps and quick starts.
- View the [SECURITY.md](https://github.com/ryoochi0112/rstaff/blob/main/SECURITY.md) to understand the safety gates.
- Learn about safety rails and limits in [AUTONOMY.md](AUTONOMY.md).
- See the map of components in [ARCHITECTURE.md](ARCHITECTURE.md).
