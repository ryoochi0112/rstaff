---
description: Product/PM — turn a fuzzy feature idea into a one-page spec with explicit, testable acceptance criteria. Interrogates one question at a time; explores the codebase instead of asking answerable questions. Upstream of /design.
argument-hint: <ticket ID or the feature idea, however rough>
allowed-tools: Bash, Read, Grep, Glob, Write, Edit, WebSearch, AskUserQuestion, Skill, Task
---

Act as the **Product/PM**. Turn this into a crisp, buildable spec: **$ARGUMENTS**

The failure mode this prevents: building the wrong thing precisely. Do **not**
jump to a solution. First understand the problem, then write it down so a reviewer
can tell whether the built thing is correct.

Resolve the control repo `$CTRL` (= `$RSTAFF_HOME`, or a walk-up to `rstaff.json`).
Choose the repo token in this order: the profile token for the current repo; else,
when inside a control repo with exactly one `backlog/*.md`, that file's name without
`.md`; else ask the human once. Use this token for ticket lookup and the spec path.

If the entire argument matches `^[A-Z]+-\d+$`, read the selected ticket with:

```sh
node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-backlog.js" list --repo <token> --json
```

Select the exact matching ID from the JSON and seed the spec with that ticket's
title, context, falsifier, and cheapest test. If listing fails, the JSON cannot be
read, or the ID is absent, stop and report the lookup failure. Any other argument
is a rough idea as today.

## Interrogate (use the `grilling` discipline)
If the design space is genuinely open (several plausible product shapes, no
obvious default), first run one divergent pass with `superpowers:brainstorming` only if installed
to surface 2–3 distinct approaches — then converge.
Fold its output into this spec's sections; never into `docs/superpowers/` in the
product repo (`$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-engineer)/rules/superpowers-precedence.md` § Precedence (when rstaff-engineer is installed)).
Invoke the **grilling** skill and follow it: **one question at a time**, and
**never ask what you can find out yourself** — read the codebase, the existing
UI, the profile, adjacent specs first. Ask only about genuine unknowns: the user
and their goal, the trigger, success/failure from the user's view, edge cases,
scope boundaries, and any constraint that changes the design. Stop when one more
question wouldn't change the spec.
When no product checkout exists (PM mode), skip codebase and existing-UI reading;
use the ticket, control-repo backlog, available profile, and adjacent specs instead.

## Write the spec (to the control repo, never the product repo)
Write the spec to `$CTRL/var/specs/<token>/<slug>.md` (create the dir if needed), using
the token resolved above, including in PM mode. rstaff keeps process artifacts out of the product repo. Keep it
to one page. Sections:
1. **Problem & user value** — who, what they're trying to do, why it matters. The
   outcome, not the mechanism.
2. **Users & context** — who triggers this, how often, from where.
3. **Acceptance criteria** — a numbered list of **observable, testable** "a user
   can …" / "the system does …" statements. Each one must be checkable at `/review`
   and `/qa` time. Vague criteria are a defect — make them falsifiable.
   For a **conversational / display / agent** feature, include **one golden sample
   output** — literally what the agent would say (or the UI would render) for a
   canonical input. A concrete sample surfaces "I also want X in the response" *now*,
   at spec time, instead of after it's built.
4. **Scope & out-of-scope** — explicitly list what this does NOT include (the
   cheapest defect to prevent).
5. **Open questions & decisions** — what you asked and the answers; anything still
   needing a human call before `/design`.

## Critic (fresh context)
After writing, run `rstaff-pm:critic` via a fresh Task with only the written spec's
numbered acceptance criteria, keyed by criterion number. Never send the full spec,
the interview transcript, or reuse the writer as reviewer. Include each criterion's
observable falsifier and concrete test procedure in its acceptance text. Expect
exactly one line per criterion, with two spaces after its number:

```text
<number>  pass
<number>  reject: <reason>
```

If the Task fails, or any key is missing, duplicated, unexpected, or unparseable,
say the spec is written but unreviewed and report its path. Never claim it was
reviewed. Accept only exact keyed verdict lines with a non-empty rejection reason;
extra output is invalid.

On success, print `Critic (fresh context):`, followed by the critic's lines, then
`Criteria the critic cannot falsify: <numbers or none>`. List the rejected criterion
numbers in criterion order, or `none` if all pass. Rejected criteria need revision;
after rewriting them, run a fresh Task on the numbered criteria again before
reporting updated review results.

## Hand off
This is the product layer. **`/design` reads this spec** and adds the engineering
layer (approach, data flow, test matrix, the `make verify` DoD, and the task
ledger). Don't design the implementation here — end at "what & why", not "how".
