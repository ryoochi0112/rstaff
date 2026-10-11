# Git workflow rules (always-follow)

> Seeded/adapted from ECC `rules/common/git-workflow.md`.

- Never commit directly to the default branch when a change is non-trivial — branch first.
- Commit/push only when the human asks, or when a command (`/ship`) explicitly does so.
- Small, atomic commits with clear messages; no force-push to shared branches.
- Run `make verify` before committing. Never `--no-verify`.
- PRs: include what changed, why, how it was verified, and any follow-ups.
