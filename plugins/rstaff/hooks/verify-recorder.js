#!/usr/bin/env node
// PreToolUse(Bash): wrap exact verify segments without making a permission decision.
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readEventStrict, resolveHome, warn, pass } = require('./lib.js');
const { resolveVerify, rewriteCommand } = require('../scripts/lib-gate.js');

try {
  const { event: ev, malformed } = readEventStrict();
  if (malformed) throw new Error('malformed event input');
  if (ev.tool_name !== 'Bash' || typeof ev.tool_input?.command !== 'string') pass();
  if (typeof ev.cwd !== 'string' || !ev.cwd.trim()) throw new Error('missing event cwd');
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ev.cwd, env, encoding: 'utf8' });
  if (repo.status !== 0) throw new Error(repo.error?.message || repo.stderr.trim() || 'cannot resolve git repo');
  const top = repo.stdout.trim();
  const verifyCmd = resolveVerify(top, resolveHome(ev.cwd));
  const runner = path.resolve(__dirname, '../scripts/verify-run.js');
  const command = verifyCmd && rewriteCommand(ev.tool_input.command, verifyCmd, runner, ev.session_id);
  if (!command) pass();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', updatedInput: { ...ev.tool_input, command },
    },
  }));
} catch (error) {
  warn(`cannot record verify: ${error.message}`);
}
