---
description: Evaluator — score agent-generated output against a rubric in a fresh, independent context (deterministic checks + grounded LLM judge). Drives the product repo's own eval harness via its declared adapter; never self-evaluates. Blocking gate = minScore.
argument-hint: [repo or target] [--adapter <name>] [replies.jsonl]
allowed-tools: Bash, Read, Grep, Glob, Task
---

Run an **independent evaluation** of agent-generated output. The output's author does
not score it. Follow `${CLAUDE_PLUGIN_ROOT}/rules/evaluation.md`.

1. **Confirm the target — not the control repo.** Evaluate the **product repo's** agent
   output, not rstaff. If cwd is the control repo (or `$RSTAFF_HOME`), pass that repo's
   absolute path as the target. Loudly warn and stop if you cannot confirm the target.
2. **Read the target adapter.** Load the target profile at
   `$CTRL/profiles/<repo>.md`. Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/adapter.js" "$CTRL/profiles/<repo>.md"`,
   adding `--adapter <name>` when supplied. Exit 1 stops with the missing-entry message;
   exit 2 stops with the reader's ambiguity or invalid-entry diagnostic.

   For an entry with `grader: code`, use its declared `run`, `grade`, `dev`, and
   `minScore` fields. If the user supplied a replies file, use that file and skip `run`.
   Otherwise, create `$CTRL/var/evals/<repo>/<run-id>/`, fill the run command's
   `{slug}`, `{split}`, and `{replies}` placeholders (use the value after `=` in the
   entry's `dev` setting; `split=dev` gives `{split}=dev`), and run it for the
   `candidate` arm. If the run command has
   an `--arm` option, set it to `candidate`. Pass the resolved `grade` command, replies
   path, and `minScore` to the eval-runner; fill its `{split}`, `{replies}`, and
   `{grades}` placeholders. The runner executes `grade` and reports candidate results.
   Do not use a model judge for a code grader. If `minScore` is absent, the runner must
   return FAIL/blocked.

   For an entry with `grader: model`, use its run command or saved artifact, rubric(s),
   ground truth, and `minScore` gates. Delegate rubric scoring to the eval-runner.
3. **Delegate to `rstaff-ai:eval-runner`** in a fresh context. For code grading, pass
   only the resolved `grade` command, replies path, and `minScore` (including an absent
   value). For model grading, pass the run or artifact, rubric(s), `minScore` gates,
   and ground truth. Do NOT score the output in this context.
4. **Relay the verdict verbatim:** `PASS | FAIL` with per-case results, the score,
   `minScore`, and failing case ids with evidence. For model grading, report variance
   (N≥3 near a threshold). No praise; a below-threshold score is a FAIL.

If FAIL, route fixes to the agent or prompt in the product repo, then re-run `/rstaff-ai:eval`.
Only a PASS (or an explicit human override) clears the quality gate. Never put personal
data or secrets into the eval report — refer to cases by id.
