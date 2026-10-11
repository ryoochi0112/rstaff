#!/usr/bin/env node
// Run only the resolved verify command; recording failures only warn.
'use strict';
const { spawnSync } = require('node:child_process');
const { resolveHome, warn } = require('../hooks/lib.js');
const { fingerprint } = require('./lib-review-rounds.js');
const { resolveVerify, validSid, statePath, loadState, saveState, repoEntry } = require('./lib-gate.js');

const [sid, verifyCmd] = process.argv.slice(2);
let top;
let ctrl;
let expected = null;
try {
  const cwd = process.cwd();
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, env, encoding: 'utf8' });
  top = repo.stdout?.trim();
  if (repo.status !== 0 || !top) throw new Error(repo.error?.message || repo.stderr?.trim() || 'cannot resolve git repo');
  ctrl = resolveHome(cwd);
  expected = resolveVerify(top, ctrl);
  if (expected === null || verifyCmd !== expected) throw new Error('command mismatch');
} catch (error) {
  warn(`verify-run refused: '${verifyCmd}' is not the resolved verify command for ${top || 'none'} (resolved: ${expected ?? 'none'}): ${error.message}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
  process.exit(126);
}

let fp0;
try {
  fp0 = fingerprint(top);
} catch (error) {
  warn(`cannot record verify: ${error.message}`);
}

let status = 1;
try {
  const result = spawnSync(verifyCmd, { shell: true, stdio: 'inherit' });
  status = result.status;
  if (result.signal || status === null) status = 1;
  if (result.error) warn(`cannot run verify: ${result.error.message}`);
} catch (error) {
  warn(`cannot run verify: ${error.message}`);
}

function recordGreen() {
  const fp1 = top ? fingerprint(top) : null;
  if (status !== 0) return;
  if (!fp0 || !fp1) return;
  if (fp0.wtree !== fp1.wtree) return;
  if (!validSid(sid)) throw new Error('invalid session id');
  if (verifyCmd !== resolveVerify(top, ctrl)) return;
  const file = statePath(ctrl, sid);
  const state = loadState(file);
  repoEntry(state, top).greens.push(fp0.wtree);
  saveState(file, state);
}
try {
  recordGreen();
} catch (error) {
  warn(`cannot record verify: ${error.message}`);
}
process.exit(status);
