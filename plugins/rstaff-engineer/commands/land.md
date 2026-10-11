---
description: Release Manager — merge an approved PR, watch the deploy, and verify production health (canary). Human-gated before the merge. Follows /ship.
argument-hint: [PR number] [prod-url]
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion, Skill
---

Act as the **Release Manager** and land the change to production. (Adapted from
gstack `land-and-deploy` + `canary`.) This is **outward-facing and hard to
reverse** — gate it on explicit human confirmation.

### 1. Identify the PR
From `$ARGUMENTS`, else the PR for the current branch (`gh pr view --json number,title,url,mergeStateStatus`).

### 2. Pre-merge gate (refuse to merge if any fails)
- **CI green:** `gh pr checks <n>` — all required checks passing.
- **Reviewed:** From the PR checkout, run:
  ```sh
  node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-review-rounds.js" status \
    --repo <repo> --branch <branch> --cwd "$(git rev-parse --show-toplevel)"
  ```
  Proceed only when `reviewed.verdict` is `pass` and `reviewed.current` is
  `true`; treat `current: null` exactly like `false`. Otherwise STOP, print
  `reviewed.reason` and every path in `reviewed.moved` as "these files changed
  after the PASS", then recommend `/review`. An explicit human override may
  still proceed.
- **Review is not current (`reviewed.current` not true):** refuse to merge.
- **No conflicts:** mergeable.
- Then **confirm with the human** (AskUserQuestion) before merging. Do not merge
  autonomously — merging to the default branch / triggering a deploy is the kind
  of irreversible action that needs an explicit go.

### 3. Merge
`gh pr merge <n> --squash --delete-branch` (match the repo's convention if different).

### 4. Watch the deploy
If merge triggers a deploy workflow, watch it: `gh run watch <deploy-run-id>` (or
the run for the merge commit). If deployment is via a platform/command configured
for the repo, run it and capture status. If there's no deploy step, say so.

### 5. Canary — verify production health
Against the prod URL (arg or configured): hit the health endpoint + key pages;
watch for 5xx, console errors, and obvious regressions (use the same browser
capability as `/qa` if a URL is given). Compare error rate to baseline if available.

### 6. Record + report
On healthy deploy, refresh the eng cockpit cache
when `BACKLOG_ROOT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-backlog)`
resolves, invoke `/rstaff-backlog:cockpit --write`; skip the cache refresh
when the backlog plugin is absent. Report:
merged commit, deploy status, health verdict.
**If health checks fail, surface it loudly and recommend rollback** — do not call
it shipped.
