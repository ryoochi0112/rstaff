'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'maintainer/ablate/ablate.js');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ablate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugins/rstaff-pm');
  const put = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  put(path.join(plugin, '.claude-plugin/plugin.json'), '{"name":"rstaff-pm","dependencies":["rstaff"]}');
  put(path.join(plugin, 'skills/grilling/SKILL.md'), '---\nname: grilling\ndescription: Test\n---\n\nOriginal body.\n');
  put(path.join(plugin, 'skills/grilling/references/example.md'), 'Reference retained.\n');
  put(path.join(plugin, 'ablation/grilling/known-fail.md'), '\nKnown fail.\n');
  put(path.join(plugin, 'ablation/grilling/ablation.json'), '{"case":"one-question-before-design"}');
  put(path.join(plugin, 'evals/grilling-compliance/one-question-before-design/case.yaml'), '{"name":"grilling-compliance-one-question-before-design","execution":{"max_turns":2,"prompt":"Question"}}');
  put(path.join(root, 'maintainer/ablate/rule.md'), 'Frozen decision rule\ncap: 4\njudge: haiku\n');
  const log = path.join(root, 'calls');
  put(log, '');
  put(path.join(root, 'bin/claude'), '#!/bin/sh\nprintf "claude\\n" >> "$SHIM_LOG"\nexit 99\n');
  fs.chmodSync(path.join(root, 'bin/claude'), 0o755);
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, SHIM_LOG: log };
  const run = (args, cwd = root, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, plugin, put, log, run };
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(path.join(dir, entry.name)).map((file) => `${entry.name}/${file}`)
    : [entry.name]).sort();
}

test('four arms preserve the exact diff surface, bodies, frontmatter and patched case', (t) => {
  const { root, plugin } = sandbox(t);
  const { buildArms } = require('../../maintainer/ablate/arms.js');
  const built = buildArms('grilling', path.join(root, 'out'), { repoRoot: root });
  assert.deepEqual(Object.keys(built.arms).sort(), ['full', 'known-fail', 'null', 'placebo']);
  const full = built.arms.full.dir;
  const skill = 'skills/grilling/SKILL.md';
  const source = fs.readFileSync(path.join(plugin, skill));
  const boundary = source.indexOf(Buffer.from('---\n'), 4) + 4;
  const front = source.subarray(0, boundary);
  assert.deepEqual(fs.readFileSync(path.join(full, skill)), source);
  for (const [arm, data] of Object.entries(built.arms)) {
    const expected = files(full).filter((f) => arm !== 'null' || !f.startsWith('skills/grilling/'));
    assert.deepEqual(files(data.dir), expected);
    for (const file of expected) {
      if (file === skill && arm !== 'full') continue;
      assert.deepEqual(fs.readFileSync(path.join(data.dir, file)), fs.readFileSync(path.join(full, file)), `${arm}: ${file}`);
    }
    const caseBytes = fs.readFileSync(path.join(data.dir, 'evals/grilling-compliance/one-question-before-design/case.yaml'));
    assert.equal(JSON.parse(caseBytes).execution.max_turns, 4);
    assert.equal(built.caseHash, sha(caseBytes));
    assert.equal(data.skillMdHash, arm === 'null' ? null : sha(fs.readFileSync(path.join(data.dir, skill))));
    const hashLines = files(data.dir).map((f) => `${sha(fs.readFileSync(path.join(data.dir, f)))}  ./${f}\n`).join('');
    assert.equal(data.treeHash, sha(hashLines).slice(0, 16));
  }
  for (const [arm, body] of [['placebo', Buffer.from('This skill has no further instructions.')], ['known-fail', fs.readFileSync(path.join(plugin, 'ablation/grilling/known-fail.md'))]]) {
    const bytes = fs.readFileSync(path.join(built.arms[arm].dir, skill));
    assert.deepEqual(bytes.subarray(0, boundary), front);
    assert.deepEqual(bytes.subarray(boundary), body);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(full, '.claude-plugin/plugin.json'))).dependencies, undefined);
});

test('missing data-science fixture refuses before any claude call', (t) => {
  const { root, log, run } = sandbox(t);
  const result = run(['--skill', 'data-science', '--out', path.join(root, 'out')], ROOT);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /plugins\/rstaff-ds\/ablation\/data-science\/known-fail.md/);
  assert.equal(fs.readFileSync(log, 'utf8'), '');
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
});

test('existing output wins even over missing fixtures and never changes contents', (t) => {
  const { root, log, run, put } = sandbox(t);
  const out = path.join(root, 'out');
  put(path.join(out, 'sentinel'), 'untouched');
  const result = run(['--skill', 'missing', '--out', out]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /output.*exists/i);
  assert.equal(fs.readFileSync(path.join(out, 'sentinel'), 'utf8'), 'untouched');
  assert.equal(fs.readFileSync(log, 'utf8'), '');
});

test('existing sibling record refuses before building or spawning', (t) => {
  const { root, log, run, put } = sandbox(t);
  const out = path.join(root, 'out');
  put(`${out}.md`, 'untouched');
  const result = run(['--skill', 'grilling', '--out', out]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /output.*exists/i);
  assert.equal(fs.readFileSync(`${out}.md`, 'utf8'), 'untouched');
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.readFileSync(log, 'utf8'), '');
});

