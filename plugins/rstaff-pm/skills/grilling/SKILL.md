---
name: grilling
description: The interview discipline for turning a vague request into a precise one — ask ONE question at a time, and explore the codebase instead of asking anything you could find out yourself. Load when scoping a feature (/spec), clarifying an ambiguous task before /design, or any time a request is underspecified and guessing would be expensive. Do not load it for an already-precise request, a one-line change where asking costs more than doing, or a question the repo, profile, or git history already answers — read those instead. For divergent design exploration (surfacing 2–3 approaches before converging), use superpowers:brainstorming from the superpowers peer plugin.
---

# Grilling — one question at a time

Adapted from mattpocock/skills `grilling` + gstack `office-hours`. The reusable
engine behind `/spec` and any pre-work clarification.

**Grilling converges; brainstorming diverges.** Grilling narrows a vague request
to a precise one by interrogation. When the problem is instead a genuinely open
design space, run `superpowers:brainstorming` (peer plugin) first to open 2–3
distinct approaches — then grill the chosen one down to acceptance criteria.

## The two hard rules
1. **One question at a time.** Asking several at once is bewildering and gets you
   shallow answers. Ask the single highest-leverage question, get the answer, let
   it change your next question. A branching interview beats a questionnaire.
2. **Never ask what you can find out.** Before every question, check: can I answer
   this by reading the code, the profile, the existing UI, adjacent specs, or git
   history? If yes, go read it — then ask only about what remains genuinely unknown.
   Asking answerable questions burns the human's patience and trust.

## What to grill for (in rough order)
- **The user & the goal** — who is this for, what are they actually trying to do?
- **The trigger** — what starts this? how often, from where?
- **Success & failure — from the user's view** — how do *they* know it worked?
  This is where acceptance criteria come from.
- **Edge cases & scale** — empty, huge, concurrent, offline, unauthorized.
- **Scope boundaries** — what's explicitly NOT included?
- **Constraints that change the design** — deadline, stack, compliance, a data shape.

## Steering, not counting
There is **no fixed number of questions**. Steer with natural language ("let's
focus on the error path", "skip auth, assume it's handled"). Stop when one more
question wouldn't change the output — not at some quota.

## Anti-patterns
- A wall of 8 questions in one message. (Split them; ask the first.)
- "What framework should I use?" when the repo's package manifest already answers it.
- Interrogating trivia on a trivial task — match depth to stakes; for a one-liner,
  just do it.
