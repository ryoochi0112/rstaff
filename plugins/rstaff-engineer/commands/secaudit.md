---
description: Security — a deeper OWASP/secret/trust-boundary pass on the pending diff at PR time. Delegates to the built-in security-review skill when present; else runs the core security checklist. Blocking findings only; never edits.
argument-hint: [base ref, optional]
allowed-tools: Bash, Read, Grep, Glob, Task, Skill
---

Act as the **Security reviewer**. The always-on `secret-scan` hook is the cheap
inline layer; this is the deliberate PR-time pass. **Read-only** — you report,
you never edit or "fix" in place.

1. **Scope the diff — in the TARGET repo.** First confirm cwd is the **product
   repo**, not the rstaff control repo (`$RSTAFF_HOME`): the built-in
   `security-review` skill diffs the *current* repo, so from the control repo it
   audits the wrong tree (this has happened). Pass the product repo's absolute path
   explicitly; loudly warn and stop if cwd isn't the product repo. (Exception:
   auditing rstaff *itself* — then the control repo IS the target.) Then:
   `git diff $ARGUMENTS` (default `git diff main...HEAD`), or `gh pr diff <n>`.
2. **Prefer the built-in reviewer:** if a `security-review` skill/command is
   available in this session, run it over the diff, then reconcile its findings
   against the pre-merge checklist in root `SECURITY.md`. If it isn't available,
   fall back to walking the checklist yourself over the diff:
   - **Secrets** — the `secret-scan.js` known-prefix formats + any credential-shaped literal.
   - **Injection** — SQL/shell/template/path built from untrusted input; parameterize.
   - **AuthZ** — protected paths guarded; no missing ownership/tenant checks.
   - **Untrusted-input-as-instruction** — new paths where web/MCP/PR/file content
     could steer control flow (per `$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/rules/security.md`).
   - **Deps** — new/updated dependencies reviewed; no unvetted transitive risk.
   - **Error hygiene** — no internal detail / stack traces leaked to users.
3. **Report blocking only:** `BLOCK | PASS`, each finding with file:line, the
   concrete exploit/impact, and a suggested fix. Rank CRITICAL/HIGH first; these
   map onto the shared gate as **CRITICAL → P0, HIGH → P1**
   (`$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/rules/review-severity.md`). On a CRITICAL finding,
   recommend fixing + rotating any exposed secret and calling the rotation out in
   the PR. Route fixes back through `/build`, then re-audit.
