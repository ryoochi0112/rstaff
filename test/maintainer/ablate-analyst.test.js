'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { commandHash, recheckGuardrails } = require('../../maintainer/ablate/ablate.js');
const { adjudicate } = require('../../maintainer/ablate/lib-adjudicate.js');
const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'maintainer/ablate');
const SHIM = path.join(ROOT, 'test/fixtures/ablate/claude-shim.js');
const CASE = 'one-question-before-design';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function sandbox(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-analyst-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, body) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const plugin = 'plugins/rstaff-pm';
  put(`${plugin}/.claude-plugin/plugin.json`, '{"name":"rstaff-pm","dependencies":["rstaff"]}');
  put(`${plugin}/skills/grilling/SKILL.md`, '---\nname: grilling\ndescription: Test\n---\n\nOriginal body.\n');
  put(`${plugin}/ablation/grilling/known-fail.md`, '\nKnown fail.\n');
  put(`${plugin}/ablation/grilling/ablation.json`, JSON.stringify({ case: CASE }));
  put(`${plugin}/evals/grilling-compliance/${CASE}/case.yaml`, '{"name":"grilling-compliance-one-question-before-design","execution":{"max_turns":2,"prompt":"Question"},"graders":[{"name":"judge","type":"llm","criteria":"Asks one question"}]}');
  put('maintainer/ablate/rule.md', fs.readFileSync(path.join(DIR, 'rule.md')));
  // Copy the command so tests can mutate bound files without changing repository code.
  fs.cpSync(DIR, path.join(root, 'maintainer/ablate'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'maintainer/lib-eval-copy.js'), path.join(root, 'maintainer/lib-eval-copy.js'));
  put('bin/claude', `#!/bin/sh\nexec "${process.execPath}" "${SHIM}" "$@"\n`);
  fs.chmodSync(path.join(root, 'bin/claude'), 0o755);
  const scenarios = path.join(ROOT, 'test/fixtures/ablate/scenarios');
  const base = JSON.parse(fs.readFileSync(path.join(scenarios, 'base.json')));
  const delta = JSON.parse(fs.readFileSync(path.join(scenarios, `${name}.json`)));
  put('scenario.json', JSON.stringify({ ...base, ...delta, legs: { ...base.legs, ...delta.legs } }));
  const out = path.join(root, 'output with spaces');
  const recordPath = `${out}.md`;
  const raw = path.join(out, 'raw');
  const argvLog = path.join(root, 'analyst-argv.jsonl');
  const trace = path.join(root, 'trace');
  const run = () => spawnSync(process.execPath, [path.join(root, 'maintainer/ablate/ablate.js'), '--skill', 'grilling', '--out', out], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
      ABLATE_SHIM_SCENARIO: path.join(root, 'scenario.json'), RSTAFF_ABLATE_TRACE: trace, ABLATE_SHIM_ARGV_LOG: argvLog },
  });
  const record = () => fs.readFileSync(recordPath, 'utf8');
  const frozen = () => JSON.parse(record().match(/```json\n([\s\S]*?)\n```/)[1]);
  const outcomes = () => JSON.parse(fs.readFileSync(path.join(out, 'outcomes.json')));
  return { root, out, raw, recordPath, argvLog, trace, run, record, frozen, outcomes };
}

