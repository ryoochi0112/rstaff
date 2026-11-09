'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'maintainer/ablate/ablate.js');
const SHIM = path.join(ROOT, 'test/fixtures/ablate/claude-shim.js');
const SCENARIOS = path.join(ROOT, 'test/fixtures/ablate/scenarios');
const CASE = 'one-question-before-design';
const CASE_NAME = 'grilling-compliance-one-question-before-design';

// The sealed order: K, stage 1, stage 2 as (arm, n).
const K = [['known-fail', 5]];
const STAGE1 = [['null', 5], ['full', 5], ['full', 5], ['null', 5], ['null', 5], ['full', 5], ['full', 5], ['null', 5]];
const STAGE2 = [['placebo', 5], ['full', 3], ['placebo', 5], ['placebo', 5], ['full', 3], ['placebo', 5]];
const PROBES = ['full', 'placebo', 'null', 'known-fail'];

function sandbox(t, scenarioName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ablate-seq-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  const plugin = path.join(root, 'plugins/rstaff-pm');
  put(path.join(plugin, '.claude-plugin/plugin.json'), '{"name":"rstaff-pm","dependencies":["rstaff"]}');
  put(path.join(plugin, 'skills/grilling/SKILL.md'), '---\nname: grilling\ndescription: Test\n---\n\nOriginal body.\n');
  put(path.join(plugin, 'ablation/grilling/known-fail.md'), '\nKnown fail.\n');
  put(path.join(plugin, 'ablation/grilling/ablation.json'), `{"case":"${CASE}"}`);
  put(path.join(plugin, `evals/grilling-compliance/${CASE}/case.yaml`), '{"name":"grilling-compliance-one-question-before-design","execution":{"max_turns":2,"prompt":"Question"},"graders":[{"name":"judge","type":"llm","criteria":"Asks one question"}]}');
  put(path.join(root, 'maintainer/ablate/rule.md'), 'Frozen decision rule\ncap: 4\njudge: haiku\n');
  put(path.join(root, 'bin/claude'), `#!/bin/sh\nexec "${process.execPath}" "${SHIM}" "$@"\n`);
  fs.chmodSync(path.join(root, 'bin/claude'), 0o755);
  const base = JSON.parse(fs.readFileSync(path.join(SCENARIOS, 'base.json'), 'utf8'));
  const delta = JSON.parse(fs.readFileSync(path.join(SCENARIOS, `${scenarioName}.json`), 'utf8'));
  const scenario = path.join(root, 'scenario.json');
  put(scenario, JSON.stringify({ ...base, ...delta, legs: { ...base.legs, ...delta.legs } }));
  const trace = path.join(root, 'trace');
  const out = path.join(root, 'out');
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, ABLATE_SHIM_SCENARIO: scenario, RSTAFF_ABLATE_TRACE: trace };
  const run = (extra = []) => spawnSync(process.execPath, [CLI, '--skill', 'grilling', '--out', out, ...extra], { cwd: root, env, encoding: 'utf8' });
  const lines = () => (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean) : []);
  const calls = () => lines().filter((l) => !l.startsWith('record-frozen')).map((l) => {
    const [kind, arm, third] = l.split(' ');
    return { kind, arm, n: kind === 'leg' ? Number(third) : undefined, argv: JSON.parse(l.slice(l.indexOf('['))) };
  });
  const legs = () => calls().filter((c) => c.kind === 'leg').map((c) => [c.arm, c.n]);
  const record = () => fs.readFileSync(`${out}.md`, 'utf8');
  return { root, out, run, lines, calls, legs, record, trace };
}

