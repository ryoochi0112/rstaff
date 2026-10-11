---
description: Release Manager — run the gate, branch/commit, push, and open a PR. Refuses if make verify fails. Never bypasses hooks.
argument-hint: [PR title, optional]
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

Act as the **Release Manager** and cut a PR. (Adapted from gstack `ship`.)

1. **Gate first.** Run the repo's verify command (`make verify`, or its product
   profile's `verify` / ship-time `verify:full`). If it fails, STOP and report —
   do not ship. Never use `--no-verify`. (Honor repo release rules from the
   profile, e.g. add a changeset where required.)
2. **Skill-diff eval gate (when armed).** First, unconditionally resolve the
   real base and compute the branch diff with the block below. If the base is
   unresolved, STOP and report — never treat an empty or unset diff as clean.
   This is the single base-resolution block for this flow. The eval gate is
   **ACTIVE as of the AC5 pair recording** in the control repo's
   `$RSTAFF_HOME/specs/skill-evals.qa.md` §22 (2026-08-25) — that recording is
   the evidence for this gate being armed. Use the already-computed
   `changed_paths` output:
   ```bash
   base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"; base="${base:-main}"
   git rev-parse --verify --quiet "origin/$base" >/dev/null || { echo "UNRESOLVED BASE origin/$base — resolve before shipping"; exit 1; }
   changed_paths="$(git diff --name-only "origin/$base...HEAD")"
   printf '%s\n' "$changed_paths"
   ```
   The eval gate is **control-repo-scoped**: `make evals` and the skill eval
   suites exist only in the rstaff control repo, marked by `rstaff.json` at the
   repo root. In any other repo — including a plugin-shaped product repo whose
   diff touches `plugins/*/skills/**` — skipping the eval gate is correct, not a
   bypass; running it there would fail closed on a target that doesn't exist.
   Inside the control repo the gate keeps full fail-closed posture. If any
   changed path matches `plugins/*/skills/**`, derive the touched skill
   name from the first path segment after `plugins/*/skills/`, deduplicate the
   names, and run `make evals SKILL=<skill>` for each one — except a name whose
   `plugins/*/skills/<skill>` directory **and** `plugins/*/evals/<skill>-{trigger,compliance}` suite are
   **both** gone, which is a **deletion** and is skipped rather than run; this is
   the documented way to ship a skill removal. A missing suite alone does NOT
   mean deletion: if the skill directory still exists, the missing suite is a
   **coverage gap** — refuse to ship. (Do not rely on the offline coverage test
   to catch that: it compares `plugins/*/evals/*` against its own pinned roster and
   is a second, independent guard, not a substitute for this one.) Stop on the first
   nonzero exit from a suite that DID run — report it and refuse to ship with
   the same posture as a failed `make verify`; never bypass and never
   continue past an actual failure:
   ```bash
   [ -n "${changed_paths+x}" ] || { echo "changed_paths not computed — rerun the step-2 block"; exit 1; }
   repo_root="$(git rev-parse --show-toplevel)" || { echo "cannot resolve repo root — resolve before shipping"; exit 1; }
   if [ ! -f "$repo_root/rstaff.json" ]; then
     echo "Not the rstaff control repo (no rstaff.json at repo root) — skill-diff eval gate does not apply; skipping."
   else
     touched_skills="$(printf '%s\n' "$changed_paths" | sed -nE 's#^plugins/[^/]+/skills/([^/]+)(/.*)?$#\1#p' | sort -u)"
     if [ -z "$touched_skills" ]; then
       echo "No changed path under plugins/*/skills/** — no evals run."
     else
       while IFS= read -r skill; do
         [ -n "$skill" ] || continue
         suite_exists=0
         skill_exists=0
         for plugin in "$repo_root"/plugins/*; do
           [ ! -d "$plugin/skills/$skill" ] || skill_exists=1
           if [ -d "$plugin/evals/$skill-trigger" ] || [ -d "$plugin/evals/$skill-compliance" ]; then
             suite_exists=1
           fi
         done
         if [ "$suite_exists" = 0 ]; then
           if [ "$skill_exists" = 0 ]; then
             echo "Skill $skill and its plugins/*/evals/$skill-{trigger,compliance} suite are both gone — deletion; skipping."
             continue
           fi
           echo "Skill $skill exists but has no plugins/*/evals/$skill-{trigger,compliance} suite — coverage gap, not a deletion. STOP; do not ship."
           exit 1
         fi
         make evals SKILL="$skill" || { status=$?; echo "Skill eval gate failed for $skill — STOP; do not ship."; exit "$status"; }
       done <<EOF
$touched_skills
EOF
     fi
   fi
   ```
   A diff that does not touch `plugins/*/skills/**` must not run evals at all.