test('AC7 fresh analyst exact argv, verbatim transcript, hashes, checks and golden stdout tail', (t) => {
  const s = sandbox(t, 'analyst-agree');
  const run = s.run();
  assert.equal(run.status, 0, run.stderr);
  const record = s.record();
  const frozen = s.frozen();
  assert.equal(frozen.rule_hash, sha(fs.readFileSync(path.join(DIR, 'rule.md'))));
  assert.equal(frozen.command_hash, commandHash());
  const transcriptPath = path.join(s.out, 'analyst.jsonl');
  assert.match(record, /^adjudicated_by: rstaff-ai:experiment-analyst$/m);
  assert.ok(record.includes(`analyst_transcript: ${transcriptPath}\n`));
  assert.match(record, /^matched_row: 3$/m);
  assert.match(record, /^verdict: REJECT$/m);
  for (let i = 1; i <= 8; i++) assert.match(record, new RegExp(`^C${i} PASS · .*\\d`, 'm'));
  const argv = fs.readFileSync(s.argvLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(argv, [['-p', '--agent', 'rstaff-ai:experiment-analyst', '--plugin-dir', 'plugins/rstaff-ai',
    '--output-format', 'stream-json', '--verbose', `${s.recordPath} ${s.raw}`]]);
  const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/ablate/scenarios/analyst-agree.json')));
  const invocation = JSON.parse(fs.readFileSync(path.join(s.out, 'analyst-invocation.json')));
  assert.deepEqual(invocation, { argv: argv[0], agent: 'rstaff-ai:experiment-analyst', prompt: `${s.recordPath} ${s.raw}` });
  // Byte-for-byte: the saved transcript must equal the stream an independent shim run emits for the same argv and scenario.
  // The prompt is replaced with a placeholder so this extra run cannot overwrite the snapshot the shim writes for the real prompt.
  const independent = spawnSync(process.execPath, [SHIM, ...argv[0].slice(0, -1), 'independent-run'], {
    encoding: 'utf8', env: { ...process.env, ABLATE_SHIM_SCENARIO: path.join(s.root, 'scenario.json') },
  });
  assert.equal(independent.status, 0, independent.stderr);
  assert.ok(independent.stdout.includes(JSON.stringify(scenario.analyst.text).slice(1, -1)));
  assert.equal(fs.readFileSync(transcriptPath, 'utf8'), independent.stdout);
  const snapshot = fs.readFileSync(path.join(s.out, 'analyst-record-snapshot.md'), 'utf8');
  assert.doesNotMatch(snapshot, /proposed_(verdict|row)/);
  assert.match(record, /^proposed_verdict: REJECT$/m);
  assert.match(record, /^proposed_row: 3$/m);
  const ticket = fs.readFileSync(path.join(s.out, 'ticket.md'), 'utf8');
  assert.equal(fs.readFileSync(path.join(s.out, 'first-leg-ticket.md'), 'utf8'), ticket);
  const hash = ticket.match(/^registration_hash: (.*)$/m)[1];
  assert.equal(hash, sha(ticket.replace(/^registration_hash: .*\n/m, '')));
  const fields = JSON.parse(ticket.match(/```json\n([\s\S]*?)\n```/)[1]);
  for (const field of ['hypothesis', 'null', 'primary_metric', 'estimand', 'practical_threshold', 'guardrails', 'control', 'candidate', 'intervention_surface', 'sample_plan', 'pairing', 'error_policy', 'stopping_rule', 'holdout_exposure', 'adjudicator', 'harness_certificate_id', 'rule_hash', 'registered_at', 'bound_hashes', 'evidence']) assert.ok(fields[field], field);
  assert.ok(ticket.includes(fs.readFileSync(path.join(DIR, 'rule.md'), 'utf8')));
  assert.equal(fields.rule_hash, frozen.rule_hash);
  assert.equal(fields.control.tree_hash, frozen.arms.full.treeHash);
  assert.equal(fields.candidate.tree_hash, frozen.arms.placebo.treeHash);
  assert.deepEqual(fields.sample_plan, { N_cases: 1, case: CASE, N_trials_per_case: { K: 5, N: 20, F: 20, 'F-bridge': 6, P: 20 } });
  const cert = JSON.parse(fs.readFileSync(path.join(s.out, 'certificate.json')));
  assert.equal(cert.status, 'valid');
  assert.deepEqual(cert.failing_ids, []);
  assert.equal(cert.registration_hash, hash);
  assert.equal(cert.registered_at, fields.registered_at);
  assert.ok(Date.parse(cert.certified_at) >= Date.parse(fields.registered_at));
  assert.equal(cert.rule_hash, frozen.rule_hash);
  assert.equal(cert.command_hash, frozen.command_hash);
  assert.deepEqual(cert.arms, frozen.arms);
  assert.deepEqual(cert.case_files, frozen.case_files);
  assert.equal(cert.cases_manifest_hash, frozen.case_hash);
  assert.equal(cert.judge.model, 'haiku');
  assert.equal(cert.subject_model_id, s.outcomes().probes.pre.full.models[0]);
  const grades = JSON.parse(fs.readFileSync(path.join(s.out, 'grades.json')));
  assert.equal(grades.hashes.grader, cert.graders[0].impl_hash);
  assert.equal(grades.hashes.cases, cert.cases_manifest_hash);
  assert.ok(Date.parse(grades.run_started_at) >= Date.parse(fields.registered_at));
  assert.ok(Date.parse(grades.run_completed_at) <= Date.parse(cert.certified_at));
  const rawFiles = fs.readdirSync(s.raw, { recursive: true }).filter(file => fs.statSync(path.join(s.raw, file)).isFile()).sort();
  assert.deepEqual(Object.keys(grades.raw_hashes).sort(), rawFiles);
  for (const [file, hash] of Object.entries(grades.raw_hashes)) assert.equal(hash, sha(fs.readFileSync(path.join(s.raw, file))));
  assert.equal(grades.outcomes_hash, sha(fs.readFileSync(path.join(s.out, 'outcomes.json'))));
  assert.deepEqual(cert.fixture_results, { K: { passes: 0, total: 5, errors: 0 }, N: { passes: 5, total: 20, errors: 0 }, F: { passes: 19, total: 20, errors: 0 }, 'F-bridge': { passes: 5, total: 6, errors: 0 } });
  assert.ok(snapshot.includes(`ticket: ${path.join(s.out, 'ticket.md')}`));
  assert.ok(snapshot.includes(`harness_certificate: ${fields.harness_certificate_id}`));
  assert.deepEqual(run.stdout.trimEnd().split('\n').slice(-6), [
    `ablate grilling · haiku · case ${CASE} · rule ${frozen.rule_hash.slice(0, 8)}`,
    'K 0/5 · N 5/20 · F 19/20 · F-bridge 5/6 · P 13/20 · P−F = −6',
    'C1 PASS · C2 PASS · C3 PASS · C4 PASS · C5 PASS · C6 PASS · C7 PASS · C8 PASS',
    'verdict: REJECT (row 3: 13 <= 19-6) — body load-bearing on haiku; keep',
    'adjudicated_by: experiment-analyst (fresh context)', `record: ${s.recordPath}`,
  ]);
  assert.equal(s.outcomes().guardrailsBreached, false);
  const trace = fs.readFileSync(s.trace, 'utf8').trim().split('\n');
  assert.equal(trace.at(-1).startsWith('probe full '), true);
});

for (const [name, verdict] of [['analyst-disagree', 'MISMATCH'], ['analyst-no-verdict', 'NO-VERDICT']]) {
  test(`${name}: records ${verdict}, exits 3, never resolves automatically`, (t) => {
    const s = sandbox(t, name);
    const run = s.run();
    assert.equal(run.status, 3, run.stderr);
    assert.match(s.record(), new RegExp(`^verdict: ${verdict}$`, 'm'));
    assert.match(s.record(), /^proposed_verdict: REJECT$/m);
    assert.match(run.stdout, new RegExp(`^verdict: ${verdict} \\(row 3:`, 'm'));
    assert.equal(fs.existsSync(path.join(s.out, 'analyst.jsonl')), true);
  });
}

test('mid-run arm mutation breaches guardrails and forces row 1 despite all checks passing', (t) => {
  const s = sandbox(t, 'analyst-arm-mutation');
  const run = s.run();
  assert.equal(run.status, 1, run.stderr);
  const outcome = s.outcomes();
  const cert = JSON.parse(fs.readFileSync(path.join(s.out, 'certificate.json')));
  assert.equal(cert.status, 'invalid');
  assert.deepEqual(cert.failing_ids, ['guardrails']);
  assert.equal(outcome.guardrailsBreached, true);
  assert.deepEqual(outcome.guardrails.changed, ['arm full']);
  const result = adjudicate(outcome);
  assert.equal(result.row, 1);
  assert.equal(result.verdict, 'INVALID-HARNESS');
  assert.equal(Object.values(result.checks).every((c) => c.status === 'PASS'), true);
  assert.equal(adjudicate({ ...outcome, guardrailsBreached: false, guardrails: { breached: false } }).row, 3);
  assert.match(s.record(), /^matched_row: 1$/m);
  assert.match(s.record(), /^verdict: INVALID-HARNESS$/m);
});

test('guardrail recheck binds rule, case files, command and every arm, including missing files', (t) => {
  const s = sandbox(t, 'analyst-agree');
  assert.equal(s.run().status, 0);
  const frozen = s.frozen();
  assert.deepEqual(recheckGuardrails(frozen), { breached: false, changed: [] });
  const targets = [frozen.rule_path, ...Object.keys(frozen.case_files).map((d) => path.join(d, 'case.yaml')),
    ...Object.values(frozen.arms).map((a) => path.join(a.dir, '.claude-plugin/plugin.json')),
    ...fs.readdirSync(path.dirname(frozen.command_path)).filter((f) => f.endsWith('.js')).map((f) => path.join(path.dirname(frozen.command_path), f))];
  for (const file of targets) {
    const bytes = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, '\nmutation\n');
      assert.equal(recheckGuardrails(frozen).breached, true, file);
      fs.unlinkSync(file);
      assert.equal(recheckGuardrails(frozen).breached, true, `missing ${file}`);
    } finally { fs.writeFileSync(file, bytes); }
    assert.equal(recheckGuardrails(frozen).breached, false, `restored ${file}`);
  }
  const newCommand = path.join(path.dirname(frozen.command_path), 'additional.js');
  fs.writeFileSync(newCommand, 'new command file');
  assert.ok(recheckGuardrails(frozen).changed.includes('command'));
});

