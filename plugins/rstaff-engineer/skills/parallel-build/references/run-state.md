# Run state — status file + resume, reference companion to `../SKILL.md`

How a feature's progress is persisted in the control repo and recovered after a crash,
compaction, or restart. Read this when writing the status file, or when reasoning about
why the reconcile step at the top of the loop is shaped the way it is.

Both artifacts live in `$CTRL` (the control repo), never in the product tree — see
"Paths are absolute" in `../SKILL.md`.

## Status file (per feature, one writer)

After every task the runner rewrites `$CTRL/var/dispatch/<repo>/<slug>.md` so `/cockpit`
can show progress without opening product repos. `lib-state.js` under the root returned by `locate('rstaff-backlog')` (skip when absent) parses
these keys, so keep the names exact:

```markdown
# <repo> / <slug>
state: building | ready_for_review | needs_human | stopped | shipped
worktree: <path>    branch: feat/<slug>
tasks: 3/5 done (1 parked: T4 — verify failed 3×; hypothesis: …)
last_commit: a1b2c3d    updated: <ISO8601>
next_human_action: none | run /review in the worktree | decide: <question>
```

One writer per file: the feature's own runner. Nothing else writes it.

**A status file MUST carry a parseable `state:`, or it is not a run.** `collectDispatch`
emits a row only for a file with a non-empty `state:`, so a file without one is excluded
entirely rather than rendered with an empty state. The spelling is exact: `status:` is not
a second spelling the parser learns, and a file using it goes invisible. `/health` FAILs
any top-level `var/dispatch/<repo>/*.md` with no parseable `state:`, so an excluded file
is always named rather than silently dropped.

**Per-task writer briefs go in `$CTRL/var/dispatch/<repo>/briefs/`, never at the top
level.** Only top-level `*.md` files are read as runs; subdirectories are not. A brief
left at the top level has no `state:` and is therefore already excluded, so the directory
is defence in depth rather than the mechanism — but it also keeps `/health` quiet, since
the check that names stateless files does not look inside `briefs/`.

## Resume — the survivability property

Re-running `/build` (or `/dispatch <slug>`) reads the ledger **from `$CTRL`** and
continues from the first non-`done` task. Because the ledger lives in the control repo
and not on the branch, it survives compaction, restarts, and even discarding the
worktree — the same way `/build` reads `profiles/`.

**This is the property to test hardest.**

## Why the loop reconciles against git first

The code commit (product repo) and the ledger-row write (`$CTRL`) are two separate
steps, so a crash can land between them. That is why the loop's first action every
iteration is to reconcile the ledger against git:

- For each non-`done` task, if a branch commit carries its `rstaff-task: <slug>/<id>`
  trailer, mark it `done` with that sha.
- Any `in_progress` task with **no** such commit crashed mid-flight (the implementer
  never commits) and is reset to `pending`, to be redone from scratch.

**Match the trailer exactly.** Anchor it:

```bash
git log --grep '^rstaff-task: <slug>/<id>$'
```

Never match a bare id substring, or `T1` also matches `T10`.

This keeps resume idempotent across the gap between the commit and the ledger write: a
committed task is never re-run, and a never-committed one is never skipped. Because the
checkpoint commit is a single commit of code only, there is never a half-committed task
to corrupt.

## Who owns "this run is finished"

The same gap exists after the run ends: a feature merges, its branch is deleted, and
nothing writes the status file again. So the two halves are owned separately.

- **git owns "the branch is gone."** `/cockpit` reconciles every row against the repo's
  live refs (`refs/heads` ∪ `refs/remotes/origin`) at read time — see `collectDispatch`
  in `lib-state.js` under the root returned by `locate('rstaff-backlog')` (skip when absent). A row that declares a `state:` and whose `branch:`
  names a ref the repo no longer has is marked stale on screen, withheld from "Attention
  next", and cannot promote its linked ticket to the top of the queue. (A file with no
  parseable `state:` is not a run at all and never becomes a row, so there is nothing to
  reconcile — see the MUST above.) This is mechanical, so an abandoned, renamed, or
  superseded branch goes stale without anyone remembering to say so.
- **`shipped` records that a human declared it finished.** It is advisory. Nothing depends
  on it. The runner never writes it — it stops at `ready_for_review` and never ships — so
  this is the one value an *operator* adds by hand, after the run. Reach for it when a run
  ended in a way git cannot show.

Because staleness is derived, `branch:` is the load-bearing field: keep it a **slash-bearing**
ref (`feat/<slug>`) with any prose *after* it. `feat/x (merged, deleted)` parses, and so does
`feat/x pushed; gate green` — trailing prose is fine in either punctuation-led or word-led
form. What does not parse is a value naming no ref (`(deleted — merged)`) or one whose
leading token carries no `/`: `renamed to feat/new` yields `''`, not `renamed`, because a
fabricated ref would produce a fabricated *stale* verdict. That also means a slash-less real
branch (`main`, `hotfix`) reads as unknown rather than resolving — write `feat/<slug>`. A
leading `origin/` is stripped before lookup, so `origin/feat/x` and `feat/x` are the same ref.

## Closing a run by hand — the append block

An operator closing a finished run may either rewrite `state:` in place or **append** a
dated block, which is what the store actually contains:

```markdown
## ship 2026-08-15
state: shipped
pr: https://github.com/<org>/<repo>/pull/17
```

Both are read correctly: `collectDispatch` takes the **last** `state:` in the file, because
`state:` is the one lifecycle field — a later declaration supersedes an earlier one. This is
deliberately scoped to `state:` alone. Every other key is identity or progress that an append
block only restates, so they stay first-match; a repeated `branch:` keeps the clean ref from
the head of the file rather than the block's prose-laden retelling.

Two rules make the append safe:

- **Put the new `state:` in the appended block, not only in prose.** A block that says
  "shipped" in a heading but leaves `state: ready_for_review` above still reads as awaiting
  review, and `/cockpit` will keep recommending it.
- **The one-writer rule still holds for a live run.** Append only after the runner has
  stopped. While a run is in flight its runner rewrites the whole file, and a hand-appended
  block is simply overwritten.
