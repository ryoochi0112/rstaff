# Worktree recipe (shared by `/dispatch` and `/sweep`)

Git worktrees give each parallel feature (or maintenance task) its own working
tree + branch, so concurrent work can't collide in one checkout.

## Lifecycle

```bash
# Create — one per feature, named off the slug, on a fresh branch.
git worktree add ../<repo>-worktrees/<slug> -b feat/<slug>

# Set it up (subagents get NO SessionStart injection — paste the profile's setup).
#   e.g. a pnpm monorepo: `pnpm install && pnpm build` (type-check fails without build)

# … run the dispatch loop inside the worktree …

# Before removal: reconcile any parked work. `git worktree remove` refuses a dirty
# tree (by design) and won't touch the shared stash stack, so orphaned parked
# stashes would be silently lost once you move on.
git stash list | grep "rstaff parked <slug>"   # if any: pop/apply or explicitly drop, with the human
git worktree remove ../<repo>-worktrees/<slug>  # aborts if the tree is dirty — resolve first
git worktree prune
```

## Rules
- **Setup cost is real.** Each worktree needs the product profile's setup commands
  (a fresh node_modules, a build). Preflight should state it; it's why `/dispatch`
  caps concurrent features (default 3).
- **Verify contention.** *Cheap* verify (type-check / unit / lint, no ports/services)
  is parallel-safe — run it per task in each worktree. Anything needing a database,
  a port, real APIs, or a browser (**`verify:full`**) is **ship-time and serial** —
  never run it concurrently across worktrees. The product profile marks which is which.
- **Parking is non-destructive:** `git stash push -u -m "rstaff parked <slug>/<id>"`.
  Never `git clean`/`git reset --hard` in an unattended runner — those hit the
  guard-bash ask-gate and would stall a headless loop (and can lose work). A parked
  stash is only truly non-destructive if it's later restored — so reconcile it
  before removing the worktree (above), never drop it silently.
- **Cleanup happens at `/ship`,** with the human present — not mid-loop.
- **Stale-run lock:** a fresh (`<24h`) `building` status file in
  `var/dispatch/<repo>/<slug>.md` means a run may be live; don't double-dispatch
  the same feature unless the human overrides.
