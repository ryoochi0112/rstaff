# Human-read document brief

Use this brief as the complete source for a drafting call. Claude gathers and
cites the evidence; the drafting model uses only this brief.

## Audience

Who will read the finished document, and what do they need from it?

## Purpose

What document is needed, and what should it help the audience understand or do?

## Facts

Number every fact. Cite the source as `path/to/file:line` where the fact comes
from the repository. Do not combine unsupported conclusions with a fact.

1. **[Fact]** — source: `[path/to/file:line]`
2. **[Fact]** — source: `[path/to/file:line]`

## Decisions

Record decisions that the document must reflect. Cite a file and line when a
decision is recorded in the repository.

1. **[Decision]** — source: `[path/to/file:line]`
2. **[Decision]** — source: `[path/to/file:line]`

## Constraints

List scope, technical limits, required wording, exclusions, and anything the
draft must preserve. Keep the first bullet verbatim in every brief (L33: a
one-shot drafting model that waits for approval burns the run as a no-op).

- This is a one-shot, non-interactive run: nobody can approve a plan or answer
  questions. Return the complete document as your reply, nothing else — no
  questions, no proposals, no description of actions you took or files you saved.
- [Constraint]
- [Constraint]

## Style

- Use plain words.
- Keep every sentence to 20 words or fewer.
- Use headings.
- Prefer concrete statements over filler or speculation.

## Do-not-invent

The drafting model must not fabricate any fact. It may use only what appears in
this brief.

- Do not invent names, dates, metrics, status, quotations, citations, examples,
  requirements, or decisions.
- Do not infer a missing fact, intent, or future plan and present it as true.
- Do not cite a file or line that the brief does not provide.
- If the brief lacks needed information, omit it or mark it as unresolved.
