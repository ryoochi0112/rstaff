---
description: Spend — show captured Claude and delegated token use by adapter, model, and role. Reads local JSONL emitted by hooks and delegate.js; never guesses API cost or subscription quota.
argument-hint: [--days N] [--json]
allowed-tools: Bash, Read
---

Run `/rstaff-usage:spend [--days N] [--json]`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.js" $ARGUMENTS
```

Show the output verbatim. If the table is empty, explain that capture begins
after the updated SessionEnd/SubagentStop hooks or delegate runs. Treat `—` as
unmeasured, not zero. Do not convert tokens into dollars; provider tokenizers,
subscription usage, and API billing are different accounting systems.
When task-mode review verdicts exist, a second table shows review pass rate
(overall and first-attempt) per writer `adapter / model@effort`; `unattributed`
counts verdicts with no matching `<label>/implement` writer row.
