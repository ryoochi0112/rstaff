# How to use this repo — loop engineering, in practice

This is the operator's walkthrough: what loop engineering means mechanically,
what one feature run looks like end to end, and what your job is at each gate.
For the map of the pieces see `ARCHITECTURE.md`; for the safety model see
`AUTONOMY.md`; for the design research behind it, `research/arch-research-260626.md`.

## Gemini document-drafting prerequisites

Gemini-backed human-read document drafting requires the Gemini CLI and Google
Cloud Application Default Credentials (ADC). Install the CLI with
`npm i -g @google/gemini-cli`, then authenticate ADC with
`gcloud auth application-default login`. The adapter uses Vertex AI and honors
the operator's `CLOUDSDK_CONFIG`; `/rstaff:health` reports both prerequisites without
failing when either is unavailable. Gemini draft mode defaults to a 180 s
timeout; pass `--timeout <sec>` to override it for an individual draft. Use
`-o <file>` (or `--out <file>`) to write the draft text to a file; stdout still
contains the JSON result envelope.
The brief is sent to Vertex AI. After each run, the adapter removes the Gemini
CLI's per-run chat log, so the CLI keeps no local copy of the brief.

## The core idea

Loop engineering means **you stop being the loop**. Normally you are the loop:
you prompt, read the output, judge whether it's done, prompt again. rstaff
replaces each of those human functions with a mechanism:

| Human function | Replaced by |
|---|---|
| "Is it done?" judgment | a machine-checkable done signal — `make verify` (the completion gate blocks a stop without a green run; see `SECURITY.md`) |
| Reviewing the output | an independent evaluator — `/review` in a fresh context (writer ≠ reviewer) |
| Remembering progress | external state — task ledger, checkpoint commits, `var/dispatch/*` status |
| Supervising | hard rails — attempt caps, dead-man stall detection, `var/.STOP` kill-switch |

Your job compresses to the two things machines can't do: **define what "good"
means** (the spec), and **make irreversible calls** (merge, deploy).

## The three loops, nested

You are running three loops at once, at different speeds.

**1. The inner loop** *(seconds–minutes, fully automatic).* Inside `/build`, one
implementer subagent works one task until `make verify` goes green. It cannot
lie about being done — verify is a command, and `guard-bash.js` denies
`--no-verify`. You never see this loop.

