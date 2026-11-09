'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { runSmoke } = require('../../maintainer/ablate/smoke.js');
const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'maintainer/ablate/ablate.js');
const SHIM = path.join(ROOT, 'test/fixtures/ablate/claude-shim.js');
const REAL = path.join(ROOT, 'test/fixtures/ablate/real');
const ARMS = ['full', 'placebo', 'null', 'known-fail'];
const OWNER = 'rstaff-pm';
const CASE_DIR = 'one-question-before-design';
const CASE_NAME = 'grilling-compliance-one-question-before-design';
const MODEL = 'invalid-model-ablate-smoke';
const CHECKS = ['probe init owner plugin', 'aggregate exists', 'cases.length === 1', 'cases[0].name === caseName',
  'cases[0].maxTurns === 4', 'suite.plugins owner and arm path', 'costUsd === 0', 'fromPluginEval parses aggregate', 'every run has error: true'];

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ablate-smoke-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sandbox(t, { refuseCase = false } = {}) {
  const root = scratch(t);
  const put = (rel, bytes) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  const plugin = `plugins/${OWNER}`;
  put(`${plugin}/.claude-plugin/plugin.json`, JSON.stringify({ name: OWNER, dependencies: ['rstaff'] }));
  put(`${plugin}/skills/grilling/SKILL.md`, '---\nname: grilling\ndescription: Test\n---\n\nOriginal body.\n');
  put(`${plugin}/ablation/grilling/known-fail.md`, '\nKnown fail.\n');
  put(`${plugin}/ablation/grilling/ablation.json`, JSON.stringify({ case: CASE_DIR }));
  // The source cap differs: smoke must exercise buildArms' frozen cap of 4.
  put(`${plugin}/evals/grilling-compliance/${CASE_DIR}/case.yaml`, JSON.stringify({ name: CASE_NAME,
    execution: { max_turns: 2, prompt: 'Question' }, graders: [{ name: 'judge', type: 'llm', criteria: 'One question' }] }));
  put('maintainer/ablate/rule.md', fs.readFileSync(path.join(ROOT, 'maintainer/ablate/rule.md')));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/ablate/scenarios/base.json')));
  put('scenario.json', JSON.stringify({ ...base, legs: Object.fromEntries(ARMS.map((arm) => [arm, { passes: 0, errors: 1 }])) }));
  // Forward to the unchanged fidelity-tested shim. The refusal scenario injects the old dir-name bug.
  put('bin/forward.js', `${refuseCase ? `const i = process.argv.indexOf('--case'); if (i >= 0) process.argv[i + 1] = ${JSON.stringify(CASE_DIR)};\n` : ''}require(${JSON.stringify(SHIM)});\n`);
  put('bin/claude', `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'bin/forward.js')}" "$@"\n`);
  fs.chmodSync(path.join(root, 'bin/claude'), 0o755);
  const trace = path.join(root, 'trace');
  const out = path.join(root, 'output with spaces');
  const smoke = `${out}-smoke`;
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, ABLATE_SHIM_SCENARIO: path.join(root, 'scenario.json'),
    RSTAFF_ABLATE_TRACE: trace };
  const run = (extra = []) => spawnSync(process.execPath, [CLI, '--skill', 'grilling', '--out', out, '--contract-smoke', ...extra],
    { cwd: root, env, encoding: 'utf8' });
  const lines = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n') : [];
  const calls = () => lines().map((line) => {
    const [kind, arm] = line.split(' ');
    return { kind, arm, argv: JSON.parse(line.slice(line.indexOf('['))) };
  });
  return { root, out, smoke, trace, run, lines, calls };
}

