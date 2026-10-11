---
description: Second opinion — route plans, diffs, or deep ledger consultations to a registered external model (codex or astra deep) for a read-only cross-model review, then reconcile.
argument-hint: <model> [plan | diff | review | "<specific question>"] | astra deep <topic> ["<question>"] [--effort high|xhigh|max] [--scope <repo>]
allowed-tools: Bash, Read, Grep, Glob
---

Get a **cross-model second opinion** from a registered external model. Claude
Code stays primary and does the reconciling — the external model only advises,
it never gets a vote. Codex wiring goes through
`${CLAUDE_PLUGIN_ROOT}/scripts/delegate.js`, while Astra Deep utilizes
`${CLAUDE_PLUGIN_ROOT}/scripts/consult-ledger.js` and
`${CLAUDE_PLUGIN_ROOT}/scripts/consult-astra.js`.

1. **Parse `$ARGUMENTS`.** First token = adapter: `codex` or `astra`.
   Everything after it selects the mode or artifact.
   - For `codex`, the next token selects the artifact: `plan` | `diff` | `review` | a free-text question.
   - For `astra`, the next token must be `deep`. The remaining arguments follow: `<topic> ["<question>"] [--effort high|xhigh|max] [--scope <repo>]`.
   - If no first token is provided, or if it isn't a registered adapter, list the registered adapters (`codex`, `astra`) and stop.

### codex — standard consultation

If the adapter is `codex`, follow these steps:

2. **Check availability before anything else — never fabricate a second
   opinion.** This is the same probe `delegate.js` uses internally:
   `command -v codex`. If the bin isn't on `PATH`, say so plainly and stop — do
   not proceed to assemble an artifact.

3. **Assemble the artifact**, then write it to a temp file so it can be passed
   via `--prompt-file` (never inline the whole thing on the command line):
   - `diff` → `git diff main...HEAD`
   - `plan` → the relevant spec (`$CTRL/var/specs/<repo>/<slug>.md`, in the control repo)
   - `review` → prefer `delegate.js`'s dedicated `review` mode over a
     hand-assembled prompt (codex: `exec review --base main`) — the temp
     file here is optional custom review instructions, not a full diff dump
   - anything else → treat the rest of `$ARGUMENTS` as a free-text question;
     write the question plus minimal supporting context (e.g. a short diff or
     plan excerpt) into the temp file

4. **Run `delegate.js`, read-only — never `execute` from this command:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate.js" <adapter> <advise|review> \
     --sandbox read-only --prompt-file <tmpfile> \
     [--model <m>] [--base main] \
     [--output-schema <schema.json>] \
     --label "<repo>/consult/<artifact>" \
     [--timeout 1800] > <result-file>
   ```
   Use `advise` for `plan`/`diff`/question artifacts, `review` for the `review`
   artifact. `delegate.js` enforces the read-only shape per adapter — codex gets
   `-s read-only` — you just never
   ask it for `execute` here. Usage logging is automatic. Prefer
   `--output-schema` for
   a structured verdict when the adapter supports it. Capture the result to a
   file you control and read that back — don't scroll the raw transcript.
   Read the normalized `{ok, text, structured, timedOut, exitCode}` result:
   `timedOut` or `ok:false` means a partial or no-usable-opinion result — report
   that plainly, don't retry silently.

5. **Reconcile.** Present where the external model **agrees** with your own
   analysis (treat that as higher confidence) and where it **diverges** —
   divergences are where you should look hardest. Use `AGENTS.md` as the
   external model's project guidance (it already encodes our rules). The
   external model gets **no vote**; you and the human decide.

6. **Cost note:** `/consult` is an explicit, cost-incurring call (see
   `docs/AUTONOMY.md`) — reserve it for high-stakes plans and risky diffs, not
   routine checks. Inspect measured usage with `/rstaff-usage:spend`; do not infer API dollars
   from ChatGPT-subscription token use.

### astra deep — persistent consulting ledger

For complex, multi-turn design and architecture consultations, Astra Deep provides a persistent, multi-turn consulting ledger. Astra runs as a strictly read-only advisor: it never runs `execute` and never modifies files.

1. **Check availability before anything else — never fabricate a second
   opinion.** Confirm the core dependency is available by running `command -v codex`.
   If the binary is not on `PATH`, report this plainly and stop immediately.

2. **Resolve the ledger path:**
   Invoke `consult-ledger.js` to determine the path to the ledger file:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-ledger.js" path \
     --ctrl "$RSTAFF_HOME" \
     --scope "<scope>" \
     --topic "<topic>"
   ```
   - The `--scope` argument defaults to the current repository directory name, or `_new` when executed outside of any repository.
   - The `--topic` is the raw topic text; the script slugs it.

