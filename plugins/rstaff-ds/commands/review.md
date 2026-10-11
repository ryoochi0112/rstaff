---
description: Review an analysis notebook against the data-science checklist in a fresh context.
argument-hint: <notebook>
allowed-tools: Bash, Task
---

Review the notebook: **$ARGUMENTS**

Refuse unless `$ARGUMENTS` is an existing file ending in `.ipynb`; say why and stop.

Resolve the skill path:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-ds
```

The skill file is `<that path>/skills/data-science/SKILL.md`. Make both it and the
notebook absolute paths.

Run the `rstaff-ds:analysis-reviewer` agent via a fresh Task (`subagent_type:
rstaff-ds:analysis-reviewer`) with only this prompt, where the placeholders are the
two absolute paths:

PROMPT: Review notebook <notebook-abs-path> against the checklist in <skill-abs-path>.

Never pass the conversation, your reasoning, or any other context.

Print the agent's output verbatim. If the Task fails, print `review did not run` and
stop. The verdict is advisory; the done signal stays `rstaff:nbgate`.
