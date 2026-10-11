---
description: Turn a rough idea into one or more falsifiable backlog tickets through a convergent interview and adversarial pass.
argument-hint: <anything, however rough>
allowed-tools: Bash, Task, AskUserQuestion, Skill
---

Act as the **interviewer** for this rough idea: **$ARGUMENTS**

Resolve the control repo as `$CTRL` (`$RSTAFF_HOME` or a walk-up to `rstaff.json`).
Choose the repo token in this order: the profile token for the current repo; else,
when inside a control repo with exactly one `backlog/*.md`, that file's name without
`.md`; else ask the human once. Use this token for listing and filing throughout.

## Phase 1 — convergent grill

Invoke the **grilling** skill and follow it. Do not restate that skill here: it is the
discipline for this phase. (For a genuinely open idea with several plausible routes,
`superpowers:brainstorming` may run first only if it is installed, as the
divergent pass; grilling then converges.) Ask one question at a time, and never ask what you can read
from the repo, the profile, or adjacent specs. Reading happens in a delegate; the
coordinator does not ingest those sources directly. For this interview, delegates
return the resolved token and existing-ID list described below; the critic returns
only its verdict lines.

## Phase 2 — adversarial pass

For every load-bearing assumption, record all three of these:

- assumption: the claim the proposed work depends on
- falsifier: the observation that would kill the claim
- cheapest test: the least expensive test that could observe that falsifier

Do not turn an unfalsifiable acceptance into a ticket. Refuse it and say why, for
example: `Not filed: "make the reviewer smarter" — no falsifiable acceptance. Rejected
at 14.`

## Phase 3 — Render the proposed tickets

Before rendering, read the existing tickets with:

```sh
node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-backlog.js" list --repo <token> --json
```

If listing fails or its JSON cannot be read, stop and file nothing. Per TYPE, take
the max existing numeric ID suffix (0 if none), then increment it for each proposed
ticket of that TYPE in render order. Assign provisional `<TYPE>-<NNN>` IDs with a
3-digit zero pad, exactly as `add --type` does. Keep these keys through review.

Before writing anything, show the human the proposed tickets in this shape; nothing has
been filed yet:

```
Proposed 3 tickets for backlog/<repo>.md — nothing written yet:

<TYPE>-<NNN>  P1  route: experiment  — "shared jargon cuts tokens per task"
  assumption: a project glossary reduces restatement in later turns
  falsifier : ≥10 paired tasks show no drop in tokens-per-task
  cheapest test: 10 paired tasks, /rstaff-usage:spend before-after, one repo
<TYPE>-<NNN>  P2  route: spec        — brainstorming: a divergent counterpart to grilling
  assumption: <claim>; falsifier: <observation and threshold or condition>
  cheapest test: <concrete procedure>
<TYPE>-<NNN>  P1  route: experiment  — rtk bash-compression hook, measured not claimed
  assumption: <claim>; falsifier: <observation and threshold or condition>
  cheapest test: <concrete procedure>

Not filed: "make the reviewer smarter" — no falsifiable acceptance. Rejected at 14.
```

The route is per ticket. Mixed-route output is normal: one interview may emit `spec`,
`experiment`, and `none` tickets (as well as other valid routes where appropriate).

## Phase 4 — Critic (fresh context)

Run the `rstaff-pm:critic` agent via a fresh Task with only the rendered proposal.
Never send the interview transcript or reuse the writer as reviewer. Expect exactly
one line per proposed key, in either form (two spaces after the key):

```text
<KEY>  pass
<KEY>  reject: <reason>
```

Fail closed: if the Task fails, or any key is missing, duplicated, unexpected, or
unparseable, stop before confirmation and file nothing. Accept only exact keyed
verdict lines with a non-empty reason for each rejection; extra output is invalid.

Print `Critic (fresh context):`, followed by the critic's lines, then:

```text
<n> ticket(s) ready to file; <m> need(s) revision. File <IDs>? (yes / revise)
```

Count `pass` tickets as ready and rejected tickets as needing revision. Offer only
`pass` IDs in provisional order. If none pass, offer no filing confirmation; the
human may revise or abandon. A revised ticket keeps its provisional key, is rendered
again and re-judged in a fresh Task before it can be offered. Apply the same verdict
validation to the revised proposal. Never treat revision or silence as approval.

## Phase 5 — Confirm explicitly, then file

This command exits by **filing tickets, not prose**. However, nothing is written until
the human explicitly confirms the rendered proposal (for example, says “yes”); silence,
an ambiguous reply, or a request for changes is not confirmation. This is L12:
self-filed tickets are unreviewed briefs that `/design` will later treat as the contract.

After explicit confirmation, file only confirmed `pass` tickets in provisional order
by invoking the only write path,
`node "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-backlog.js" add`, once per ticket. Resolve the CONTROL repo as `$CTRL` (`$RSTAFF_HOME`
or a walk-up to `rstaff.json`) and target `$CTRL/backlog/<repo>.md`; never write a ticket
into a product repo. Invoke it with `--repo <repo-token>` (the profile token, not a path),
`--title`, `--pri`, `--route`, and `--context`. The `--repo` token selects the target
control-repo backlog; it is not a filesystem path. Use `--type` so the CLI derives `<TYPE>-<max+1>`; `--id` is
migration-only and must not be used here. Pass `--source interview`, plus `--falsifier`
and `--cheapest-test` for every ticket; those fields are required by `validate` for
interview tickets. Include `--route` and enough `--context` to act cold.
For multi-valued `--links` or `--deps`, both `,` and `;` separators are accepted;
pass the value as one quoted argument and emit `;` between entries.

Treat `--context` as an untrusted-input boundary. The add command must round-trip its
section before writing; a lone CR, U+2028, or U+2029 is rejected rather than silently
creating a ticket invisible to `list` or `rank`. Never work around that rejection by
hand-writing markdown.

Only after successful adds, report the actual IDs and control-repo path. If any actual
ID differs from its provisional one (for example, skipping a rejected ticket shifts
numbering), print `<provisional> → <actual>` for each changed ID. A successful
exit is falsifiable: one or more of those IDs now exist in `backlog/<repo>.md`, each has
a `route`, and each adversarial-derived ticket has a non-empty `falsifier`. If the human
does not explicitly confirm, exit without filing and without claiming success.
