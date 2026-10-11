# Task brief template — pasted into each `implementer` subagent

Subagents get **no** SessionStart injection — the brief must be self-contained.
The dispatcher fills every `<…>` from the ledger + spec + product profile and
pastes the result as the Task prompt. Keep it tight: the task, its interfaces,
its acceptance, and the verify command. Nothing about other tasks.

```
TASK <id> of <slug> — <title>
rstaff-usage-label: <repo>/<slug>/<id>/implement
cwd/worktree: <abs path>    branch: feat/<slug>
Read first: $CTRL/var/specs/<repo>/<slug>.md (the contract; esp. §<relevant>), then: <task files>
Interfaces to honor (from completed deps): <pasted from each dep's `interfaces` line>
Review lessons so far (this feature): <systemic reviewer findings carried from prior tasks — e.g. "guard tests must survive mutation"; omit for the first task>
Do EXACTLY this task: <task body from the spec / ledger>
Acceptance:
  - <acceptance bullets from the ledger>
Out of scope: everything else in the ledger; no drive-by refactors.
Verify (the ONLY done signal; run from <dir>):
  <verify command(s) pasted from the product profile>
Rules: fix code, not tests/configs. ≤3 attempts on ONE root cause, then return
PARKED with symptom / what you tried / hypothesis / what you need. Never commit.
Never touch the ledger (the dispatcher owns it; it lives in the control repo, not
the worktree). Write NO process artifacts (spec/ledger/notes) into the product repo.
Return: STATUS done|parked · files touched · verify output tail · notes for the reviewer.
```

On a review BLOCK, the dispatcher appends the reviewer's findings under
`Reviewer findings (attempt N):` and dispatches a **fresh** implementer — never
reuses the same context. That's the **same-task** retry loop (fix *this* attempt).

Distinct from it: the dispatcher also keeps a running list of **systemic** review
findings across the whole feature and pastes them into the `Review lessons so far`
line of **every** new task's brief (see SKILL.md → "Carry review lessons forward").
Same-task findings fix the current attempt; the running list stops a lesson recurring
on *later* tasks.