test('happy path: sealed order, exact argv, frozen background, record before first leg', (t) => {
  const s = sandbox(t, 'happy');
  const result = s.run();
  const calls = s.calls();
  // AC6(b): every leg argv is exact, including its arm dir, runs and the designated case.
  calls.filter((c) => c.kind === 'leg').forEach((c, i) => {
    const armDir = path.join(s.out, 'arms', c.arm, 'rstaff-pm');
    assert.deepEqual(c.argv, ['plugin', 'eval', armDir, '--ablation', 'none', '--model', 'haiku', '--runs', String(c.n), '--case', CASE_NAME,
      '--no-publish', '--trust-plugin', '--output-dir', `${path.join(s.out, 'raw', `${i + 1}-${c.arm}`)}/`]);
  });
  // AC6(a): pre probes, K, stage 1, stage 2, post probe.
  assert.deepEqual(calls.map((c) => c.kind === 'leg' ? `leg ${c.arm} ${c.n}` : `${c.kind} ${c.arm}`), [
    ...PROBES.map((a) => `probe ${a}`), ...[...K, ...STAGE1, ...STAGE2].map(([a, n]) => `leg ${a} ${n}`), 'probe full']);
  assert.equal(result.status, 0, result.stderr);
  for (const c of calls.filter((x) => x.kind === 'probe')) {
    assert.deepEqual(c.argv, ['-p', 'reply OK', '--model', 'haiku', '--plugin-dir', path.join(s.out, 'arms', c.arm, 'rstaff-pm'),
      '--output-format', 'stream-json', '--verbose', '--max-turns', '1']);
  }
  // AC5(e): the record is frozen before the first leg.
  const lines = s.lines();
  assert.equal(lines.indexOf('record-frozen'), 0);
  assert.ok(lines.indexOf('record-frozen') < lines.findIndex((l) => l.startsWith('leg ')));
  // Ruling A: background frozen as sorted name@source, with no paths in the record.
  const record = s.record();
  assert.equal(JSON.parse(record.match(/```json\n([\s\S]*?)\n```/)[1]).case, CASE);
  assert.ok(result.stdout.includes(`haiku · case ${CASE} · rule`));
  const block = record.match(/background_plugins:\n```json\n([\s\S]*?)\n```/);
  assert.ok(block, record);
  const frozen = JSON.parse(block[1]);
  assert.equal(frozen.length, 12);
  assert.deepEqual(frozen, [...frozen].sort());
  assert.ok(frozen.includes('rstaff@rstaff@rstaff'));
  assert.ok(frozen.includes('cc-plugin-telemetry@cc-plugin-telemetry@builtin'));
  assert.equal(frozen.some((k) => k.startsWith('rstaff-pm@')), false);
  assert.equal(record.includes('/opt/operator'), false);
  assert.ok(record.indexOf('background_plugins') > record.indexOf('status: FROZEN'));
  for (let i = 1; i <= 8; i++) assert.match(record, new RegExp(`^C${i} PASS`, 'm'));
  assert.match(record, /^proposed_verdict: REJECT$/m);
  assert.match(result.stdout, /K 0\/5 · N 4\/20 · F 20\/20 · F-bridge 6\/6 · P 8\/20 · P−F = −12/);
  const outcomes = JSON.parse(fs.readFileSync(path.join(s.out, 'outcomes.json'), 'utf8'));
  assert.equal(outcomes.probes.pre.full.models[0], 'claude-haiku-4-5-20251001');
  assert.equal(outcomes.legs.length, 15);
});

test('K 2/5 stops after the K leg and names C1', (t) => {
  const s = sandbox(t, 'k-fail');
  const result = s.run();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(s.legs(), K);
  assert.equal(s.calls().filter((c) => c.kind === 'probe').length, 4);
  assert.match(s.record(), /^stopped: gate1$/m);
  assert.match(s.record(), /^failing: C1$/m);
  assert.match(s.record(), /^proposed_verdict: INVALID-HARNESS$/m);
});

test('stage-1 F 15/20 stops after the eighth stage-1 leg with no P leg and names C2', (t) => {
  const s = sandbox(t, 'f-stage1-15');
  const result = s.run();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(s.legs(), [...K, ...STAGE1]);
  assert.equal(s.legs().some(([arm]) => arm === 'placebo'), false);
  assert.match(s.record(), /^stopped: gate2$/m);
  assert.match(s.record(), /^failing: C2$/m);
  assert.match(s.record(), /^C2 FAIL · F 15\/20/m);
});

test('a second invocation on an existing dir exits non-zero and logs no call', (t) => {
  const s = sandbox(t, 'happy');
  assert.equal(s.run(['--stop-after', 'freeze']).status, 0);
  const before = fs.readFileSync(s.trace, 'utf8');
  const again = s.run();
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /exists/);
  assert.equal(fs.readFileSync(s.trace, 'utf8'), before);
});

test('a probe whose background differs from the frozen set fails C4', (t) => {
  const s = sandbox(t, 'background-drift');
  const result = s.run();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(s.legs().length, 15);
  assert.match(s.record(), /^C4 FAIL · .*failing post\/full/m);
  assert.match(s.record(), /^proposed_verdict: INVALID-HARNESS$/m);
});

