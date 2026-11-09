'use strict';

// Invariant: the test shim answers to checked-in captures of the real `claude` CLI (see
// test/fixtures/ablate/real/CAPTURE.md). A key in the capture that the shim lacks fails here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');
const SHIM = path.join(ROOT, 'test/fixtures/ablate/claude-shim.js');
const REAL = path.join(ROOT, 'test/fixtures/ablate/real');
const CASE_NAME = 'grilling-compliance-one-question-before-design';
const CASE_DIR = 'one-question-before-design';

const capture = (file) => fs.readFileSync(path.join(REAL, file), 'utf8');
const jsonl = (text) => text.trim().split('\n').map((l) => JSON.parse(l));
const keys = (o) => Object.keys(o).sort();
const assertCovers = (shimObj, realObj, label) => {
  const missing = keys(realObj).filter((k) => !(k in shimObj));
  assert.deepEqual(missing, [], `${label}: keys in the real capture that the shim lacks`);
};

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ablate-fid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const arm = path.join(root, 'arms/full/rstaff-pm');
  fs.mkdirSync(path.join(arm, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(arm, '.claude-plugin/plugin.json'), '{"name":"rstaff-pm","version":"0.13.1"}');
  const caseDir = path.join(arm, 'evals/grilling-compliance', CASE_DIR);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'case.yaml'), JSON.stringify({
    name: CASE_NAME, execution: { prompt: 'Question', max_turns: 4 },
    graders: ['assertion-1', 'assertion-2', 'assertion-3'].map((name) => ({ name, type: 'llm', criteria: `judge ${name}` })),
  }));
  const run = (args, env = {}) => spawnSync(process.execPath, [SHIM, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const evalArgs = (caseArg, out) => ['plugin', 'eval', arm, '--ablation', 'none', '--model', 'haiku', '--runs', '2', '--case', caseArg, '--no-publish', '--trust-plugin', '--output-dir', `${out}/`];
  return { root, arm, run, evalArgs };
}

test('plugin eval: aggregate keys at every level cover the real capture', (t) => {
  const s = sandbox(t);
  const out = path.join(s.root, 'out');
  const res = s.run(s.evalArgs(CASE_NAME, out), { ABLATE_SHIM_SCENARIO: '' });
  assert.ok([0, 1].includes(res.status), res.stderr);
  const shim = JSON.parse(fs.readFileSync(path.join(out, 'aggregate-result.json'), 'utf8'));
  const real = JSON.parse(capture('eval-aggregate.json'));
  assertCovers(shim, real, 'aggregate top level');
  assertCovers(shim.suite, real.suite, 'suite');
  assertCovers(shim.suite.plugins[0], real.suite.plugins[0], 'suite plugin');
  assertCovers(shim.cases[0], real.cases[0], 'case');
  assertCovers(shim.cases[0].aggregates, real.cases[0].aggregates, 'case aggregates');
  assertCovers(shim.aggregates, real.aggregates, 'aggregates');
  assertCovers(shim.cases[0].graders[0], real.cases[0].graders[0], 'case grader definition');
  assertCovers(shim.cases[0].arms.with[0], real.cases[0].arms.with[0], 'run');
  assertCovers(shim.cases[0].arms.with[0].graders[0], real.cases[0].arms.with[0].graders[0], 'run grader entry');
  // Name, dir, maxTurns and graders come from the arm's case.yaml, not from argv.
  assert.equal(shim.cases[0].name, CASE_NAME);
  assert.equal(shim.cases[0].dir, `evals/grilling-compliance/${CASE_DIR}`);
  assert.equal(shim.cases[0].maxTurns, 4);
  assert.deepEqual(shim.cases[0].graders.map((g) => g.name), ['assertion-1', 'assertion-2', 'assertion-3']);
  assert.deepEqual(real.cases[0].graders.map((g) => g.name), shim.cases[0].graders.map((g) => g.name));
  // A successful llm grader carries evidence (the leg adapter reads it).
  const ok = shim.cases[0].arms.with.find((r) => r.error === null);
  assert.equal(typeof ok.graders[0].evidence, 'string');
});

test('plugin eval: the case dir name matches nothing; exit 1, real message, no aggregate', (t) => {
  const s = sandbox(t);
  const out = path.join(s.root, 'out');
  const res = s.run(s.evalArgs(CASE_DIR, out), { ABLATE_SHIM_SCENARIO: '' });
  assert.equal(res.status, 1);
  assert.equal(fs.existsSync(path.join(out, 'aggregate-result.json')), false);
  const real = capture('eval-no-case.txt');
  const pattern = (text) => text.replace(/--case "[^"]*" under .*\.$/m, '--case "X" under Y.');
  assert.equal(pattern(res.stderr), pattern(real));
  assert.match(res.stderr, new RegExp(`^No eval cases found matching --case "${CASE_DIR}" under .+\\.\\nRun without --case to see all cases\\.\\n$`));
});

test('plugin eval: exit 1 when the case score is below 1.0, exit 0 at 1.0', (t) => {
  const s = sandbox(t);
  const scenario = path.join(s.root, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ legs: { full: { passes: 1 } } }));
  assert.equal(s.run(s.evalArgs(CASE_NAME, path.join(s.root, 'a')), { ABLATE_SHIM_SCENARIO: scenario }).status, 1);
  fs.writeFileSync(scenario, JSON.stringify({ legs: { full: { passes: 2 } } }));
  assert.equal(s.run(s.evalArgs(CASE_NAME, path.join(s.root, 'b')), { ABLATE_SHIM_SCENARIO: scenario }).status, 0);
});