test('freeze writes every hash and trace without invoking claude', (t) => {
  const { root, log, run } = sandbox(t);
  const out = path.join(root, 'out');
  const trace = path.join(root, 'trace');
  const result = run(['--skill', 'grilling', '--out', out, '--stop-after', 'freeze'], root, { RSTAFF_ABLATE_TRACE: trace });
  assert.equal(result.status, 0, result.stderr);
  const record = fs.readFileSync(`${out}.md`, 'utf8');
  assert.ok(record.includes(sha(fs.readFileSync(path.join(root, 'maintainer/ablate/rule.md')))));
  const { treeHash } = require('../../maintainer/ablate/arms.js');
  for (const arm of ['full', 'placebo', 'null', 'known-fail']) {
    const dir = path.join(out, 'arms', arm, 'rstaff-pm');
    assert.ok(record.includes(treeHash(dir)), arm);
    if (arm !== 'null') assert.ok(record.includes(sha(fs.readFileSync(path.join(dir, 'skills/grilling/SKILL.md')))));
  }
  assert.ok(record.includes(sha(fs.readFileSync(path.join(out, 'arms/full/rstaff-pm/evals/grilling-compliance/one-question-before-design/case.yaml')))));
  assert.ok(record.includes(require('../../maintainer/ablate/ablate.js').commandHash()), 'command hash');
  assert.equal(fs.readFileSync(trace, 'utf8'), 'record-frozen\n');
  assert.equal(fs.readFileSync(log, 'utf8'), '');
});

test('invalid metadata and missing case fail preflight without output or claude', (t) => {
  const { root, plugin, put, run, log } = sandbox(t);
  const meta = path.join(plugin, 'ablation/grilling/ablation.json');
  for (const body of ['broken', '{}', '{"case":"../../escape"}', '{"case":"absent"}']) {
    put(meta, body);
    const out = path.join(root, 'out');
    const result = run(['--skill', 'grilling', '--out', out, '--stop-after', 'freeze']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(fs.existsSync(out), false);
  }
  fs.unlinkSync(meta);
  assert.match(run(['--skill', 'grilling', '--out', path.join(root, 'out')]).stderr, /ablation.json/);
  assert.equal(fs.readFileSync(log, 'utf8'), '');
});

test('grilling fixture has no native eval case and matches its designated compliance case', () => {
  const dir = path.join(ROOT, 'plugins/rstaff-pm/ablation/grilling');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ablation.json', 'known-fail.md']);
  assert.equal(fs.globSync('plugins/*/evals/**/case.yaml', { cwd: ROOT }).some((file) => file.startsWith('plugins/rstaff-pm/ablation/')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'plugins/rstaff-pm/evals/grilling-ablation')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ablation.json'))), { case: 'one-question-before-design' });
  assert.equal(sha(fs.readFileSync(path.join(dir, 'known-fail.md'))), '1fc91c8ff2db29f96f8a6c538611f6cd26d525d19e5f61b9a41cda43d92e1f1d');
  assert.match(fs.readFileSync(path.join(dir, 'known-fail.md'), 'utf8'), /Ask every open question in one message, batched together/);
});

test('make ablate quotes SKILL at both make and shell expansion stages', (t) => {
  const { root } = sandbox(t);
  const sentinel = path.join(root, 'injected');
  for (const skill of [`x'; touch ${sentinel}; :'`, `$(shell touch ${sentinel})`]) {
    const result = spawnSync('/usr/bin/make', ['-f', path.join(ROOT, 'Makefile'), 'ablate', `SKILL=${skill}`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(fs.existsSync(sentinel), false);
    assert.ok(result.stderr.includes(skill), result.stderr);
  }
});

test('resolveSkill returns the real grilling case name separately from its directory id', () => {
  const { resolveSkill } = require('../../maintainer/ablate/arms.js');
  const info = resolveSkill('grilling', ROOT);
  assert.equal(info.case, 'one-question-before-design');
  assert.equal(info.caseName, 'grilling-compliance-one-question-before-design');
});

for (const problem of ['missing name', 'invalid name', 'duplicate name']) {
  test(`designated case ${problem} exits 2 before output or spawn and names case.yaml`, (t) => {
    const { root, plugin, put, run, log } = sandbox(t);
    const casePath = path.join(plugin, 'evals/grilling-compliance/one-question-before-design/case.yaml');
    const value = JSON.parse(fs.readFileSync(casePath, 'utf8'));
    if (problem === 'missing name') delete value.name;
    if (problem === 'invalid name') value.name = 'Invalid case name';
    if (problem === 'duplicate name') {
      put(path.join(plugin, 'evals/another-suite/another-case/case.yaml'), JSON.stringify(value));
    }
    put(casePath, JSON.stringify(value));
    for (const extra of [[], ['--shakeout']]) {
      const out = path.join(root, 'out');
      const result = run(['--skill', 'grilling', '--out', out, ...extra]);
      assert.equal(result.status, 2, result.stderr);
      assert.ok(result.stderr.includes(casePath), result.stderr);
      assert.equal(fs.readFileSync(log, 'utf8'), '');
      assert.equal(fs.existsSync(out), false);
      assert.equal(fs.existsSync(`${out}-shakeout`), false);
    }
  });
}