test('a missing leg JSON is re-run once in place and the run continues', (t) => {
  const s = sandbox(t, 'leg-rerun-once');
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.legs(), [...K, STAGE1[0], STAGE1[1], STAGE1[1], ...STAGE1.slice(2), ...STAGE2]);
  const seq3 = s.calls().filter((c) => c.kind === 'leg' && c.argv.at(-1).endsWith('/3-full/'));
  assert.equal(seq3.length, 2);
  assert.equal(seq3[0].argv.at(-1), seq3[1].argv.at(-1));
  assert.match(result.stderr, /leg 3-full attempt 1: missing or unparseable/);
  assert.match(s.record(), /^proposed_verdict: REJECT$/m);
});

test('a leg JSON missing then unparseable gives INVALID-HARNESS with no further leg', (t) => {
  const s = sandbox(t, 'leg-missing-twice');
  const result = s.run();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(s.legs(), [...K, STAGE1[0], STAGE1[1], STAGE1[1]]);
  assert.match(result.stderr, /leg 3-full attempt 2: missing or unparseable/);
  assert.match(s.record(), /^stopped: harness$/m);
  assert.match(s.record(), /^failing: leg 3-full: missing or unparseable result after one re-run$/m);
  assert.match(s.record(), /^proposed_verdict: INVALID-HARNESS$/m);
});

test('a partial leg that exits non-zero counts its missing runs as errors, never passes', (t) => {
  const s = sandbox(t, 'leg-partial');
  const result = s.run();
  assert.deepEqual(s.legs(), [...K, ...STAGE1], 'no re-run for a parseable partial result; gate 2 stops on C5');
  const outcomes = JSON.parse(fs.readFileSync(path.join(s.out, 'outcomes.json'), 'utf8'));
  const leg3 = outcomes.legs.find((l) => l.seq === 3);
  assert.equal(leg3.runs.length, 5);
  assert.deepEqual(leg3.runs.map((r) => [r.judgePass, r.error]), [[true, false], [true, false], [false, true], [false, true], [false, true]]);
  assert.match(s.record(), /^failing: C5$/m);
  assert.match(s.record(), /^C5 FAIL · .*full 3 errors\/20/m);
  assert.equal(result.status, 1, result.stderr);
});

for (const [name, status, line] of [['shakeout-go', 0, 'shakeout grilling · F 3/3 · N 1/3 · F − N = 2 · go'],
  ['shakeout-nogo', 1, 'shakeout grilling · F 2/3 · N 1/3 · F − N = 1 · no-go']]) {
  test(`--shakeout runs probes then F3 N3 into <out>-shakeout without a record (${name})`, (t) => {
    const s = sandbox(t, name);
    const result = s.run(['--shakeout']);
    assert.equal(result.status, status, result.stderr);
    assert.ok(result.stdout.includes(line), result.stdout);
    assert.deepEqual(s.calls().map((c) => c.kind === 'leg' ? `leg ${c.arm} ${c.n}` : `probe ${c.arm}`),
      [...PROBES.map((a) => `probe ${a}`), 'leg full 3', 'leg null 3']);
    for (const [i, c] of s.calls().filter((c) => c.kind === 'leg').entries()) {
      assert.equal(c.argv[c.argv.indexOf('--case') + 1], CASE_NAME);
      assert.deepEqual(c.argv, ['plugin', 'eval', path.join(`${s.out}-shakeout`, 'arms', c.arm, 'rstaff-pm'),
        '--ablation', 'none', '--model', 'haiku', '--runs', '3', '--case', CASE_NAME,
        '--no-publish', '--trust-plugin', '--output-dir', `${path.join(`${s.out}-shakeout`, 'raw', `${i + 1}-${c.arm}`)}/`]);
    }
    for (const c of s.calls().filter((c) => c.kind === 'probe')) {
      assert.deepEqual(c.argv, ['-p', 'reply OK', '--model', 'haiku', '--plugin-dir', path.join(`${s.out}-shakeout`, 'arms', c.arm, 'rstaff-pm'),
        '--output-format', 'stream-json', '--verbose', '--max-turns', '1']);
    }
    assert.equal(s.lines().includes('record-frozen'), false);
    assert.equal(fs.existsSync(s.out), false);
    assert.equal(fs.existsSync(`${s.out}-shakeout/record.md`), false);
    assert.ok(fs.existsSync(`${s.out}-shakeout/raw/1-full/aggregate-result.json`));
    assert.notEqual(s.run(['--shakeout']).status, 0, 'existing shakeout dir is refused');
  });
}