3. **Confirm it was reviewed.** Run this from the product repo:
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib-review-rounds.js" status \
     --repo <repo> --branch <branch> --cwd "$(git rev-parse --show-toplevel)"
   ```
   Proceed only when `reviewed.verdict` is `pass` and `reviewed.current` is
   `true`; treat `current: null` exactly like `false`. Otherwise STOP, print
   `reviewed.reason` and every path in `reviewed.moved` as "these files changed
   after the PASS", then recommend `/review`. Explicit human confirmation may
   still override this gate, as today.
4. **Keep the product repo clean of rstaff artifacts.** rstaff process files — the
   spec, task ledger, QA runbook, blocker notes — live in the **control repo**, never
   the product branch. Scan the `changed_paths` already computed against the repo's
   **real base** (derive it; don't hardcode `main` — a `master`/stacked repo
   would make the guard silently pass). This block is **self-contained on
   purpose**: shell state does not persist between Bash invocations, so a scan
   that reused step 2's `$changed_paths` would read an unset variable, match
   nothing, and report "clean" — a guard that fails OPEN. It recomputes with the
   same base-resolution rule as step 2, and hard-stops rather than scanning an
   empty list:
   ```bash
   base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"; base="${base:-main}"
   git rev-parse --verify --quiet "origin/$base" >/dev/null || { echo "UNRESOLVED BASE origin/$base — resolve before shipping"; exit 1; }
   changed_paths="$(git diff --name-only "origin/$base...HEAD")"
   [ -n "${changed_paths+x}" ] || { echo "changed_paths not computed — cannot scan for rstaff artifacts; do not ship"; exit 1; }
   printf '%s\n' "$changed_paths" \
     | grep -Ei '(^|/)specs/[^/]+\.md$|\.tasks\.md$|\.qa\.md$|\.blocked\.md$|(^|/)BLOCKED\.md$'
   ```
   Step 2 already hard-stops on an unresolved base; never read an unset or empty
   `changed_paths` as "clean." If the grep prints any path, show the list and — with the human — `git rm` those paths
   (removing them from the branch) before proceeding. Do not open a PR that carries
   them. (A `specs/` dir the product itself owns is legitimate — only strip rstaff's
   own process files; when unsure, ask rather than delete.)
5. **Branch.** If on the default branch (`main`/`master`) with a non-trivial
   change, create a topic branch first.
6. **Commit** the change with a clear message (what + why). Small and atomic.
7. **Push** the branch.
8. **Open the PR** with `gh pr create`. Title from `$ARGUMENTS` (or inferred). Body must include:
   - **What** changed and **why**
   - **How it was verified** (`make verify` output summary, `/review` verdict)
   - **Follow-ups / out-of-scope**
9. Report the PR URL. For merge-to-prod + health check, resolve
   `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-engineer)`
   and hand off to `/rstaff-engineer:land`. If absent, say "Engineer layer absent;
   follow the product profile’s deployment and health-check steps."

Only commit/push as part of this flow or when the user explicitly asks.
