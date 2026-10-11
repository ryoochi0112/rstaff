---
description: Loop brake — re-derive a stalled plan from first principles in a fresh context. Writes a new control-repo plan/ledger or asks a forcing question; never implements.
argument-hint: [repo or task, optional]
allowed-tools: Bash, Read, Grep, Glob, Write, AskUserQuestion, Skill
---

Act as the **first-principles replanner** for: **$ARGUMENTS**

This is a step-back, not another fix attempt. Run it in a **FRESH context**:
do not continue the narrative that produced the current ledger, reviews, or
transcript. Start again from the allowed facts below. The step-back that ends a
runaway loop currently happens only when the human notices the loop and forces
it; this command exists to make that recovery available at the point of need.

The measured case shows why this matters. In the last ontos session, a 12-task
patch ledger was re-cut into 10 tasks + 2 invariant tasks, and the next task
passed review on the first try. This is the pivotal datapoint in
`docs/research/efficiency-harness-260827.md` §1, “The pivotal datapoint”. It is
evidence for taking the step back, not a diagnosis to copy into another repo.

## Ground-truth boundary

Treat only these inputs as **FACTS**:

- The **frozen spec**, including its acceptance criteria and stated scope.
- The product profile's explicit configuration facts in
  `$CTRL/profiles/<repo>.md`.
- **Verified receipts**: a command that can be re-run **plus its actual output**.
  A claimed command, an expected result, or an unobserved “green” is not a
  receipt.
- The repo itself, inspected directly and tested with the commands that matter.

These are **LEADS, not facts**:

- ledger filings;
- prior review verdicts;
- transcripts; and
- any prior agent's summary of its own work.

In the analysed arc, the ledger's own filings were repeatedly wrong, so
sessions that trusted them re-paid a derivation tax. A lead may tell you what
to go and **VERIFY**; it may never be used as a premise. The review memo that
routes here is likewise a routing lead, not proof. Do not promote a lead to a
fact because it is detailed, recent, or repeated.

## Mandatory diagnostic gate

Before proposing anything, write an explicit answer from the verified facts to
this exact question:

**is this N independent defects or 1 structure?** — `N = <number> independent defects` **or** `1 structure`.

This answer must be the first substantive content of the one output: the first
section of the new plan/ledger, or the first line of the one forcing-question
prompt. If the verified facts cannot distinguish the two, write
`Undetermined from verified facts` and explain the missing evidence in that
same output; then choose output (b). Never smuggle in the measured 12-task
example as the answer for the current repo.

## Divergent option generation

When the verified facts leave genuinely different approaches to explore, use
the `superpowers:brainstorming` skill for 2–3 genuinely different approaches,
one question at a time, before converging; its suggestions are still leads until
verified. Follow `${CLAUDE_PLUGIN_ROOT}/rules/superpowers-precedence.md`. Do not emit a separate
brainstorming report; it is internal to this command's one allowed output.

## Trigger and handoff

Run `/replan` when the review circuit breaker's memo offers option A, when the
human invokes it directly, or when you self-invoke because the effort feels
disproportionate to the goal. Follow
`${CLAUDE_PLUGIN_ROOT}/rules/loop-brakes.md` for the circuit breaker's behavior
and handoff. That rule is the source of truth; do not restate its threshold or
memo format here.

## Artifact location

Resolve the control repo `$CTRL` (= `$RSTAFF_HOME`, or a walk-up to `rstaff.json`).
The spec + ledger live there — `$CTRL/var/specs/<repo>/<slug>.{md,tasks.md}`, never in
the product repo — where `<repo>` is the product repo's directory name (its
`$CTRL/profiles/<repo>.md` token). Use the same artifact-location convention as
`/design`.

## Output contract — choose exactly one

After the mandatory diagnostic, produce **EXACTLY ONE** of these outcomes:

When `/replan` is invoked with no frozen spec, the output MUST be (b), the forcing question, and `/replan` must never invent a spec.

(a) **A re-cut plan/ledger written FROM SCRATCH.** Use the frozen spec, verified
receipts, profile configuration facts, and direct repo observations as the
premises. Write the replacement plan/ledger as a new whole artifact in the
control repo. This is explicitly **not a patch of the old plan or ledger**:
the old plan is the contaminated variable. Do not use its task decomposition,
filings, or summaries as scaffolding; independently verify anything that
survives and rewrite it. The artifact itself is the output—do not add a status,
review, recap, or second plan.

(b) **A forcing question to the human via `AskUserQuestion`.** Use one question
with lettered options (A, B, C, …) generated from the actual unresolved fact,
scope, or constraint. Include the written diagnostic answer first. Options must
make the decision concrete—such as verifying a named missing receipt, choosing
between verified structural boundaries, or deliberately descoping an uncertain
scope—and must not copy a sample diagnosis or invent repo facts. The question
and its lettered options are the entire output; emit no plan, status, or extra
explanation around it.

This command never implements, never edits product code, and never commits. The
only permitted write is the one new or wholly re-cut plan/ledger artifact under
`$CTRL/var/specs/<repo>/…`; never use `Write` on a product-repo path.
