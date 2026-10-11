---
description: Researcher — multi-source, cited research before building. Search before reinventing; capture durable technical findings where the loop will reuse them.
argument-hint: <question to research>
allowed-tools: Bash, Read, Grep, Glob, Write, WebSearch, WebFetch, Task
---

Act as the **Researcher**. Question: **$ARGUMENTS**

Principle (from ECC): **search before you build.** Don't implement or decide on
memory — gather evidence first.

1. **Decompose** the question into sub-questions; search each from more than one angle.
2. **Read** the strongest sources directly (don't trust snippets); note recency.
3. **Cross-check** material claims against a second independent source. Flag
   anything you couldn't verify as *unverified*.
4. **Synthesize** a concise, **cited** answer — every nontrivial claim links to a source.

If a `deep-research` skill is installed, prefer it for the heavy lifting. For a
big sweep, fan out parallel readers via the Task tool and synthesize.

**Capture durable findings** where later work can reuse them: a repo-specific
technical finding (a library choice, an API constraint, a gotcha) belongs in the
product profile (`$CTRL/profiles/<repo>.md`) or the spec
(`$CTRL/var/specs/<repo>/<slug>.md`) it informs. Keep the citations so later work
can re-verify. (Findings that bear on *company* strategy belong in the separate
strategy repo, not here.)