**2. The task loop** *(minutes–hours, automatic with rails).* `/build`
dispatcher mode walks the ledger: fresh implementer → verify green → fresh
reviewer (two verdicts: matches spec? acceptable quality?) → checkpoint commit →
next task. Fresh context each time is the point — the implementer's
rationalizations don't leak into the reviewer. Rails: 3 attempts per task then
it's parked; two consecutive tasks failing verify stops the feature; `touch
var/.STOP` halts everything before the next task.

**3. The outer loop** *(days–weeks, human-gated).* `/interview → ticket → /spec
→ /plan → /build → /review → /ship → /land`. `/interview` turns a rough idea
into falsifiable tickets in the tracked `backlog/<repo>.md` store; you select the
work worth specifying and sit at the later gates.

## What one feature run looks like

Say the feature is "invite links expire after 7 days" in a product repo that has
a profile (`profiles/<repo-dir>.md` — step 0, one-time per repo).

**`/interview invite link expiry`** — start with the rough idea. The interviewer
grills it, records falsifiers and cheapest tests, and shows you proposed tickets
before writing. After your explicit confirmation, the accepted tickets are
filed in the control repo's tracked `backlog/<repo>.md`; select one to take into
the feature loop.

**`/spec invite link expiry`** — run in the product repo. The PM role asks you
*one question at a time* (it is forbidden from asking anything it could find in
the code — it explores instead). You answer from product judgment. Output:
the control-repo spec `$CTRL/var/specs/<repo>/invite-expiry.md` (never the product
tree), one page, with acceptance criteria written so a test can check them ("GET on
an expired link returns 410 and shows re-request UI"),
not vibes ("links should expire gracefully"). **Be slow here.** Every loop
downstream converges toward this document; a fuzzy criterion becomes a
plausible-but-wrong implementation later.

**`/plan`** — the Eng Manager locks architecture (where expiry is stored, which
layer checks it) and writes the task ledger `$CTRL/var/specs/<repo>/invite-expiry.tasks.md`:
small tasks, each independently verifiable. You skim it: is the decomposition
sane? This is your last cheap intervention point.

**`/build` — and walk away.** This is where loop engineering pays. The
dispatcher runs the task loop above. When you come back you see either
`ready_for_review` with one checkpoint commit per task, or a parked task with
the reason recorded. If the machine died mid-run, `/build` again resumes from
the first non-`done` task — state lives in the ledger and commits, not in the
conversation.

**`/review`, then decide.** A fresh reviewer reads the *whole* diff against the
spec — blocking issues only, no praise, no style nits. If it blocks, feed the
findings back into a fix cycle. If clean: `/ship` runs the gate and opens a PR,
you review it like a human PR, `/land` merges and watches prod health. The merge
is yours; the system drafts but never decides.

If review does not converge, the circuit breaker trips after **2 consecutive
whole-branch BLOCK verdicts** on the same repo+branch. It is **advisory**, so a
human can continue; `reset --reason "<why>"` records the override and clears the
streak. The recommended step-back is **`/replan`**: a fresh-context,
first-principles re-derivation that writes a new plan/ledger or asks a forcing
question — not another `/build` round.

The workflow stays human-gated at the points that require judgment: choose the
ticket, skim the plan, review the diff, and approve release.

## Your role, redefined

| The system owns | You own |
|---|---|
| "Is the code correct?" (verify) | "Is this the right thing to build?" (spec answers) |
| "Does it match the spec?" (fresh review) | "Is the decomposition sane?" (plan skim) |
| Progress memory (ledger, commits) | Irreversible actions (merge, deploy) |
| Not running away (caps, `var/.STOP`) | Making the final calls at each gate |

The failure mode to guard against isn't the AI going rogue — the rails handle
that. It's **you skipping the gates because the output looks fine**. The gates
are cheap (a skim and a PR review); skipping them silently
converts "loop with quality gates" back into vibe coding with extra steps.

## Scaling up: parallel features

Once single runs are clean, plan 2–3 features and run `/dispatch slug1 slug2
slug3` instead of `/build` — one git worktree + branch + feature-runner each,
all stopping at `ready_for_review`. Watch progress with `/cockpit`; you only
re-enter at review time. Dispatch in the evening, read the cockpit in the
morning. Rails and the kill-switch are shared with the task loop
(`docs/AUTONOMY.md`); optional cron rituals live in `docs/RITUALS.md`.

## Choosing where the tokens go

Use `token-efficient-delegation` for costly work. Keep requirements, trade-offs,
and integration in the coordinator; send bounded implementation or noisy
read-heavy work to isolated workers as file packets.

- In Claude Code, implementation remains explicit with `/build … --impl codex`
  or `/dispatch … --impl codex`.
- Ledger review routes are automatic: low/medium-risk Claude-authored work uses
  sandboxed Codex review when available; high-risk or external-authored work
  uses fresh Claude.
- Do not parallelize writers in one tree. Use worktrees or keep writes serial.

After a run, use `/usage` (or `node plugins/rstaff-usage/scripts/usage.js`) to compare captured
routes. It includes Claude coordinator/subagent sessions and external delegates;
unmeasured rows render `—`. Promote routes only when the same quality gate passes.

## Using Codex as a worker

Codex is called from Claude Code; Claude keeps the coordinator role.

- **Codex as writer:** run `/rstaff-engineer:build <slug> --impl codex` or
  `/rstaff-engineer:dispatch <slug...> --impl codex`. A fresh Claude reviewer gates the diff.
- **Codex as reviewer:** Claude-authored low/medium-risk ledger tasks route to a
  sandboxed Codex review automatically. High-risk tasks stay on fresh Claude.
- **Codex as advisor:** `/rstaff-delegation:consult codex [plan|diff|review|"question"]`
  gives a read-only second opinion (`/rstaff-delegation:codex` is a thin alias).
  Claude reconciles AGREE/DIVERGE; the external model gets no vote.
- **Gemini as doc writer:** `/rstaff-delegation:write <what> --to <path>` sends a
  Claude-collected brief to the `gemini` adapter for human-readable prose. Claude
  writes the file only after your approval.

Start with one small feature. Check `node plugins/rstaff-usage/scripts/usage.js --days 30`
(or `/rstaff-usage:spend`) before increasing concurrency. Provider tokenizers,
subscription quota, and API billing stay separate and are never conflated.

## Why the first run should be interactive

The first run calibrates three things you can't guess:

1. **Where specs need to be more precise** — you find out from what the
   implementer got wrong.
2. **Which review findings recur** — use them to tighten future specs.
3. **What a feature costs in tokens** — that number becomes your `/dispatch`
   budget cap (`docs/AUTONOMY.md` says instrument before scaling to 3).

So: pick one real, small feature in a profiled repo, run the full chain
interactively once, then earn the parallel mode.
This matches the repo's own doctrine: **earn autonomy gradually; when in doubt,
drop a level.**
