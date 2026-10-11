'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const ROOT = path.join(__dirname, '..', '..');
const payloads = require(path.join(ROOT, 'maintainer', 'lib-guard-payloads.js'));
const { VERSION_LOCATIONS_TEXT } = require(path.join(ROOT, 'maintainer', 'lib-install.js'));
const { checkGuardPayloads, rowEvent, expectedFor, decodeDecision } = require(
  path.join(ROOT, 'maintainer', 'lib-guard-selftest.js'));
const corpusEntries = [
  ['bashDeny', payloads.bashDeny],
  ['bashAsk', payloads.bashAsk],
  ['bashPass', payloads.bashPass],
  ['secretDeny', payloads.secretDeny],
  ['secretClean', payloads.secretClean],
];
const ordered = corpusEntries.flatMap(([name, rows]) => rows.map((row) => ({ name, row })));

const decisionJson = (decision) => JSON.stringify({
  hookSpecificOutput: { permissionDecision: decision },
});
function matchingSpawn(overrides = {}) {
  let index = 0;
  const calls = [];
  const spawn = (script, args, input) => {
    const entry = ordered[index++];
    calls.push({ script, args, input, entry });
    if (overrides[entry.row.id]) return overrides[entry.row.id];
    const expected = expectedFor(entry.row, entry.name);
    return expected === 'pass'
      ? { status: 0, signal: null, stdout: '' }
      : { status: 0, signal: null, stdout: decisionJson(expected) };
  };
  return { spawn, calls };
}

test('guard self-test passes all 151 matching rows', () => {
  const pluginRoot = '/installed/rstaff';
  const stub = matchingSpawn();
  const result = checkGuardPayloads({ pluginRoot, payloads, spawn: stub.spawn });
  assert.equal(result.status, 'PASS');
  assert.equal(result.mismatches.length, 0);
  assert.match(result.note, /151/);
  assert.match(result.note, new RegExp(pluginRoot));
  assert.equal(stub.calls.length, 151);
  assert.equal(stub.calls.filter((call) => call.script === path.join(pluginRoot, 'hooks', 'guard-bash.js')).length, 135);
  assert.equal(stub.calls.filter((call) => call.script === path.join(pluginRoot, 'hooks', 'secret-scan.js')
    && JSON.stringify(call.args) === JSON.stringify(['file'])).length, 16);
});

test('guard self-test failure names the mismatching row and fix', () => {
  const pluginRoot = '/installed/rstaff';
  const stub = matchingSpawn({ D18: { status: 0, signal: null, stdout: '' } });
  const result = checkGuardPayloads({ pluginRoot, payloads, spawn: stub.spawn });
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.mismatches, [{ id: 'D18', expected: 'deny', actual: 'pass' }]);
  for (const text of [
    'D18',
    'expected deny',
    'got pass',
    pluginRoot,
    'TWELVE',
    'plugins/rstaff/.claude-plugin/plugin.json',
    'plugins/rstaff-ai/.claude-plugin/plugin.json',
    'plugins/rstaff-ai-datadog/.claude-plugin/plugin.json',
    'plugins/rstaff-usage/.claude-plugin/plugin.json',
    'plugins/rstaff-backlog/.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'rstaff.json',
    'docs/ARCHITECTURE.md',
    'install/install-apply.sh --install',
  ]) {
    assert.ok(result.note.includes(text), text);
  }
  assert.ok(result.note.includes(VERSION_LOCATIONS_TEXT));
});

test('killed and crashed children are mismatches', () => {
  let stub = matchingSpawn({ A21: { status: null, signal: 'SIGTERM', stdout: '' } });
  let result = checkGuardPayloads({ pluginRoot: '/installed/rstaff', payloads, spawn: stub.spawn });
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.mismatches[0], { id: 'A21', expected: 'ask', actual: 'killed(SIGTERM)' });

  stub = matchingSpawn({ P1: { status: 1, signal: null, stdout: '' } });
  result = checkGuardPayloads({ pluginRoot: '/installed/rstaff', payloads, spawn: stub.spawn });
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.mismatches[0], { id: 'P1', expected: 'pass', actual: 'exit 1' });
});

test('guard self-test is informational when no install is recorded', () => {
  let calls = 0;
  const result = checkGuardPayloads({ pluginRoot: null, payloads, spawn: () => { calls += 1; } });
  assert.equal(result.status, 'INFO');
  assert.match(result.note, /install\/install-apply\.sh --install/);
  assert.equal(calls, 0);
});

test('guard replay event and hook shapes are pinned', () => {
  const pluginRoot = '/installed/rstaff';
  const stub = matchingSpawn();
  checkGuardPayloads({ pluginRoot, payloads, spawn: stub.spawn });
  for (const call of stub.calls) {
    const { name, row } = call.entry;
    const secret = name === 'secretDeny' || name === 'secretClean';
    assert.equal(call.script, path.join(pluginRoot, 'hooks', secret ? 'secret-scan.js' : 'guard-bash.js'));
    assert.deepEqual(call.args, secret ? ['file'] : []);
    assert.deepEqual(JSON.parse(call.input), rowEvent(row));
    if (!secret) assert.deepEqual(JSON.parse(call.input), { tool_name: 'Bash', tool_input: { command: row.command } });
    else if (row.text) assert.deepEqual(JSON.parse(call.input), { tool_input: { content: row.text } });
    else assert.deepEqual(JSON.parse(call.input), { tool_name: 'Bash', tool_input: { command: row.command } });
  }
  assert.deepEqual(stub.calls.filter((call) => ['D22', 'P26', 'P27'].includes(call.entry.row.id))
    .map((call) => call.entry.row.id), ['D22', 'P26', 'P27']);
  assert.equal(decodeDecision({ status: 0, signal: null, stdout: decisionJson('deny') }), 'deny');
  assert.equal(decodeDecision({ status: 0, signal: null, stdout: '' }), 'pass');
});

test('guard self-test passes the real working-tree hooks', () => {
  const pluginRoot = path.join(ROOT, 'plugins', 'rstaff');
  const spawn = (script, args, input) => spawnSync(process.execPath, [script, ...args], {
    input, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000,
  });
  const result = checkGuardPayloads({ pluginRoot, payloads, spawn });
  assert.equal(result.status, 'PASS', JSON.stringify(result.mismatches));
});

test('guard payload corpus arrays and rows are frozen', () => {
  for (const [, rows] of corpusEntries) {
    const length = rows.length;
    const json = JSON.stringify(rows);
    assert.ok(Object.isFrozen(rows));
    for (const row of rows) assert.ok(Object.isFrozen(row));
    assert.throws(() => { rows.push({}); });
    assert.throws(() => { rows[0].command = 'x'; });
    assert.equal(rows.length, length);
    assert.equal(JSON.stringify(rows), json);
  }
  const sloppy = new Function('rows', 'rows[0].id = "MUTATED"; return rows[0].id');
  assert.equal(sloppy(payloads.bashDeny), 'D1');
  assert.ok(payloads.ADDED_BY instanceof Set); // Set mutability is intentionally not frozen.
});

test('static health skips the installed-copy guard self-test', () => {
  const result = spawnSync(process.execPath, ['plugins/rstaff/scripts/health.js', '--static', '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'static');
  assert.equal(report.results.some((item) => item.check.includes('guard self-test')), false);
});