test('command_hash includes every sorted ablate JavaScript file automatically', (t) => {
  const s = sandbox(t, 'analyst-agree');
  const dir = path.join(s.root, 'maintainer/ablate');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.includes('analyst.js'));
  assert.ok(files.includes('sequence.js'));
  const expected = sha(files.map((f) => `${sha(fs.readFileSync(path.join(dir, f)))}  ${f}\n`).join(''));
  assert.equal(commandHash(dir), expected);
  for (const f of files) {
    const file = path.join(dir, f), bytes = fs.readFileSync(file);
    fs.appendFileSync(file, '\nmutation\n');
    assert.notEqual(commandHash(dir), expected, f);
    fs.writeFileSync(file, bytes);
  }
});

for (const name of ['k-fail', 'f-stage1-15']) {
  test(`early stop ${name} still invokes the analyst and finalizes all AC7 fields`, (t) => {
    const s = sandbox(t, name);
    assert.equal(s.run().status, 1);
    const cert = JSON.parse(fs.readFileSync(path.join(s.out, 'certificate.json')));
    assert.equal(cert.status, 'invalid');
    assert.ok(cert.failing_ids.includes(name === 'k-fail' ? 'C1' : 'C2'));
    assert.match(s.record(), /^verdict: INVALID-HARNESS$/m);
    assert.match(s.record(), /^matched_row: 1$/m);
    assert.match(s.record(), /^adjudicated_by: rstaff-ai:experiment-analyst$/m);
    assert.ok(fs.existsSync(s.argvLog));
    for (let i = 1; i <= 8; i++) assert.match(s.record(), new RegExp(`^C${i} (PASS|FAIL|N/A) · .*\\d`, 'm'));
  });
}

