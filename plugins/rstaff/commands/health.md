---
description: Health — verify the rstaff wiring is actually live (plugin installed, RSTAFF_HOME, hooks firing, profiles, gh). Prints CHECK/STATUS/FIX with exact fixes.
argument-hint: [--static]
allowed-tools: Bash, Read, Grep, Glob
---

Act as the **Ops engineer**. Diagnose the rstaff wiring — the point is to make
"designed but not activated" impossible to miss.

1. Run the diagnostic and show its table **as-is** (don't paraphrase statuses):
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/health.js" $ARGUMENTS`
2. For each **FAIL/WARN**, explain the one-line fix from the note column and
   offer to run it. Reversible fixes (mkdir, re-running the installer's
   validation) you may just do; anything touching `~/.claude/settings.json`,
   shell profiles, or plugin registration — show the command and confirm first.
3. All green → say so in one line and stop. No filler.

Notes: full mode checks machine wiring (plugin registered/enabled, hooks
actually fired via the liveness marker, gh auth); `--static` is the repo-only
CI subset. The "hooks fired" checks need a fresh session *after* install — a
FAIL right after installing is expected until you restart the session.
