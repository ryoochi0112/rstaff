'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { sha256, treeHash } = require('../../maintainer/ablate/arms.js');
const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'test/fixtures/ablate');
const MODE = 'analyst-contract-check (replayed legacy evidence; not a live registration)';
const CASE = 'one-question-before-design';

function sandbox(t, scenario = 'analyst-agree', { defaultOut = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-analyst-check-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, bytes) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  const plugin = 'plugins/rstaff-pm';
  put(`${plugin}/.claude-plugin/plugin.json`, '{"name":"rstaff-pm","dependencies":["rstaff"]}');
  put(`${plugin}/skills/grilling/SKILL.md`, '---\nname: grilling\ndescription: Test\n---\n\nOriginal body.\n');
  put(`${plugin}/ablation/grilling/known-fail.md`, '\nKnown fail.\n');
  put(`${plugin}/ablation/grilling/ablation.json`, JSON.stringify({ case: CASE }));
  put(`${plugin}/evals/grilling-compliance/${CASE}/case.yaml`, JSON.stringify({
    name: 'grilling-compliance-one-question-before-design', execution: { max_turns: 2, prompt: 'Question' },
    graders: [{ name: 'judge', type: 'llm', criteria: 'Asks one question' }],
  }));
  fs.cpSync(path.join(ROOT, 'maintainer/ablate'), path.join(root, 'maintainer/ablate'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'maintainer/lib-eval-copy.js'), path.join(root, 'maintainer/lib-eval-copy.js'));
  const cli = path.join(root, 'maintainer/ablate/ablate.js');
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scenarios/base.json')));
  const delta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `scenarios/${scenario}.json`)));
  put('scenario.json', JSON.stringify({ ...base, ...delta, legs: { ...base.legs, ...delta.legs } }));
  // Observe the files at the process boundary, then forward to the unchanged, capture-backed shim.
  put('bin/forward.js', `const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--agent')) {
  const out = process.env.CHECK_OUTPUT;
  const read = (name) => fs.readFileSync(path.join(out, name), 'utf8');
  fs.writeFileSync(path.join(out, 'analyst-inputs.json'), JSON.stringify({
    ticket: read('ticket.md'), certificate: read('certificate.json'),
  }));
}
require(${JSON.stringify(path.join(FIXTURES, 'claude-shim.js'))});
`);
  put('bin/claude', `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'bin/forward.js')}" "$@"\n`);
  fs.chmodSync(path.join(root, 'bin/claude'), 0o755);
  // Both entry paths must invoke this very function object; a copied finalizer bypasses the spy.
  put('spy.js', `const fs = require('node:fs');
const cli = require(${JSON.stringify(cli)});
const finalize = cli.finalize;
const calls = [];
cli.finalize = (...args) => {
  calls.push({ outDir: args[0].outDir, recordPath: args[1].recordPath, legacy: args[2].legacy });
  return finalize(...args);
};
process.exitCode = cli.main(process.argv.slice(2));
fs.writeFileSync(process.env.FINALIZE_SPY, JSON.stringify(calls));
`);
  const out = defaultOut
    ? path.join(root, 'var/experiments/rstaff', `analyst-check-grilling-${new Date().toISOString().slice(0, 10)}`)
    : path.join(root, 'output with spaces');
  const raw = path.join(out, 'raw');
  const recordPath = `${out}.md`;
  const trace = path.join(root, 'trace');
  const spy = path.join(root, 'finalize-spy.json');
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
    ABLATE_SHIM_SCENARIO: path.join(root, 'scenario.json'), RSTAFF_ABLATE_TRACE: trace,
    // The shim logs probes/legs and analyst argv to the same trace, covering every claude call.
    ABLATE_SHIM_ARGV_LOG: trace, CHECK_OUTPUT: out, FINALIZE_SPY: spy };
  const run = (extra, { useSpy = false } = {}) => spawnSync(process.execPath,
    [useSpy ? path.join(root, 'spy.js') : cli, '--skill', 'grilling', ...(defaultOut ? [] : ['--out', out]), ...extra],
    { cwd: root, env, encoding: 'utf8' });
  const lines = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n') : [];
  const analystArgv = ['-p', '--agent', 'rstaff-ai:experiment-analyst', '--plugin-dir', 'plugins/rstaff-ai',
    '--output-format', 'stream-json', '--verbose', `${recordPath} ${raw}`];
  return { root, out, raw, recordPath, spy, run, lines, analystArgv };
}

const checkArgs = (input = path.join(FIXTURES, 'v3-outcomes.json')) => ['--analyst-check', input, '--legacy'];
const jsonBlock = (text) => JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);

