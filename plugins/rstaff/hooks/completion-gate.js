#!/usr/bin/env node
// SessionStart records the first tree; Stop requires green verify for later trees.
'use strict';

const mode = process.argv[2];
const emit = (output) => process.stdout.write(JSON.stringify(output));
let warn = () => {};

function main() {
  if (mode === 'stop' && process.env.RSTAFF_GATE === 'off') {
    emit({ systemMessage: 'rstaff: completion gate disabled (RSTAFF_GATE=off) — see SECURITY.md' });
    return;
  }
  if (mode !== 'baseline' && mode !== 'stop') throw new Error('invalid completion gate mode');
  const lib = require('./lib.js');
  warn = lib.warn;
  const { readEventStrict, resolveHome } = lib;
  const { spawnSync } = require('node:child_process');
  const { fingerprint } = require('../scripts/lib-review-rounds.js');
  const { resolveVerify, statePath, loadState, saveState, repoEntry } = require('../scripts/lib-gate.js');
  const { event, malformed } = readEventStrict();
  if (malformed) throw new Error('malformed event input');
  if (typeof event.cwd !== 'string' || !event.cwd.trim()) throw new Error('missing event cwd');
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: event.cwd, env, encoding: 'utf8' });
  if (repo.error) throw repo.error;
  if (repo.status !== 0 && !/not a git repository/i.test(repo.stderr)) {
    throw new Error(repo.stderr.trim() || 'cannot resolve git repo');
  }
  const top = repo.status === 0 ? repo.stdout.trim() : null;
  const ctrl = resolveHome(event.cwd);
  if (mode === 'baseline') {
    if (!top) return;
    const file = statePath(ctrl, event.session_id);
    const state = loadState(file);
    const entry = repoEntry(state, top);
    if (entry.baseline !== null) return;
    const fp = fingerprint(top);
    if (!fp) throw new Error('null fingerprint');
    entry.baseline = fp.wtree;
    saveState(file, state);
    return;
  }

  const verify = top && resolveVerify(top, ctrl);
  if (!verify) {
    emit({ systemMessage: 'rstaff: no verify command — completion gate inactive' });
    return;
  }
  const fp = fingerprint(top);
  if (!fp) throw new Error('null fingerprint');
  const file = statePath(ctrl, event.session_id);
  const state = loadState(file);
  const entry = repoEntry(state, top);
  const { wtree } = fp;
  if (wtree === entry.baseline || entry.greens.includes(wtree)) return;
  const count = (entry.blocks[wtree] || 0) + 1;
  entry.blocks[wtree] = count;
  saveState(file, state);
  const short = wtree.slice(0, 7);
  if (count > 3) {
    emit({ systemMessage: `rstaff completion gate gave up after 3 blocks: no green ${verify} on tree ${short} — this stop is NOT verified.` });
    return;
  }
  const baseline = entry.baseline === null ? 'no session baseline' : 'edited since session start';
  const green = entry.greens.at(-1)?.slice(0, 7) || 'none';
  emit({ decision: 'block', reason:
    `rstaff completion gate: this session changed the tree, but no green \`${verify}\` matches it.\n`
    + `  tree: ${short} (${baseline}) · last green: ${green}\n`
    + `  → run \`${verify}\`; the stop is allowed once it exits 0 on this tree.\n`
    + `  (block ${count}/3 · escape: RSTAFF_GATE=off — see SECURITY.md)` });
}

try {
  main();
} catch (error) {
  if (mode === 'baseline') {
    warn(`cannot record completion baseline: ${error.message}`);
  } else {
    emit({ decision: 'block', reason: `rstaff completion gate error: ${error.message} — stop blocked; escape: RSTAFF_GATE=off — see SECURITY.md (Claude Code also caps consecutive blocks).` });
  }
}
