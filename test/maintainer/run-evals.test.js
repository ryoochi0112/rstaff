'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const runner = require('../../maintainer/run-evals.js');

const RUNNER = path.resolve(__dirname, '../../maintainer/run-evals.js');

// Sandbox: plugins a and b own skill "foo"; c has evals but no skills; d has neither.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-runevals-'));
  const plugin = (name, { skills = [], evals = true } = {}) => {
    const dir = path.join(root, 'repo', 'plugins', name);
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, dependencies: ['rstaff'] }));
    for (const s of skills) fs.mkdirSync(path.join(dir, 'skills', s), { recursive: true });
    if (evals) fs.mkdirSync(path.join(dir, 'evals'), { recursive: true });
  };
  plugin('a', { skills: ['foo'] });
  plugin('b', { skills: ['foo', 'bar'] });
  plugin('c');
  plugin('d', { skills: ['foo'], evals: false });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'calls.jsonl');
  // Stub records argv plus the target manifest; exit code comes from STUB_EXIT.
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(argv[2] + '/.claude-plugin/plugin.json', 'utf8'));
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify({ argv, manifest }) + '\\n');
process.exit(Number(process.env.STUB_EXIT || 0));
`, { mode: 0o755 });
  const tmp = path.join(root, 'tmp');
  const out = path.join(root, 'out');
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, ARGV_LOG: log,
    RSTAFF_EVALS_TMP: tmp, RSTAFF_EVALS_OUT: out,
  };
  const run = (args, extra = {}) => spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: path.join(root, 'repo'), env: { ...env, ...extra }, encoding: 'utf8',
  });
  const calls = () => (fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { root, repo: path.join(root, 'repo'), tmp, out, run, calls };
}

test('owner selection: sorted owners with skill + evals; none -> exit 1', () => {
  const f = fixture();
  const r = f.run(['--skill', 'foo']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => path.basename(c.argv[2])), ['a', 'b']);
  const bar = fixture();
  assert.equal(bar.run(['--skill', 'bar']).status, 0);
  assert.deepEqual(bar.calls().map((c) => path.basename(c.argv[2])), ['b']);
  const none = fixture();
  const miss = none.run(['--skill', 'nope']);
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /No eval owner for skill: nope/);
  assert.equal(none.calls().length, 0);
  const all = fixture();
  assert.equal(all.run(['--skill', '', '--case', '', '--runs', '', '--keep-temp', '']).status, 0);
  assert.deepEqual(all.calls().map((c) => path.basename(c.argv[2])), ['a', 'b', 'c']);
});

test('argument validation exits 2 without running the CLI', () => {
  const f = fixture();
  assert.equal(f.run(['--case', 'x-*']).status, 2);
  for (const bad of ['0', '-1', 'abc', '1.5', '2x']) {
    assert.equal(f.run(['--skill', 'foo', '--runs', bad]).status, 2, bad);
  }
  assert.equal(f.calls().length, 0);
});

test('argv to the CLI is exact; case default and override; runs; keep-temp', () => {
  const f = fixture();
  const r = f.run(['--skill', 'bar']);
  assert.equal(r.status, 0, r.stderr);
  const [call] = f.calls();
  const target = call.argv[2];
  assert.ok(target.startsWith(f.tmp + path.sep));
  assert.equal(path.basename(target), 'b');
  const outDir = call.argv[call.argv.indexOf('--output-dir') + 1];
  assert.match(outDir, new RegExp(`^${f.out}/b/\\d{8}T\\d{6}Z/$`));
  assert.deepEqual(call.argv, ['plugin', 'eval', target, '--ablation', 'none', '--no-publish',
    '--trust-plugin', '--threshold', '0.6', '--case', 'bar-*',
    '--output-dir', outDir, '--report', `${outDir}report.html`]);

  const g = fixture();
  g.run(['--skill', 'bar', '--case', 'bar-trigger-01', '--runs', '3', '--keep-temp', '1']);
  const a = g.calls()[0].argv;
  assert.deepEqual(a.slice(9, 14), ['--case', 'bar-trigger-01', '--runs', '3', '--keep-temp']);
  assert.equal(a[14], '--output-dir');

  const s = fixture();
  s.run([]);
  assert.ok(!s.calls()[0].argv.includes('--case'));
});

test('stub sees a copy under the copy root with dependencies stripped; source untouched', () => {
  const f = fixture();
  f.run(['--skill', 'foo']);
  for (const c of f.calls()) {
    assert.ok(path.resolve(c.argv[2]).startsWith(f.tmp + path.sep));
    assert.equal('dependencies' in c.manifest, false);
  }
  const src = JSON.parse(fs.readFileSync(path.join(f.repo, 'plugins/a/.claude-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(src.dependencies, ['rstaff']);
});

test('prints copy root and results dir; nothing under plugins/*/evals/results', () => {
  const f = fixture();
  const r = f.run(['--skill', 'foo']);
  assert.ok(r.stdout.includes(`eval copy root: ${f.tmp}\n`));
  for (const p of ['a', 'b']) {
    const m = r.stdout.match(new RegExp(`eval results: (${f.out}/${p}/\\d{8}T\\d{6}Z)\\n`));
    assert.ok(m, r.stdout);
    assert.ok(fs.statSync(m[1]).isDirectory());
  }
  assert.deepEqual(fs.globSync('plugins/*/evals/results', { cwd: f.repo }), []);
});

test('same-second results dirs get -2, -3 suffixes', () => {
  const f = fixture();
  const RealDate = Date;
  const fixed = new RealDate('2026-01-02T03:04:05.678Z');
  global.Date = class extends RealDate { constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); } };
  const cwd = process.cwd();
  const log = console.log;
  const printed = [];
  try {
    process.chdir(f.repo);
    console.log = (m) => printed.push(m);
    const env = { ...process.env, PATH: `${path.join(f.root, 'bin')}:${process.env.PATH}`, ARGV_LOG: path.join(f.root, 'calls.jsonl'), RSTAFF_EVALS_TMP: f.tmp, RSTAFF_EVALS_OUT: f.out };
    for (let i = 0; i < 3; i++) assert.equal(runner.main(['--skill', 'bar'], env), 0);
  } finally { global.Date = RealDate; console.log = log; process.chdir(cwd); }
  const dirs = printed.filter((l) => l.startsWith('eval results: ')).map((l) => path.basename(l));
  assert.deepEqual(dirs, ['20260102T030405Z', '20260102T030405Z-2', '20260102T030405Z-3']);
});

test('CLI failure code propagates and later plugins do not run', () => {
  const f = fixture();
  const r = f.run(['--skill', 'foo'], { STUB_EXIT: '7' });
  assert.equal(r.status, 7);
  assert.equal(f.calls().length, 1);
  const ok = fixture();
  assert.equal(ok.run([], { STUB_EXIT: '0' }).status, 0);
  assert.equal(ok.calls().length, 3);
});

test('copy root is empty after exit 0 and exit 1; kept with --keep-temp', () => {
  for (const code of ['0', '1']) {
    const f = fixture();
    assert.equal(f.run(['--skill', 'foo'], { STUB_EXIT: code }).status, Number(code));
    assert.deepEqual(fs.readdirSync(f.tmp), [], `exit ${code}`);
  }
  const k = fixture();
  const r = k.run(['--skill', 'bar', '--keep-temp', '1']);
  const m = r.stdout.match(/eval copy kept: (\S+)\n/);
  assert.ok(m, r.stdout);
  assert.equal(fs.globSync('copy-*/b/.claude-plugin/plugin.json', { cwd: m[1] }).length, 1);
  assert.ok(m[1].startsWith(k.tmp + path.sep));
});

test('a build that throws after mkdtemp does not leak a copy root', () => {
  const f = fixture();
  fs.rmSync(path.join(f.repo, 'plugins/a/.claude-plugin/plugin.json'));
  const r = f.run(['--skill', 'foo']);
  assert.notEqual(r.status, 0);
  assert.equal(f.calls().length, 0);
  assert.deepEqual(fs.readdirSync(f.tmp), []);
});

test('signal cleanup removes the active copy and exits 128+signal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-sig-'));
  fs.writeFileSync(path.join(dir, 'x'), '1');
  runner._setActive(dir);
  runner.cleanupActive();
  assert.equal(fs.existsSync(dir), false);
  assert.equal(runner.signalExitCode('SIGINT'), 130);
  assert.equal(runner.signalExitCode('SIGTERM'), 143);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-sig-'));
  runner._setActive(dir2);
  const realExit = process.exit;
  let code;
  process.exit = (c) => { code = c; };
  try { runner.onSignal('SIGTERM'); } finally { process.exit = realExit; }
  assert.equal(code, 143);
  assert.equal(fs.existsSync(dir2), false);
});
