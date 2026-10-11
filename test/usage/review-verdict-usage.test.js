'use strict';
// Review verdicts append a usage row when rstaff-usage is present (cross-plugin: core + usage).
// Core-only behaviour (no row without the layer) is pinned by test/core/review-rounds.test.js V2.
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const CORE = path.resolve(__dirname, '../../plugins/rstaff');
const R = require(path.join(CORE, 'scripts', 'lib-review-rounds.js'));
const CLI = path.join(CORE, 'scripts', 'lib-review-rounds.js');

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-review-rounds-'));
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-review-repo-'));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@e', '-c', 'user.name=t', ...args]);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'x'), 'x');
  git('add', 'x');
  git('commit', '-qm', 'x');
  return dir;
}

function roundCLI(home, cwd, command, args = [], env = process.env) {
  const result = spawnSync(process.execPath, [
    CLI, command, '--repo', 'repo', '--branch', 'main', '--home', home, '--cwd', cwd, ...args,
  ], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function usageRows(home) {
  const file = path.join(home, 'var', 'usage.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('V1 task record with label + attempt stamps the round and appends one verdict usage row', () => {
  const home = mkHome();
  const state = R.record(home, 'repo', 'main',
    { mode: 'task', verdict: 'block', p0: 0, p1: 0, label: 'repo/feat/T3', attempt: 2 }, { cwd: home });
  const round = state.rounds[state.rounds.length - 1];
  assert.equal(round.label, 'repo/feat/T3');
  assert.equal(round.attempt, 2);
  const rows = usageRows(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].adapter, 'review');
  assert.equal(rows[0].mode, 'verdict');
  assert.equal(rows[0].label, 'repo/feat/T3');
  assert.equal(rows[0].attempt, 2);
  assert.equal(rows[0].verdict, 'block');
  assert.equal(rows[0].measured, false);
  assert.ok(rows[0].id.startsWith('verdict:repo/feat/T3:2:'));
});

test('V4 CLI record --label --attempt writes the verdict row under --home', () => {
  const home = mkHome();
  const state = roundCLI(home, mkRepo(), 'record',
    ['--mode', 'task', '--verdict', 'pass', '--label', 'repo/feat/T1', '--attempt', '1']);
  assert.equal(state.rounds[0].attempt, 1);
  const rows = usageRows(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'pass');
  assert.equal(rows[0].attempt, 1);
});
