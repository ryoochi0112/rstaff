---
description: OpenAI/codex shortcut for /consult — route the current plan, diff, or question to Codex for a read-only cross-model review, then reconcile. Equivalent to `/consult codex $ARGUMENTS`.
argument-hint: [plan | diff | review | "<specific question>"]
allowed-tools: Bash, Read, Grep, Glob
---

Convenience alias — **equivalent to `/consult codex $ARGUMENTS`**. Run `/consult`
with adapter `codex` and the rest of `$ARGUMENTS` as the artifact selector: same
availability check, artifact assembly, read-only `delegate.js` run, and
AGREE/DIVERGE reconcile. See `/consult` for that logic — it is not duplicated
here.

Two things worth knowing that are specific to this adapter:
- Codex runs via `codex exec` (read-only: `-s read-only`; `review` artifact:
  `exec review --base main`) — never `execute` from this command.
- `AGENTS.md` is Codex's project guidance (it already encodes our rules).
  Unless a `--model` is passed through, Codex uses your `~/.codex/config.toml`
  default (e.g. `gpt-5.6-sol`).

Best used at high-stakes moments: a locked plan or a risky diff.
