
# Grilling

Adapted from mattpocock/skills `grilling` + gstack `office-hours`. The reusable
engine behind `/spec` and any pre-work clarification.

**Grilling converges; brainstorming diverges.** Grilling narrows a vague request
to a precise one by interrogation. When the problem is instead a genuinely open
design space, run `superpowers:brainstorming` (peer plugin) first to open 2–3
distinct approaches — then grill the chosen one down to acceptance criteria.

## The two hard rules
1. **Ask every open question in one message, batched together.** Do not interrogate one
   question at a time — gather everything upfront in a single numbered list so the
   human can answer them all at once.
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
