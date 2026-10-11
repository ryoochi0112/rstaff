# rstaff — external-agent routing guidance

rstaff supports two Codex modes:

1. **Interactive host:** when the human opens this repo in ChatGPT/Codex, use repository tests and gates directly. rstaff's hooks and the ledger dispatcher are Claude-hosted and do not run here.
2. **Delegated worker:** when Claude Code invokes `codex exec`, act only as the
   advisor or executor described below. Registered adapters live in
   `plugins/rstaff-delegation/scripts/delegate.js`.

## If you are an advisor
- Independent review of a plan or diff (`/consult <model>`; `/codex` is a thin
  alias for `/consult codex`) at high-stakes moments — the way gstack uses its
  `/codex` command.
- You get no vote: Claude reconciles AGREE/DIVERGE; the human + Claude decide.
- Report blocking issues only; be specific (file:line, why, suggested fix).
- Runs are read-only unless explicitly asked to edit (`codex -s read-only`).
- Native `codex exec review` exposes no explicit sandbox flag. rstaff's
  mechanical task gate therefore uses generic `codex exec -s read-only` with a
  structured review packet; native review remains an explicit advisory route.

## If you are an executor
Invoked via `/dispatch --impl <backend>` (or `/build … --impl`) to implement one
ledger task inside its worktree (`delegate.js <adapter> execute`). Hard
expectations:
- Write **only inside the given worktree.** **codex** is mechanically
  sandboxed there (`-s workspace-write -C <worktree>`); never
  `danger-full-access` / `--dangerously-bypass-*`.
- `make verify` is the quality gate and must pass.
- You do **not** self-approve. `route.js` persists an independent reviewer before
  work starts; external writers are always reviewed by fresh Claude. You never
  commit or edit the ledger.
- Never bypass hooks; never `--no-verify`.
- Keep the diff surgical and on-scope to the task brief you were given.
- Return a compact status; put detailed evidence in the report file named by the
  brief. rstaff captures `codex exec --json` usage separately, so never dump the
  raw event stream into the report.

## Durable context
- rstaff is an **engineering** team. Per-repo operating context lives in the
  control repo's `profiles/<repo>.md` (verify/run/QA commands + focus); provisional
  engineering learnings in `LEARNINGS.md`. Company strategy is not part of rstaff
  (see `docs/ARCHITECTURE.md`).
- Conventions: `plugins/rstaff/rules/security.md`, `plugins/rstaff-engineer/rules/{testing,git-workflow}.md`.

## Install / wiring
- `codex exec` reads this file as project guidance.
- In delegated mode, Claude Code stays primary. The human owns irreversible
  decisions.