test('smoke argv: all eight spawns use the invalid model; only legs use the invalid judge', (t) => {
  const s = sandbox(t);
  const result = s.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = s.calls();
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map((c) => [c.kind, c.arm]), ARMS.flatMap((arm) => [['probe', arm], ['leg', arm]]));
  for (const [i, arm] of ARMS.entries()) {
    const armDir = path.join(s.smoke, 'arms', arm, OWNER);
    assert.deepEqual(calls[2 * i].argv, ['-p', 'reply OK', '--model', MODEL, '--plugin-dir', armDir,
      '--output-format', 'stream-json', '--verbose', '--max-turns', '1']);
    assert.deepEqual(calls[2 * i + 1].argv, ['plugin', 'eval', armDir, '--ablation', 'none', '--model', MODEL, '--runs', '1',
      '--case', CASE_NAME, '--no-publish', '--trust-plugin', '--output-dir', `${path.join(s.smoke, 'raw', `${i + 1}-${arm}`)}/`, '--judge-model', MODEL]);
    assert.equal(calls[2 * i].argv.includes('--judge-model'), false);
    assert.equal(calls[2 * i + 1].argv[calls[2 * i + 1].argv.indexOf('--judge-model') + 1], MODEL);
    for (const c of calls.slice(2 * i, 2 * i + 2)) {
      assert.equal(c.argv[c.argv.indexOf('--model') + 1], MODEL);
      assert.equal(c.argv.includes('haiku'), false);
    }
    for (const name of CHECKS) assert.ok(result.stdout.includes(`${arm} PASS ${name} · `), result.stdout);
    assert.ok(result.stdout.includes(`${arm} PASS costUsd === 0 · costUsd: 0`));
    const aggregate = JSON.parse(fs.readFileSync(path.join(s.smoke, 'raw', `${i + 1}-${arm}`, 'aggregate-result.json')));
    assert.equal(aggregate.cases[0].maxTurns, 4);
    assert.equal(aggregate.cases[0].arms.with.length, 1);
    assert.notEqual(aggregate.cases[0].arms.with[0].error, null);
    assert.ok(fs.existsSync(path.join(s.smoke, 'raw', `probe-${arm}.jsonl`)));
  }
  assert.equal(result.stdout.trim().split('\n').length, ARMS.length * CHECKS.length);
  assert.doesNotMatch(result.stdout, /FAIL/);
  assert.equal(s.lines().includes('record-frozen'), false);
  assert.deepEqual(fs.readdirSync(s.smoke).sort(), ['arms', 'raw']);
  for (const target of [s.out, `${s.out}.md`, `${s.smoke}.md`]) assert.equal(fs.existsSync(target), false, target);
});

test('a dir-name --case refused by the shim exits 1 and prints the failing check for every arm', (t) => {
  const s = sandbox(t, { refuseCase: true });
  const result = s.run();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(s.calls().length, 8, 'exactly one probe and leg per arm, even on failure');
  for (const [i, arm] of ARMS.entries()) {
    assert.ok(result.stdout.includes(`${arm} FAIL aggregate exists · `), result.stdout);
    assert.ok(result.stdout.includes(`${arm} FAIL fromPluginEval parses aggregate · `), result.stdout);
    const raw = path.join(s.smoke, 'raw', `${i + 1}-${arm}`);
    assert.equal(fs.existsSync(path.join(raw, 'aggregate-result.json')), false);
    assert.match(fs.readFileSync(path.join(raw, 'stderr.txt'), 'utf8'), /No eval cases found matching --case "one-question-before-design"/);
  }
  assert.deepEqual(fs.readdirSync(s.smoke).sort(), ['arms', 'raw']);
});

test('an existing smoke directory is refused without spawning or changing evidence', (t) => {
  const s = sandbox(t);
  assert.equal(s.run().status, 0);
  const before = fs.readFileSync(s.trace, 'utf8');
  const again = s.run();
  assert.equal(again.status, 1);
  assert.match(again.stderr, /contract smoke FAIL.*Output path already exists/);
  assert.equal(fs.readFileSync(s.trace, 'utf8'), before);
});

test('a dangling symlink at the smoke output is refused before any spawn', (t) => {
  const s = sandbox(t);
  fs.symlinkSync(path.join(s.root, 'missing'), s.smoke);
  assert.equal(s.run().status, 1);
  assert.deepEqual(s.lines(), []);
  assert.equal(fs.lstatSync(s.smoke).isSymbolicLink(), true);
});

for (const extra of [['--shakeout'], ['--stop-after', 'freeze'], ['--replay', 'unused', '--legacy']]) {
  test(`--contract-smoke refuses ${extra[0]} before any spawn`, (t) => {
    const s = sandbox(t);
    const result = s.run(extra);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /exclusive/);
    assert.deepEqual(s.lines(), []);
    assert.equal(fs.existsSync(s.smoke), false);
    assert.equal(fs.existsSync(s.out), false);
  });
}

test('smoke preflight failures exit 1 without creating output or spawning', (t) => {
  const s = sandbox(t);
  fs.unlinkSync(path.join(s.root, `plugins/${OWNER}/ablation/grilling/known-fail.md`));
  const result = s.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contract smoke FAIL.*known-fail.md/);
  assert.deepEqual(s.lines(), []);
  assert.equal(fs.existsSync(s.smoke), false);
});

