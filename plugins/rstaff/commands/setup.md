---
description: Create an rstaff control repo for a product path or a PM product name.
argument-hint: <product-path | product-name> [--home <dir>]
allowed-tools: Bash, Read
---

Scaffold a control repo for the one product argument in $ARGUMENTS. Default home is
`~/rstaff-home`; use `--home <dir>` when supplied. Quote every argument as a shell value.

Route the product argument before expanding it: an argument containing `/` or
starting with `.` or `~` is a path; any other bare word is a name (`./acme` forces
path mode). If a bare word is also an existing directory under the cwd, ask once
which mode is meant (product path or PM name), and wait for the answer.
Expand `~` and resolve home and any product path before invoking the script.

For name mode:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" --home "<home>" --name "<name>"`.
   It prints one JSON object. On exit 1, show the refusal/error and stop.
2. Print exactly this golden-sample shape, substituting home and name:

   ```text
   Control repo created at ~/rstaff-home
     rstaff.json, profiles/, backlog/acme.md, .gitignore (var/)  · git init done
   Mode: PM (no product repo) — done signal: backlog validate (blocks stop when red)
   Next: export RSTAFF_HOME=~/rstaff-home
         cd ~/rstaff-home && claude, then: /rstaff-pm:interview <your idea>
   ```

   Show the created `backlog/` directory as `backlog/<name>.md`. Follow the
   created/unchanged display rules below for reruns and partial scaffolds.
   Keep the PM Mode and Next lines; shell-quote home where needed.

For path mode:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" --home "<home>" --product "<product>"`.
   It prints one JSON object. On exit 1, show the refusal/error and stop.
2. If `needsVerify` is true, ask the user **once** for the product's verify command.
   Wait for the answer, then re-run the same invocation with `--verify "<command>"`.
   Combine the two runs' created lists for this summary. If the answer is empty,
   stop and explain that a verify command is required to create the profile.
3. Print only this golden-sample shape, substituting the paths and results:

   ```text
   Control repo created at ~/rstaff-home
     rstaff.json, profiles/, backlog/, .gitignore (var/)  · git init done
   Profile: profiles/acme-api.md
     verify: make verify   (found in ~/work/acme-api/Makefile)
     adapter: label-exact-match   (from rstaff-adapter.json)
   Next: add to your shell profile →  export RSTAFF_HOME=~/rstaff-home
         then open a session in ~/work/acme-api; the gates are on.
   ```

   For a run with an empty `created` list, replace "created" with "no changes"
   (`Control repo no changes at <home>`) and the created-list line with `  no changes`.
   Otherwise list the created scaffold entries in the sample order; the profile
   has its own line and `backlog/.gitkeep` is represented by `backlog/`. A new
   `.gitignore` is displayed as `.gitignore (var/)`; that same key in JSON means
   `var/` was appended to an existing file, preserving its contents. Show
   `· git init done` only when `git init` is in `created`.
   The Profile line is relative to home. Use `<product>/<verifySource>` for
   detected commands; for `verifySource: --verify`, replace the parenthetical
   with `(provided by you)`. Shell-quote the export value when the path needs it.
   Show the adapter line only when `adapters` is non-empty, with one line per adapter name
   from the result, immediately under the verify line.

   For `verifySource: notebooks` (no Makefile or npm verify, a git repo with
   notebooks), the Profile's verify line is
   `  verify: rstaff:nbgate   (<n> notebooks in <product> — fresh-kernel re-run + run-order check)`,
   with `<n>` from `notebooks`. When the JSON carries `verifyNote`, print it verbatim on
   the line under the Profile line (the product is below its git top-level). Add that
   the user may re-run with `--verify "<cmd>"` to override it.