test('probe: --judge-model is refused with captured stderr, empty stdout and exit 1', (t) => {
  const s = sandbox(t);
  const res = s.run(['-p', 'x y', '--model', 'invalid-model-ablate-smoke', '--judge-model', 'invalid-model-ablate-smoke',
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], { ABLATE_SHIM_SCENARIO: '' });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, capture('probe-judge-model.stderr'));
});

test('probe: init event and its plugin entries cover the real capture', (t) => {
  const s = sandbox(t);
  const res = s.run(['-p', 'reply OK', '--model', 'haiku', '--plugin-dir', s.arm, '--output-format', 'stream-json', '--verbose', '--max-turns', '1'], { ABLATE_SHIM_SCENARIO: path.join(ROOT, 'test/fixtures/ablate/scenarios/base.json') });
  assert.equal(res.status, 0, res.stderr);
  const shim = jsonl(res.stdout);
  const real = jsonl(capture('probe.jsonl'));
  const init = (events) => events.find((e) => e.type === 'system' && e.subtype === 'init');
  assertCovers(init(shim), init(real), 'probe init');
  assertCovers(shim.find((e) => e.type === 'result'), real.find((e) => e.type === 'result'), 'probe result');
  // The shim's arm entry and builtin entries have the real entry keys.
  const entryKeys = (events, pick) => keys(init(events).plugins.find(pick));
  const inline = (p) => p.source.endsWith('@inline');
  const builtin = (p) => p.path === 'builtin';
  assert.deepEqual(entryKeys(shim, inline), entryKeys(real, inline));
  assert.deepEqual(entryKeys(shim, builtin), entryKeys(real, builtin));
});

test('analyst: init (agent listed, inline plugin) and result events cover the real capture', (t) => {
  const s = sandbox(t);
  const res = s.run(['-p', '--agent', 'rstaff-ai:experiment-analyst', '--plugin-dir', 'plugins/rstaff-ai', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', 'x y'], { ABLATE_SHIM_SCENARIO: '' });
  assert.equal(res.status, 0, res.stderr);
  const shim = jsonl(res.stdout);
  const real = jsonl(capture('analyst.jsonl'));
  const init = (events) => events.find((e) => e.type === 'system' && e.subtype === 'init');
  assertCovers(init(shim), init(real), 'analyst init');
  assertCovers(shim.find((e) => e.type === 'result'), real.find((e) => e.type === 'result'), 'analyst result');
  assert.ok(init(real).plugins.some((p) => p.source === 'rstaff-ai@inline'));
  assert.ok(init(shim).plugins.some((p) => p.source === 'rstaff-ai@inline'));
});

test('captures are $0 and free of private state', () => {
  const real = JSON.parse(capture('eval-aggregate.json'));
  assert.equal(real.costUsd, 0);
  assert.equal(real.suite.modelOverride, 'invalid-model-zzz');
  assert.equal(real.suite.judgeModel, 'invalid-model-zzz');
  for (const f of ['probe.jsonl', 'analyst.jsonl']) {
    const result = jsonl(capture(f)).find((e) => e.type === 'result');
    assert.equal(result.total_cost_usd, 0, f);
  }
  for (const f of fs.readdirSync(REAL)) assert.doesNotMatch(capture(f), /\/Users\/|\/private\/|\/tmp\//, f);
});
