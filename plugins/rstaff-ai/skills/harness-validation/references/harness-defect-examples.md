# Worked example: three harness defects — the regression this skill exists to prevent

Three separate defects were found in offline and online eval harnesses used to compare
assistant models and prompts. They are kept as a worked example because they show that
"the harness looked fine" and "the harness was fine" are different claims. None of them
were agent-quality findings. All of them produced plausible-looking, judge-scored numbers
that were read and acted on before being caught.

Each defect below is framed as: what broke, why an output-only judge verdict could not
see it, and which check from `SKILL.md` would have caught it *before* any agent verdict
was trusted.

## Defect 1 — rubric truncated to ~18 characters before reaching the judge

**What broke.** A markdown-section parser (`extract_section`, regex `^##\s*(.+)$`) also
matched `###` subheadings, so it truncated each rubric at its first subsection. Three of
five rubrics arrived at the judge as 18–33 characters — for two of them, literally just
the boilerplate instruction line, with the actual five scoring criteria never delivered. The judge scored every case anyway, on whatever it
could infer from the truncated boilerplate.

**Why output-only judgment was blind to it.** The judge returned a normal-looking score
for every case — no error, no missing-field exception, nothing that read as a harness
failure. A verdict-only review sees a number 1–5 either way; it cannot tell "the judge
scored against the real rubric" from "the judge scored against three words of
boilerplate" without inspecting what was actually delivered to the model.

**Which check would have caught it.** §1 **product↔harness fidelity** — the harness's
input to the judge (the rubric *as delivered*, not the rubric file's own byte length)
must be checked against the source rubric text before trusting any score built from it.
A known-pass fixture (§2) with a rubric long enough to expose a truncation bug, scored
end-to-end and checked for the expected length/content at the judge boundary, would have
caught this immediately — the fixture would have arrived truncated and failed the check.

## Defect 2 — `pad_tool_block` sign-inverted 6 answer-key traps

**What broke.** A padding routine designed to fill in "unavailable data" context picked
its own `latest` date independent of each case's actual `core` date, and appended full
driver/subitem/benchmark blocks at that (wrong) date. For the 6
`partial_as_complete` trap cases — designed so the *correct* answer was "this data is not
available" — the padding silently supplied the complete data the key claimed was
unavailable. Answering correctly (declining, per the trap's intent) now scored as
*falling for the trap*, because the padding had made the declined data actually present.

**Why output-only judgment was blind to it.** The judge graded the agent's answer against
the case's stated key ("data unavailable → correct answer is to decline") without ever
checking whether the padded input it was fed still matched that key's premise. A reviewer
reading judge verdicts saw a consistent, plausible pattern (the model "falling for" a
trap) with no signal that the trap itself had been inverted by the harness.

**Which check would have caught it.** §3 **mutation & metamorphic grader tests**, applied
to the case-generation step itself: mutate a known-good `partial_as_complete` case by
running it through the padding step and checking whether the resulting case still matches
its own answer key (does the "unavailable" premise still hold after padding?). This is
exactly "feed the grader/generator a known-bad input and confirm it's caught" — here the
"grader" that needed to catch it is the key-vs-content auditor (`audit_key.py`, written
*after* the incident); running that check as part of certification, not as a post-hoc
fix, is what turns this from "found by accident" into "caught before any verdict shipped."

## Defect 3 — tool-misuse verdict was a prompt/schema bug, misread as a cross-model finding

**What broke.** In the online harness, all three model families (two variants from one
model vendor and one from another) exhibited the identical tool-misuse pattern: asked to compare a stated period to
"now," each fetched a real but wrong-period delivery and presented the comparison as
valid; asked about an unresolvable scope, each silently substituted a broader scope and
asserted the answer applied. Because the defect reproduced identically across every model
under test, it was not a model-quality difference at all — it was a period/scope
validation gap in the shared prompt/tool schema, sitting upstream of every model.
Separately, the *harness itself* had four infra bugs that each produced a plausible model
verdict on their own that day: a judge 429 read as all-0/5, a tool-check that passed with
no captured trace (false green), tool-call extraction silently failing for one vendor so every
arm of that vendor scored 0/6 tool-use while the judge scored the prose 5/5, and a tracing backend
returning silent 401s with no seeded project.

**Why output-only judgment was blind to it.** A per-model comparison table showing "all
three models fail identically" reads, at a glance, like a genuine cross-model capability
finding worth reporting as such — nothing about the output distinguishes "the models share
a real limitation" from "the shared prompt/tool-schema has a gap every model inherits." And
each of the four infra bugs produced a normal-shaped score (a number, a checkmark) rather
than an error state, so a verdict reader had no reason to suspect the measurement pipeline
rather than the agent.

**Which check would have caught it.**
- The **cross-arm invariant** implied by §7 ("a harness change invalidates prior arm
  comparisons unless both arms rerun under the new instrument") generalizes to: when every
  arm under a *supposedly varying* treatment (the model) shows an identical failure, that is
  itself a signal to check the thing that was held constant across all arms (the prompt/tool
  schema) before concluding it's a property of the models — the invariant that should have
  varied (model choice) didn't move the result at all.
- §5 **judge calibration / environment checks**, generalized to infra: an `UNMEASURED`
  category (added after this incident) that separates "the judge/tool-capture pipeline
  failed" from "the agent produced a bad response" is exactly the fidelity/reset discipline
  in §1 and §4 applied to the online harness — before reading any online-eval number, confirm
  `UNMEASURED` is 0 and that tool calls were actually captured, the same way a known-fail
  fixture confirms a grader is actually looking at what it claims to look at.

## The common thread

All three were **offline/online harness bugs invisible to output-only judgment** — a
truncated rubric, an inverted answer key, and a validation gap misread as a model finding
plus four silent infra failures. Each produced a number that looked like data. None of them
were caught by reading verdicts; all three were caught by checking what the instrument
actually delivered, fed it, or held constant. This is the regression `rstaff-ai:harness-validation`
exists to prevent: certify the instrument — fidelity, known-fail fixtures, mutation tests,
cross-arm invariants — *before* any of its results are trusted, not after a surprising
result prompts someone to go looking.
