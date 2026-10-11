'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const SAMPLE = path.resolve(__dirname, '../../plugins/rstaff-ai/samples/label-task');
const golden = 'certify: grader exact-match  known-pass 12/12  known-fail caught 12/12  → valid';
const readRows = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const hash = file => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;

function copy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-certify-'));
  fs.cpSync(SAMPLE, dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, args) {
  return spawnSync(process.execPath, [path.join(dir, 'certify.js'), ...args], {
    cwd: os.tmpdir(), encoding: 'utf8',
  });
}

test('fixtures cover every confirm case with exact passes and all four realistic miss types', () => {
  const cases = readRows(path.join(SAMPLE, 'cases.jsonl')).filter(row => row.split === 'confirm');
  for (const name of ['known-pass', 'known-fail']) {
    const rows = readRows(path.join(SAMPLE, 'fixtures', `${name}.jsonl`));
    assert.equal(rows.length, 12);
    assert.deepEqual(rows.map(row => row.id).sort(), cases.map(row => row.id).sort());
    for (let i = 0; i < rows.length; i += 1) {
      const label = cases.find(row => row.id === rows[i].id).label;
      assert.equal(rows[i].arm, 'candidate');
      assert.equal(rows[i].reply, name === 'known-pass' ? label : [
        `${label.slice(0, -1)}x`, label[0].toUpperCase() + label.slice(1),
        `${label}.`, `The sentiment is ${label}.`,
      ][i % 4]);
    }
  }
});

test('certification writes golden summary, schema sections, fixture results and actual file hashes', t => {
  const dir = copy(t);
  const grader = path.join(dir, 'grade.js');
  fs.appendFileSync(grader, `
const originalGradeFile = module.exports.gradeFile;
module.exports.gradeFile = options => {
  require('node:assert/strict').equal(options.casesPath, require('node:path').join(__dirname, 'cases.jsonl'));
  require('node:assert/strict').equal(options.split, 'confirm');
  return originalGradeFile(options);
};
`);
  const out = path.join(dir, 'cert.md');
  const result = run(dir, ['--out', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n')[0], golden);
  const cert = fs.readFileSync(out, 'utf8');
  assert.match(cert, /^status: valid$/m);
  const timestamp = cert.match(/^certified_at: (.+)$/m)[1];
  assert.equal(new Date(timestamp).toISOString(), timestamp);
  assert.match(cert, /^certified_by: certify.js$/m);
  assert.ok(cert.includes(`cases_manifest_hash: ${hash(path.join(dir, 'cases.jsonl'))}`));
  assert.ok(cert.includes(`graders:\n  - name: exact-match\n    impl_hash: ${hash(path.join(dir, 'grade.js'))}`));
  assert.ok(cert.includes(`runtime_hash: ${hash(path.join(dir, 'run.js'))}`));
  assert.match(cert, /^judge: none \(code grader\)$/m);
  for (const section of ['1. Bound hashes', '2. Fixtures that passed', '3. Judge calibration + bias audit',
    '4. Environment reset / isolation', '5. Invalidation triggers', '6. Scope']) {
    assert.ok(cert.includes(`## ${section}`), section);
  }
  assert.equal((cert.match(/result: pass\n/g) || []).length, 12);
  assert.equal((cert.match(/result: caught\n/g) || []).length, 12);
  assert.equal((cert.match(/expected: fail\n    observed: fail/g) || []).length, 12);
  for (const id of readRows(path.join(dir, 'fixtures/known-pass.jsonl')).map(row => row.id)) {
    assert.ok(cert.includes(`id: ${id}\n    result: pass`));
    assert.ok(cert.includes(`id: ${id}\n    result: caught`));
  }
  fs.rmSync(path.join(dir, 'run.js'));
  const second = run(dir, ['--out', out]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /^runtime_hash: missing$/m);
});

test('a replaced always-pass or always-fail grader invalidates and still writes the certificate', t => {
  const dir = copy(t);
  const grader = path.join(dir, 'grade.js');
  const original = fs.readFileSync(grader, 'utf8');
  for (const score of [1, 0]) {
    fs.writeFileSync(grader, original.replace('return reply === label ? 1 : 0;', `return ${score};`));
    const out = path.join(dir, 'cert.md');
    const result = run(dir, ['--out', out]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, score === 1 ? /known-fail caught 0\/12/ : /known-pass 0\/12/);
    const cert = fs.readFileSync(out, 'utf8');
    assert.match(cert, /^status: invalidated$/m);
    assert.ok(cert.includes(`impl_hash: ${hash(grader)}`));
    assert.equal((cert.match(score === 1 ? /result: missed\n/g : /result: fail\n/g) || []).length, 12);
    if (score === 1) assert.equal((cert.match(/observed: pass/g) || []).length, 12);
  }
});

test('sample npm verify uses --check and writes no certificate', t => {
  const dir = copy(t);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), {
    name: 'label-task', private: true, scripts: { verify: 'node certify.js --check' },
  });
  const before = fs.readdirSync(dir).sort();
  const result = spawnSync('npm', ['run', 'verify'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(golden));
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  const grader = path.join(dir, 'grade.js');
  fs.writeFileSync(grader, fs.readFileSync(grader, 'utf8').replace('return reply === label ? 1 : 0;', 'return 1;'));
  const invalid = spawnSync('npm', ['run', 'verify'], { cwd: dir, encoding: 'utf8' });
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stdout, /known-fail caught 0\/12/);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('bad CLI arguments, missing files, malformed data and write errors exit 2', t => {
  const dir = copy(t);
  for (const args of [[], ['--out'], ['--out', '--check'], ['--unknown'], ['--check', '--check'],
    ['--check', '--out', 'cert.md'], ['--out', 'cert.md', 'extra'], ['--out', '']]) {
    const result = run(dir, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/);
  }
  const fixture = path.join(dir, 'fixtures/known-pass.jsonl');
  fs.writeFileSync(fixture, '{bad json\n');
  assert.equal(run(dir, ['--check']).status, 2);
  fs.rmSync(fixture);
  assert.equal(run(dir, ['--check']).status, 2);
  fs.copyFileSync(path.join(SAMPLE, 'fixtures/known-pass.jsonl'), fixture);
  const result = run(dir, ['--out', path.join(dir, 'absent/cert.md')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /certify:/);
});

test('incomplete, duplicate, unknown and non-string fixtures cannot certify', t => {
  const dir = copy(t);
  for (const name of ['known-pass', 'known-fail']) {
    const file = path.join(dir, 'fixtures', `${name}.jsonl`);
    const original = readRows(file);
    for (const rows of [original.slice(1), [...original, original[0]], [...original.slice(1), original[1]],
      original.map((row, i) => i === 0 ? { ...row, id: 'd01' } : row),
      original.map((row, i) => i === 0 ? { ...row, reply: null } : row)]) {
      fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      const result = run(dir, ['--check']);
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes(`${name} must contain one string reply per confirm case`));
    }
    fs.writeFileSync(file, original.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
});

test('confirm case count and uniqueness are required', t => {
  const dir = copy(t);
  const file = path.join(dir, 'cases.jsonl');
  const original = readRows(file);
  for (const rows of [original.slice(0, -1), [...original, original[3]], [...original.slice(0, -1), original[3]]]) {
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = run(dir, ['--check']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /twelve distinct confirm cases/);
  }
});