for (const fixture of ['v3-outcomes.json', 'legacy-raw']) {
  test(`analyst-check ${fixture}: frozen inputs, unanchored prompt, v3 counts and exact evidence copies`, (t) => {
    const s = sandbox(t);
    const input = path.join(FIXTURES, fixture);
    const run = s.run(checkArgs(input));
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const record = fs.readFileSync(s.recordPath, 'utf8');
    const snapshot = fs.readFileSync(path.join(s.out, 'analyst-record-snapshot.md'), 'utf8');
    assert.match(snapshot, new RegExp(`^mode: ${MODE.replace(/[()]/g, '\\$&')}$`, 'm'));
    assert.doesNotMatch(snapshot, /proposed_(verdict|row)/);
    assert.match(snapshot, /^C8 N\/A · legacy data, subject text not captured$/m);
    for (let i = 1; i <= 7; i++) assert.match(snapshot, new RegExp(`^C${i} PASS · `, 'm'));
    assert.match(record, /^proposed_verdict: REJECT$/m);
    assert.match(record, /^proposed_row: 3$/m);
    assert.match(record, /^verdict: REJECT$/m);
    assert.match(run.stdout, /K 0\/5 · N 7\/20 · F 19\/20 · F-bridge 5\/6 · P 13\/20 · P−F = −6/);
    const frozen = jsonBlock(snapshot);
    assert.equal(frozen.mode, MODE);
    assert.equal(frozen.rule_hash, sha256(fs.readFileSync(path.join(ROOT, 'maintainer/ablate/rule.md'))));
    for (const [arm, data] of Object.entries(frozen.arms)) {
      assert.equal(data.treeHash, treeHash(data.dir));
      assert.equal(fs.existsSync(path.join(data.dir, 'skills/grilling/SKILL.md')), arm !== 'null');
      assert.equal(JSON.parse(fs.readFileSync(path.join(data.dir, `evals/grilling-compliance/${CASE}/case.yaml`))).execution.max_turns, 4);
    }
    const invocation = JSON.parse(fs.readFileSync(path.join(s.out, 'analyst-invocation.json')));
    assert.deepEqual(invocation, { argv: s.analystArgv, agent: 'rstaff-ai:experiment-analyst', prompt: `${s.recordPath} ${s.raw}` });
    const beforeSpawn = JSON.parse(fs.readFileSync(path.join(s.out, 'analyst-inputs.json')));
    const ticket = fs.readFileSync(path.join(s.out, 'ticket.md'), 'utf8');
    assert.equal(beforeSpawn.ticket, ticket);
    assert.equal(beforeSpawn.certificate, fs.readFileSync(path.join(s.out, 'certificate.json'), 'utf8'));
    const fields = jsonBlock(ticket);
    assert.deepEqual(fields.bound_hashes, frozen);
    assert.ok(snapshot.includes(`ticket: ${path.join(s.out, 'ticket.md')}\n`));
    assert.ok(snapshot.includes(`harness_certificate: ${fields.harness_certificate_id}\n`));
    const registrationHash = ticket.match(/^registration_hash: (.*)$/m)[1];
    assert.equal(registrationHash, sha256(ticket.replace(/^registration_hash: .*\n/m, '')));
    const cert = JSON.parse(beforeSpawn.certificate);
    assert.equal(cert.registration_hash, registrationHash);
    assert.equal(cert.status, 'valid');
    assert.deepEqual(cert.failing_ids, []);
    assert.deepEqual(cert.fixture_results, { K: { passes: 0, total: 5, errors: 0 }, N: { passes: 7, total: 20, errors: 0 },
      F: { passes: 19, total: 20, errors: 0 }, 'F-bridge': { passes: 5, total: 6, errors: 0 } });
    const outcome = JSON.parse(fs.readFileSync(path.join(s.out, 'outcomes.json')));
    assert.equal(outcome.legacy, true);
    assert.equal(outcome.registration_hash, registrationHash);
    assert.deepEqual(outcome.guardrails, { breached: false, changed: [] });
    assert.equal(outcome.guardrailsBreached, false);
    // Replayed evidence has no invented live-run timestamps.
    assert.equal(outcome.run_started_at, undefined);
    assert.equal(outcome.run_completed_at, undefined);
    const files = fixture === 'legacy-raw' ? fs.readdirSync(input).sort() : [fixture];
    assert.deepEqual(fs.readdirSync(s.raw).sort(), files);
    const grades = JSON.parse(fs.readFileSync(path.join(s.out, 'grades.json')));
    assert.deepEqual(Object.keys(grades.raw_hashes).sort(), files);
    for (const file of files) {
      const bytes = fs.readFileSync(fixture === 'legacy-raw' ? path.join(input, file) : input);
      assert.deepEqual(fs.readFileSync(path.join(s.raw, file)), bytes);
      assert.equal(grades.raw_hashes[file], sha256(bytes));
    }
    assert.deepEqual(s.lines(), ['record-frozen', JSON.stringify(s.analystArgv)]);
  });
}