test('new analyst code, test and scenarios are registered for public release', () => {
  const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'maintainer/inventory.json')));
  const allow = fs.readFileSync(path.join(ROOT, 'maintainer/public-tree.allow'), 'utf8').split('\n');
  const files = ['maintainer/ablate/analyst.js', 'test/maintainer/ablate-analyst.test.js',
    ...fs.readdirSync(path.join(ROOT, 'test/fixtures/ablate/scenarios')).filter((f) => f.startsWith('analyst-'))
      .map((f) => `test/fixtures/ablate/scenarios/${f}`)];
  assert.equal(files.length, 6);
  for (const file of files) {
    assert.equal(allow.includes(`# ${file}`), true, `registered ${file}`);
    assert.equal(allow.some((entry) => entry.endsWith('/') && !entry.startsWith('!') && file.startsWith(entry)), true, `included ${file}`);
    assert.equal([...inv.entries.map((e) => e.to), ...inv.public_tests].filter((f) => f === file).length, 1, file);
  }
});

for (const [text, verdict] of [
  ['##   Experiment verdict: ACCEPT\nverdict: REJECT', 'REJECT'],
  ['verdict: ACCEPT\n## Experiment verdict: REJECT', 'REJECT'],
  ['## Experiment verdict: REJECTED\nquoted verdict: ACCEPT', 'NO-VERDICT'],
]) {
  test(`analyst parser accepts both forms, last match wins: ${JSON.stringify(text)}`, t => {
    const s = sandbox(t, 'analyst-agree');
    const file = path.join(s.root, 'scenario.json');
    const scenario = JSON.parse(fs.readFileSync(file));
    scenario.analyst.text = text;
    fs.writeFileSync(file, JSON.stringify(scenario));
    assert.equal(s.run().status, verdict === 'NO-VERDICT' ? 3 : 0);
    assert.match(s.record(), new RegExp(`^verdict: ${verdict}$`, 'm'));
  });
}

test('certificate validity requires every C1-C7 and guardrails, independent of C8', t => {
  const { writeCertificate } = require('../../maintainer/ablate/ticket.js');
  const s = sandbox(t, 'analyst-agree');
  assert.equal(s.run().status, 0);
  const outcome = s.outcomes(), frozen = s.frozen();
  const result = adjudicate(outcome);
  const registration = { certificatePath: path.join(s.out, 'certificate.json'), registrationHash: outcome.registration_hash };
  for (const id of Object.keys(result.checks)) {
    const changed = { ...result, checks: { ...result.checks, [id]: { status: 'FAIL', detail: 'mutation' } } };
    writeCertificate(s.out, frozen, registration, outcome, changed);
    const cert = JSON.parse(fs.readFileSync(registration.certificatePath));
    assert.equal(cert.status, id === 'C8' ? 'valid' : 'invalid', id);
    assert.deepEqual(cert.failing_ids, id === 'C8' ? [] : [id]);
  }
});
