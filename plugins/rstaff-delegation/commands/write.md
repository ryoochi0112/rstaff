---
description: Human-read Document Writer — gather cited facts, get a Gemini draft, and write it only after your confirmation.
argument-hint: <what> [--to <path> | --notion <parent>]
allowed-tools: Bash, Read, Grep, Glob, Write, AskUserQuestion
---

Act as the **Human-read Document Writer**. Request: **$ARGUMENTS**

The contract is brief → Gemini draft → human confirmation → write. Claude gathers
facts and performs the approved write. Gemini drafts only from the brief. Never
write the destination before approval.

No Notion MCP tool is wired in this plugin, so Notion creation is not supported yet. If `--notion <parent>` is given,
stop with: **Notion creation is not supported yet; use `--to <path>`.** Do not treat
that option as a silent no-op. Otherwise require exactly one `--to <path>` target.

1. **Gather facts into the brief.** Parse `<what>` and read the relevant files,
   docs, manifests, and configuration. Before any Gemini call, Claude writes a
   scratch brief outside the repository using
   `${CLAUDE_PLUGIN_ROOT}/templates/brief-doc.md` as its shape. Fill in Audience, Purpose,
   numbered Facts, Decisions, Constraints, Style, and Do-not-invent. Keep the
   template's first Constraints bullet (one-shot, non-interactive: nobody can
   answer questions; return only the document). Every fact
   must cite the file and line Claude read, where relevant. Count the facts and
   decisions for the draft header. This is evidence gathering, not a Claude
   prose draft; do not call Gemini yet and do not write the destination.

2. **Warn once before the first Gemini call.** Maintain a local
   `warned_this_session` flag, initially false. Before the first delegate call,
   print exactly one line: **The brief leaves the machine; it goes to Vertex AI.**
   Set the flag true. If the user chooses B, keep the flag true for the one
   re-draft, so the warning is not repeated. Commands have no persistent
   session-state pattern in this repository, so “once per session” is
   implemented as once per `/write` invocation.

3. **Check Gemini and get the draft.** Run `command -v gemini` before invoking
   the adapter. If it is unavailable, print exactly the health install fix and
   stop:

   ```text
   gemini unavailable — FIX: npm i -g @google/gemini-cli
   ```

   Never fall back to Claude prose. If Gemini is available, choose a scratch
   `$draftFile` outside the repository and run the following command with the
   temporary brief and a slug made from `<what>`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate.js" gemini draft \
     --brief "$briefFile" \
     -o "$draftFile" \
     --label "${repo}/write/${slug}" > "$resultFile"
   ```

   Capture the command's stdout in `$resultFile`, a temporary file outside the
   repository. The command may exit 1 because the normalized result has
   `ok: false`; still read and parse its JSON line. Require `ok: true` from the
   envelope, then read the draft text from `$draftFile`. If the result is not
   usable, show `stderrTail`, `timedOut`, and `exitCode`, then stop without
   writing. For an ADC or authentication failure, include this exact health fix:

   ```text
   FIX: gcloud auth application-default login
   ```

   An empty draft, timeout, unknown model, or other nonzero result is a visible
   failure. Never select a fallback model. Remove temporary files when done.

4. **Show the draft verbatim.** Count the numbered Facts and Decisions in the
   brief, then print this header with those counts and the fixed model name:

   ```text
   Draft from gemini-3.8-flash (brief: 6 facts, 2 decisions). Not yet written.
   ---
   ```

   Print the exact contents of `$draftFile` between that `---` and a second
   `---`. Do not summarize, reflow, fact-check, or add a Claude passage between
   the delimiters. Then print the confirmation question, using the approved
   target:

   ```text
   Write to <path>?  A. yes  B. edit first  C. discard
   ```

5. **Confirm before writing.** Call `AskUserQuestion` with exactly these choices:
   A — write; B — edit first; C — discard. On A, and only on A, use `Write` to
   create or update the `--to <path>` file. Create its parent directory only at
   this point. Never write the target during fact gathering or drafting. There
   is no Claude fact-check pass between the draft and this gate.

   On B, ask what to change, update the temporary brief, and loop once through
   step 3, then show the new draft and ask for A or C. Do not repeat the warning
   because `warned_this_session` is already true. A second B is not another
   loop; tell the user to rerun `/write` or choose C. On C, remove the temporary
   files and stop. A discarded or unapproved draft must never be written.