3. **Kickoff brief (for new ledgers):**
   If the ledger does not exist at the resolved path, conduct a 2–3 question kickoff brief with the user, presenting one question at a time. Collect the following details:
   - `goal`
   - `constraints`
   - `decided` (definition of what is decided)
   - `known` (what is known so far)
   
   Once collected, serialize these answers as `{topic, scope, goal, constraints, decided, known, date}` (`date` = today, `YYYY-MM-DD`) into a temporary JSON file and initialize the ledger:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-ledger.js" init \
     --file <ledger-path> \
     --json <tmp-kickoff.json>
   ```

4. **Print confirmation:**
   Print exactly one confirmation line highlighting the configuration and wait for an explicit, interactive go before executing (no silent or auto-runs):
   ```
   gpt-6-astra · effort=<effort> · search=on · <topic> · <new|resume>
   ```

5. **Run the consult:**
   Assemble the user's question and context into a temporary prompt file, then execute the consult tool:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-astra.js" run \
     --ledger <ledger-path> \
     --prompt-file <prompt-file> \
     [--effort <high|xhigh|max>] \
     [--timeout <timeout>] \
     [--cwd <cwd>]
   ```
   Capture the stdout JSON result: `{ok, text, threadId, continuity, usage, effort, timedOut, refused}`.
   - If `refused` is true, or if `ok` is false: report the failure plainly to the user, exit, and write nothing to the ledger. Do not retry a failed reseed.

6. **Reconcile:**
   Analyze the advisor's response. Present where Astra **agrees** with your analysis (enhancing confidence), where it **diverges** (requiring closest scrutiny), and what remains **unverified**. You must manually check at least one cited URL for load-bearing claims.

7. **Commit turn and update headers:**
   After reconciliation, append the turn to the ledger and update its summary section:
   - Append the turn:
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-ledger.js" append \
       --file <ledger-path> \
       --json <turn.json>
     ```
     The JSON payload is `{n, at, effort, search, continuity, question, answer, reconcile, usage}`.
     - Always pass an explicit `n` in the payload: the count of existing `### T` lines in the ledger, plus one (turns are 1-based).
     - `usage` is `{input, cached, output, reasoning}` (token counts).
     - Indent (e.g. prefix one space) any user or advisor text line that is exactly `## Log`, since the ledger parser splits on that line.
   - Update the ledger's metadata and structured headers:
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-ledger.js" header \
       --file <ledger-path> \
       --json <header.json>
     ```
     The JSON payload is `{fields: {thread, status}, sections: {"Current conclusions", "Open questions", "Decisions"}}`. Set `fields.thread` to the run result's `threadId` only when it is non-null; otherwise omit `thread` from `fields` (keeping the previous id).

8. **Suggest promotion:**
   If new decisions are recorded, suggest a concrete promotion target (such as a strategy repo, `backlog`, or `spec`). Never perform auto-promotion.

9. **Cost note:**
   Astra Deep is highly cost-incurring. Each call utilizes approximately 15K framing tokens for context framing. Selecting higher effort levels with search enabled heavily consumes your weekly quota. Use it selectively.