test('analyst-check spawns exactly one claude process: the analyst, with no probe or leg', (t) => {
  const s = sandbox(t);
  assert.equal(s.run(checkArgs()).status, 0);
  const calls = s.lines().filter((line) => line !== 'record-frozen');
  assert.equal(calls.length, 1, `claude spawn trace:\n${calls.join('\n')}`);
  assert.deepEqual(calls.map(JSON.parse), [s.analystArgv]);
});

test('live run and analyst-check call the same finalize function object', (t) => {
  for (const legacy of [false, true]) {
    const s = sandbox(t);
    const run = s.run(legacy ? checkArgs() : [], { useSpy: true });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.spy)), [{ outDir: s.out, recordPath: s.recordPath, legacy }]);
    assert.match(fs.readFileSync(s.recordPath, 'utf8'), /^verdict: REJECT$/m);
  }
});

for (const [scenario, verdict] of [['analyst-disagree', 'MISMATCH'], ['analyst-no-verdict', 'NO-VERDICT']]) {
  test(`analyst-check ${verdict} exits 3 and preserves both adjudications`, (t) => {
    const s = sandbox(t, scenario);
    const run = s.run(checkArgs());
    assert.equal(run.status, 3, run.stderr + run.stdout);
    const record = fs.readFileSync(s.recordPath, 'utf8');
    assert.match(record, /^proposed_verdict: REJECT$/m);
    assert.match(record, new RegExp(`^verdict: ${verdict}$`, 'm'));
    assert.deepEqual(s.lines(), ['record-frozen', JSON.stringify(s.analystArgv)]);
  });
}

test('analyst-check agreement on INVALID-HARNESS exits 0 as a contract check', (t) => {
  const s = sandbox(t);
  const input = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'v3-outcomes.json')));
  input.legs[0].runs[0].judgePass = true;
  input.legs[0].runs[1].judgePass = true;
  input.run_started_at = '2000-01-01T00:00:00.000Z';
  input.run_completed_at = '2000-01-01T01:00:00.000Z';
  const source = path.join(s.root, 'historical-outcomes.json');
  fs.writeFileSync(source, JSON.stringify(input));
  fs.writeFileSync(path.join(s.root, 'scenario.json'), JSON.stringify({ analyst: { text: '## Experiment verdict: INVALID-HARNESS' } }));
  const run = s.run(checkArgs(source));
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(fs.readFileSync(s.recordPath, 'utf8'), /^verdict: INVALID-HARNESS$/m);
  const saved = JSON.parse(fs.readFileSync(path.join(s.out, 'outcomes.json')));
  assert.equal(saved.run_started_at, input.run_started_at);
  assert.equal(saved.run_completed_at, input.run_completed_at);
  const cert = JSON.parse(fs.readFileSync(path.join(s.out, 'certificate.json')));
  assert.equal(cert.status, 'invalid');
  assert.deepEqual(cert.failing_ids, ['C1']);
});

test('analyst-check default output uses analyst-check-<skill>-<UTC date> in the scratch repo', (t) => {
  const s = sandbox(t, 'analyst-agree', { defaultOut: true });
  const run = s.run(checkArgs());
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.ok(run.stdout.includes(`record: ${s.recordPath}\n`));
  assert.deepEqual(s.lines(), ['record-frozen', JSON.stringify(s.analystArgv)]);
});

for (const extra of [['--contract-smoke'], ['--shakeout'], ['--stop-after', 'freeze'], ['--replay', 'unused']]) {
  test(`analyst-check refuses ${extra[0]} before creating output or spawning`, (t) => {
    const s = sandbox(t);
    const run = s.run([...checkArgs(), ...extra]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /exclusive/);
    assert.deepEqual(s.lines(), []);
    assert.equal(fs.existsSync(s.out), false);
    assert.equal(fs.existsSync(s.recordPath), false);
  });
}

test('analyst-check requires --legacy before creating output or spawning', (t) => {
  const s = sandbox(t);
  const run = s.run(['--analyst-check', path.join(FIXTURES, 'v3-outcomes.json')]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /requires.*--legacy/);
  assert.deepEqual(s.lines(), []);
  assert.equal(fs.existsSync(s.out), false);
});

for (const target of ['directory', 'record']) {
  test(`analyst-check refuses an existing output ${target} without changing it or spawning`, (t) => {
    const s = sandbox(t);
    if (target === 'directory') fs.mkdirSync(s.out);
    else fs.writeFileSync(s.recordPath, 'existing record\n');
    const run = s.run(checkArgs());
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Output path already exists/);
    assert.deepEqual(s.lines(), []);
    if (target === 'directory') assert.deepEqual(fs.readdirSync(s.out), []);
    else {
      assert.equal(fs.readFileSync(s.recordPath, 'utf8'), 'existing record\n');
      assert.equal(fs.existsSync(s.out), false);
    }
  });
}