// These checks read the same captured fields as the shim, without extending its contract.
function capturedSmoke(t, fault = {}) {
  const root = scratch(t);
  const arms = Object.fromEntries(ARMS.map((arm) => [arm, { dir: path.join(root, 'arms', arm, OWNER) }]));
  for (const { dir } of Object.values(arms)) fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const calls = [];
  const pass = runSmoke({ arms, caseName: CASE_NAME, owner: OWNER, rawDir: path.join(root, 'raw'), log: (line) => lines.push(line),
    spawn: (argv) => {
      calls.push(argv);
      if (argv[0] === 'plugin') {
        const aggregate = JSON.parse(fs.readFileSync(path.join(REAL, 'eval-aggregate.json')));
        aggregate.suite.plugins[0].path = argv[2];
        if (typeof fault.aggregate === 'function') fault.aggregate(aggregate);
        if (fault.aggregate !== 'missing') fs.writeFileSync(path.join(argv[argv.indexOf('--output-dir') + 1], 'aggregate-result.json'),
          fault.aggregate === 'invalid' ? '{truncated' : JSON.stringify(aggregate));
        return { status: 1, stdout: '', stderr: 'invalid model' };
      }
      const events = fs.readFileSync(path.join(REAL, 'probe.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      events[0].plugins[0].path = argv[argv.indexOf('--plugin-dir') + 1];
      if (fault.probe) fault.probe(events);
      return { status: 1, stdout: events.map((e) => JSON.stringify(e)).join('\n'), stderr: '' };
    } });
  return { pass, lines, calls };
}

test('the real $0 captures pass all smoke checks despite child exit 1', (t) => {
  const result = capturedSmoke(t);
  assert.equal(result.pass, true, result.lines.join('\n'));
  assert.equal(result.calls.length, 8);
  assert.deepEqual(result.lines.map((line) => line.split(' · ')[0]), ARMS.flatMap((arm) => CHECKS.map((name) => `${arm} PASS ${name}`)));
});

for (const [name, fault, check] of [
  ['missing aggregate', { aggregate: 'missing' }, 'aggregate exists'],
  ['invalid JSON', { aggregate: 'invalid' }, 'fromPluginEval parses aggregate'],
  ['no cases', { aggregate: (a) => { a.cases = []; } }, 'cases.length === 1'],
  ['multiple cases', { aggregate: (a) => { a.cases.push(structuredClone(a.cases[0])); } }, 'cases.length === 1'],
  ['wrong case name', { aggregate: (a) => { a.cases[0].name = CASE_DIR; } }, 'cases[0].name === caseName'],
  ['wrong cap', { aggregate: (a) => { a.cases[0].maxTurns = 2; } }, 'cases[0].maxTurns === 4'],
  ['missing suite plugin', { aggregate: (a) => { a.suite.plugins = []; } }, 'suite.plugins owner and arm path'],
  ['extra suite plugin', { aggregate: (a) => { a.suite.plugins.push({ name: 'other', path: 'elsewhere' }); } }, 'suite.plugins owner and arm path'],
  ['wrong suite owner', { aggregate: (a) => { a.suite.plugins[0].name = 'other'; } }, 'suite.plugins owner and arm path'],
  ['wrong suite path', { aggregate: (a) => { a.suite.plugins[0].path = 'elsewhere'; } }, 'suite.plugins owner and arm path'],
  ['nonzero cost', { aggregate: (a) => { a.costUsd = 0.01; } }, 'costUsd === 0'],
  ['missing cost', { aggregate: (a) => { delete a.costUsd; } }, 'costUsd === 0'],
  ['string cost', { aggregate: (a) => { a.costUsd = '0'; } }, 'costUsd === 0'],
  ['missing runs', { aggregate: (a) => { delete a.cases[0].arms.with; } }, 'fromPluginEval parses aggregate'],
  ['empty runs', { aggregate: (a) => { a.cases[0].arms.with = []; } }, 'fromPluginEval parses aggregate'],
  ['a non-error run', { aggregate: (a) => { a.cases[0].arms.with.push({ ...a.cases[0].arms.with[0], error: null }); } }, 'every run has error: true'],
  ['no probe init', { probe: (events) => { events.shift(); } }, 'probe init owner plugin'],
  ['missing probe owner', { probe: (events) => { events[0].plugins.shift(); } }, 'probe init owner plugin'],
  ['duplicate probe owner', { probe: (events) => { events[0].plugins.push({ ...events[0].plugins[0] }); } }, 'probe init owner plugin'],
  ['wrong probe source', { probe: (events) => { events[0].plugins[0].source = `${OWNER}@rstaff`; } }, 'probe init owner plugin'],
  ['wrong probe path', { probe: (events) => { events[0].plugins[0].path = 'elsewhere'; } }, 'probe init owner plugin'],
]) {
  test(`smoke fails closed: ${name}`, (t) => {
    const result = capturedSmoke(t, fault);
    assert.equal(result.pass, false);
    assert.equal(result.calls.length, 8);
    for (const arm of ARMS) assert.ok(result.lines.some((line) => line.startsWith(`${arm} FAIL ${check} · `)), result.lines.join('\n'));
  });
}
