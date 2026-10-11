'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE = process.env.RSTAFF_CORE_ROOT || path.resolve(__dirname, '../../plugins/rstaff');
const SCRIPT = path.join(CORE, 'scripts/nbgate.js');
const { listNotebooks, checkCounts } = require(SCRIPT);
const GIT_CONFIG = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };

const code = (n, src = 'x = 1') => ({ cell_type: 'code', execution_count: n, source: [src], outputs: [], metadata: {} });
const nb = (...cells) => ({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });

function root(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-nbgate-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function repo(t, files = {}) {
  const base = root(t);
  const top = path.join(base, 'repo');
  fs.mkdirSync(top);
  spawnSync('git', ['init', '-q'], { cwd: top, env: { ...process.env, ...GIT_CONFIG } });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(top, f)), { recursive: true });
    fs.writeFileSync(path.join(top, f), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { base, top };
}
function stub(base, body = '') {
  const file = path.join(base, 'stubpy');
  fs.writeFileSync(file, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '-c') process.exit(process.env.STUB_PREFLIGHT_FAIL ? 1 : 0);
${body}
const target = a[a.length - 1];
if (target.includes('bad')) { console.error('Traceback...\\nNameError: name \\'x\\' is not defined'); process.exit(1); }
process.exit(0);
`, { mode: 0o755 });
  return file;
}
function run(top, py, extra = {}) {
  const config = path.join(path.dirname(top), 'claude-config');
  fs.mkdirSync(config, { recursive: true });
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: top, encoding: 'utf8',
    env: { ...process.env, ...GIT_CONFIG, CLAUDE_CONFIG_DIR: config, RSTAFF_NBGATE_PYTHON: py, ...extra },
  });
}
const status = (top) => spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: top, encoding: 'utf8', env: { ...process.env, ...GIT_CONFIG } }).stdout;

test('checkCounts accepts 1..n and skips blank code and markdown cells', () => {
  const md = { cell_type: 'markdown', source: ['hi'] };
  assert.deepEqual(checkCounts(nb(code(1), md, code(null, '  \n'), code(2))), { ok: true });
});
test('checkCounts rejects a gap, out of order, and null', () => {
  assert.deepEqual(checkCounts(nb(code(1), code(3))), { ok: false, reason: 'cell 2 has 3, expected 2' });
  assert.deepEqual(checkCounts(nb(code(2), code(1))), { ok: false, reason: 'cell 1 has 2, expected 1' });
  assert.deepEqual(checkCounts(nb(code(1), code(null))),
    { ok: false, reason: 'cell 2 never run; Restart & Run All, then save' });
});

test('listNotebooks: untracked in, gitignored/checkpoints/nbignore out, sorted', (t) => {
  const { top } = repo(t, {
    'b.ipynb': nb(), 'a/x.ipynb': nb(), 'ign.ipynb': nb(), 'skip/s.ipynb': nb(),
    '.ipynb_checkpoints/c.ipynb': nb(), 'sub/.ipynb_checkpoints/d.ipynb': nb(),
    '.gitignore': 'ign.ipynb\n', '.rstaff-nbignore': '# c\n\nskip/*.ipynb\n', 'notes.txt': 'x',
  });
  assert.deepEqual(listNotebooks(top), ['a/x.ipynb', 'b.ipynb']);
  assert.deepEqual(listNotebooks(top, { ignoreFile: false }), ['a/x.ipynb', 'b.ipynb', 'skip/s.ipynb']);
});

test('zero notebooks is green', (t) => {
  const { base, top } = repo(t, { 'a.txt': 'x' });
  const r = run(top, stub(base));
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'nbgate: 0 notebooks');
});

test('not a git repo exits 2', (t) => {
  const base = root(t);
  const r = run(base, stub(base));
  assert.equal(r.status, 2);
});

test('preflight failure exits 2 with the pip line', (t) => {
  const { base, top } = repo(t, { 'a.ipynb': nb(code(1)) });
  const r = run(top, stub(base), { STUB_PREFLIGHT_FAIL: '1' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pip install nbconvert ipykernel/);
});

test('one bad and one good: exit 1, both reported, golden shape', (t) => {
  const { base, top } = repo(t, {
    'good.ipynb': nb(code(1), code(2)), 'bad.ipynb': nb(code(1), code(3)), '.rstaff-nbignore': 'skipme.ipynb\n', 'skipme.ipynb': nb(),
  });
  const r = run(top, stub(base));
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'nbgate: 2 notebooks (1 skipped by .rstaff-nbignore)');
  assert.match(lines[1], /^ {2}bad\.ipynb {4}counts: cell 2 has 3, expected 2 · fresh run: NameError: name 'x' is not defined$/);
  assert.match(lines[2], /^ {2}good\.ipynb {3}counts ok · fresh run ok$/);
  assert.equal(lines[3], 'nbgate: RED (1 of 2 notebooks)');
});

test('all green exits 0; invalid JSON is red but others still run', (t) => {
  const { base, top } = repo(t, { 'good.ipynb': nb(code(1)) });
  assert.equal(run(top, stub(base)).status, 0);
  fs.writeFileSync(path.join(top, 'junk.ipynb'), '{nope');
  const r = run(top, stub(base));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /junk\.ipynb\s+counts: invalid notebook JSON/);
  assert.match(r.stdout, /good\.ipynb\s+counts ok · fresh run ok/);
});

test('tree is unchanged by a notebook that writes a file; tmp copy is removed', (t) => {
  const { base, top } = repo(t, { 'good.ipynb': nb(code(1)), 'data.csv': 'a,b\n' });
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(tmpRoot);
  const py = stub(base, `require('node:fs').writeFileSync('derived.csv', 'x');
require('node:fs').writeFileSync(process.env.STUB_MARK, process.cwd());`);
  const mark = path.join(base, 'mark');
  const before = status(top);
  const r = run(top, py, { TMPDIR: tmpRoot, STUB_MARK: mark });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(status(top), before);
  assert.ok(!fs.existsSync(path.join(top, 'derived.csv')));
  const cwd = fs.readFileSync(mark, 'utf8');
  assert.ok(cwd.includes('rstaff-nbgate-') && !cwd.startsWith(top));
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test('ANSI-coloured error line is matched and printed without escape codes', (t) => {
  const { base, top } = repo(t, { 'a.ipynb': nb(code(1)) });
  const py = stub(base, `console.error('nbclient.exceptions.CellExecutionError: An error occurred while executing the following cell:');
console.error('\\x1b[0;31mTraceback\\x1b[0m');
console.error("\\x1b[31mNameError\\x1b[0m: name 'x' is not defined");
console.error('');
process.exit(1);`);
  const r = run(top, py);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /fresh run: NameError: name 'x' is not defined\n/);
  assert.ok(!r.stdout.includes('\x1b'));
});

function commitAll(top) {
  const env = { ...process.env, ...GIT_CONFIG };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: top, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
}

test('a tracked notebook deleted from the working tree is absent from the set (no missing-file read)', (t) => {
  const { base, top } = repo(t, { 'a.ipynb': nb(code(1)) });
  commitAll(top);
  fs.rmSync(path.join(top, 'a.ipynb'));
  assert.deepEqual(listNotebooks(top), []);
  const r = run(top, stub(base));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'nbgate: 0 notebooks');
});

test('a nested git repo directory entry is skipped by the copy, never exit 2', (t) => {
  const { base, top } = repo(t, { 'good.ipynb': nb(code(1)) });
  const sub = path.join(top, 'sub');
  fs.mkdirSync(sub);
  spawnSync('git', ['init', '-q'], { cwd: sub, env: { ...process.env, ...GIT_CONFIG } });
  fs.writeFileSync(path.join(sub, 'f.txt'), 'x');
  const mark = path.join(base, 'mark');
  const py = stub(base, `require('node:fs').writeFileSync(process.env.STUB_MARK, require('node:fs').readdirSync('.').join(','));`);
  const r = run(top, py, { STUB_MARK: mark });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /nbgate: GREEN/);
  assert.equal(fs.readFileSync(mark, 'utf8'), 'good.ipynb');
});

test('without path.matchesGlob a non-empty .rstaff-nbignore exits 2 with the node floor line', (t) => {
  const { base, top } = repo(t, { 'a.ipynb': nb(code(1)), '.rstaff-nbignore': 'skip/*.ipynb\n' });
  const shim = path.join(base, 'shim.js');
  fs.writeFileSync(shim, "require('node:path').matchesGlob = undefined;\n");
  const config = path.join(base, 'claude-config');
  fs.mkdirSync(config, { recursive: true });
  const env = { ...process.env, ...GIT_CONFIG, CLAUDE_CONFIG_DIR: config, RSTAFF_NBGATE_PYTHON: stub(base) };
  const go = () => spawnSync(process.execPath, ['--require', shim, SCRIPT], { cwd: top, encoding: 'utf8', env });
  const r = go();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^nbgate: node >= 22\.5 required \(found v\d+\.\d+\.\d+\)$/m);
  fs.writeFileSync(path.join(top, '.rstaff-nbignore'), '# only a comment\n');
  const ok = go();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});
