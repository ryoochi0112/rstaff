# Surgical changes — restraint & taste

Adapted from the Karpathy guidelines (multica-ai/andrej-karpathy-skills). These
bias toward **caution over speed**. For a genuinely trivial task, use judgment and
don't ceremony it — but when in doubt, follow them.

## The core directive
**Every changed line must trace directly to the request.** Touch only what you
must; clean up only your own mess. If a diff line isn't required by the task (or by
`make verify`), it doesn't belong in this change.

## The rules
- **No drive-by refactoring.** Spot adjacent code that could be better? Leave it, or
  flag it separately (a `/spawn`-style follow-up) — do not fold it into this diff.
  Unrequested "improvements" are how a 5-line fix becomes an unreviewable 200-line PR.
- **Match the existing style.** Naming, structure, comment density, error handling —
  read the surrounding code and conform to it. This change should be invisible in
  the blame except for what it does.
- **Remove only what your change orphaned.** Don't delete code that isn't yours to
  delete just because it looks dead — surface it instead (it may be load-bearing
  elsewhere, or the description may be wrong).
- **Surface hidden assumptions before running with them.** If the request implies a
  choice you're unsure of, ask (see the `grilling` skill) rather than guessing and
  building a pile on top of the guess.

## The self-tests (cheap, run them before you finish)
- *"Would a senior engineer call this overcomplicated?"* If yes, simplify.
- *"If I wrote 200 lines and it could be 50, rewrite it."*
- *"Can I point at the line in the spec/request that each changed file serves?"* If
  not for some file, why did you touch it?

## Escape hatch
Trivial or throwaway tasks don't need this weight. The point is to stop *unrequested
scope* and *premature abstraction*, not to make small changes bureaucratic.
