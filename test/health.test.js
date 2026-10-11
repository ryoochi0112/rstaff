'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const D = require('../plugins/rstaff-delegation/scripts/delegate.js');
const {
  checkNode,
  checkGeminiProject,
  checkGeminiCli,
  checkGeminiAdc,
  checkPluginLoads,
} = require('../plugins/rstaff/scripts/health.js');

test('gemini project check warns with the project setup fix when unset', () => {
  const result = checkGeminiProject({});
  assert.equal(result.status, 'WARN');
  assert.equal(result.note, 'unavailable — FIX: set RSTAFF_GEMINI_PROJECT (or export GOOGLE_CLOUD_PROJECT)');
});

test('gemini project check accepts either configured project variable', () => {
  assert.equal(checkGeminiProject({ RSTAFF_GEMINI_PROJECT: 'rstaff-project' }).status, 'PASS');
  assert.equal(checkGeminiProject({ GOOGLE_CLOUD_PROJECT: 'inherited-project' }).status, 'PASS');
});

test('gemini CLI check PASSes and reports the installed version', () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, args]);
    return calls.length === 1
      ? { status: 0, stdout: '/opt/homebrew/bin/gemini\n', stderr: '' }
      : { status: 0, stdout: '0.58.0\n', stderr: '' };
  };
  const result = checkGeminiCli(spawn);
  assert.equal(result.status, 'PASS');
  assert.match(result.note, /0\.58\.0/);
  assert.ok(result.note.includes(D.GEMINI_DEFAULT_MODEL));
  assert.deepEqual(calls, [
    ['sh', ['-c', 'command -v gemini']],
    ['gemini', ['--version']],
  ]);
});

test('gemini CLI check WARNs with the exact install fix when absent', () => {
  const result = checkGeminiCli(() => ({ status: 1, stdout: '', stderr: '' }));
  assert.equal(result.status, 'WARN');
  assert.equal(result.note, 'unavailable — FIX: npm i -g @google/gemini-cli');
});

test('gemini ADC check PASSes using CLOUDSDK_CONFIG and canonical gcloud first', () => {
  const calls = [];
  const home = path.join(os.tmpdir(), 'rstaff-health-test-home');
  const env = { CLOUDSDK_CONFIG: '/tmp/operator-gcloud' };
  const result = withHome(home, () => checkGeminiAdc((cmd, args, options) => {
    calls.push([cmd, args, options.env]);
    return { status: 0, stdout: 'token\n', stderr: '' };
  }, env));
  assert.equal(result.status, 'PASS');
  assert.deepEqual(calls, [[
    path.join(home, 'google-cloud-sdk', 'bin', 'gcloud'),
    ['auth', 'application-default', 'print-access-token'],
    env,
  ]]);
});

test('gemini ADC check falls back to PATH and WARNs with the exact login fix', () => {
  const calls = [];
  const home = path.join(os.tmpdir(), 'rstaff-health-test-home');
  const result = withHome(home, () => checkGeminiAdc((cmd) => {
    calls.push(cmd);
    if (calls.length === 1) return { status: 1, stdout: '', stderr: 'canonical auth failed' };
    return { status: 1, stdout: '', stderr: 'not logged in' };
  }, { CLOUDSDK_CONFIG: '/tmp/operator-gcloud' }));
  assert.deepEqual(calls, [path.join(home, 'google-cloud-sdk', 'bin', 'gcloud'), 'gcloud']);
  assert.equal(result.status, 'WARN');
  assert.equal(result.note, 'unavailable via gcloud — FIX: gcloud auth application-default login');
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

function withHome(home, fn) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

test('health plugin loads PASS for loaded plugins and ignore other marketplaces', () => {
  const result = checkPluginLoads((cmd, args) => {
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, ['plugin', 'list', '--json']);
    return { status: 0, stdout: JSON.stringify([
      { id: 'rstaff@rstaff', enabled: true },
      { id: 'rstaff-engineer@rstaff', loaded: true },
      { id: 'rstaff-ai@other', errors: ['broken'] },
      { id: 'other@rstaff', loaded: false },
      { id: 'rstaff-backlog@rstaff', enabled: false },
    ]) };
  });
  assert.equal(result.status, 'PASS');
  assert.match(result.note, /3 installed rstaff plugin/);
});

test('health plugin loads WARN with the failed plugin and marketplace fix', () => {
  for (const failure of [{ errors: ['Dependency not installed'] }, { loaded: false },
    { status: 'failed to load' }, { status: 'not loaded' }]) {
    for (const wrapped of [false, true]) {
      const plugins = [{ id: 'rstaff@rstaff', enabled: true },
        { id: 'rstaff-engineer@rstaff', enabled: true, ...failure }];
      const result = checkPluginLoads(() => ({ status: 0,
        stdout: JSON.stringify(wrapped ? { plugins } : plugins) }));
      assert.equal(result.status, 'WARN', JSON.stringify(failure));
      assert.equal(result.note, 'rstaff-engineer@rstaff failed to load — FIX: claude plugin marketplace add obra/superpowers-marketplace');
    }
  }
});

test('health plugin loads INFO skip when claude is absent or output is unknown', () => {
  const absent = checkPluginLoads(() => ({ status: null, error: { code: 'ENOENT' } }));
  assert.equal(absent.status, 'INFO');
  assert.match(absent.note, /claude unavailable.*skipping/);
  const thrown = checkPluginLoads(() => { throw new Error('unavailable'); });
  assert.equal(thrown.status, 'INFO');
  for (const stdout of ['not JSON', 'null', '{}', '{"plugins":{}}', '[null]', '[{"id":42}]']) {
    const result = checkPluginLoads(() => ({ status: 0, stdout }));
    assert.equal(result.status, 'INFO', stdout);
    assert.match(result.note, /skipping plugin load checks/);
  }
});

test('health static is green with only core and never invokes claude', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-health-core-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const core = path.join(temp, 'plugins', 'rstaff');
  fs.cpSync(path.join(ROOT, 'plugins', 'rstaff'), core, { recursive: true });
  const probe = path.join(temp, 'probe.cjs');
  const log = path.join(temp, 'claude-calls');
  fs.writeFileSync(log, '');
  fs.writeFileSync(probe, `const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = (cmd, ...args) => {
  if (cmd === 'claude') require('node:fs').appendFileSync(${JSON.stringify(log)}, cmd);
  return original(cmd, ...args);
};
`);
  const result = spawnSync(process.execPath, ['--require', probe, path.join(core, 'scripts', 'health.js'), '--static', '--json'], {
    cwd: temp, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', HOME: temp,
      RSTAFF_HOME: '', CLAUDE_CONFIG_DIR: path.join(temp, 'empty-config') },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.summary, 'all green');
  assert.ok(report.results.every(row => row.status !== 'FAIL'));
  for (const check of ['delegation', 'backlog', 'usage', 'control repo layout']) {
    const row = report.results.find(row => row.check === check);
    assert.equal(row?.status, 'INFO', check);
    assert.match(row.note, /skipping/);
  }
  assert.equal(fs.readFileSync(log, 'utf8'), '');
});


test('health static checks the repo marketplace without a control repo and retains the home fallback', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-health-marketplace-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  for (const plugin of ['rstaff', 'rstaff-usage']) {
    fs.cpSync(path.join(ROOT, 'plugins', plugin), path.join(repo, 'plugins', plugin), { recursive: true });
  }
  const marketplace = path.join(repo, '.claude-plugin', 'marketplace.json');
  fs.mkdirSync(path.dirname(marketplace), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), marketplace);
  const env = { ...process.env, NODE_OPTIONS: '', HOME: temp,
    CLAUDE_CONFIG_DIR: path.join(temp, 'empty-config') };
  delete env.RSTAFF_HOME;
  assert.equal(fs.existsSync(path.join(repo, 'rstaff.json')), false);
  const health = () => spawnSync(process.execPath,
    [path.join(repo, 'plugins', 'rstaff', 'scripts', 'health.js'), '--static', '--json'],
    { cwd: temp, encoding: 'utf8', env });
  const manifests = result => JSON.parse(result.stdout).results.find(row => row.check === 'manifests + hook syntax');
  const standalone = health();
  assert.equal(standalone.status, 0, standalone.stdout + standalone.stderr);
  assert.equal(manifests(standalone).status, 'PASS');
  assert.match(manifests(standalone).note, /^5 manifests, /);

  const fallback = path.join(temp, 'control');
  fs.mkdirSync(path.join(fallback, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(fallback, 'rstaff.json'), '{}');
  const fallbackMarketplace = path.join(fallback, '.claude-plugin', 'marketplace.json');
  fs.writeFileSync(fallbackMarketplace, 'invalid JSON');
  env.RSTAFF_HOME = fallback;
  const preferred = health();
  assert.equal(preferred.status, 0, preferred.stdout + preferred.stderr);
  assert.match(manifests(preferred).note, /^5 manifests, /);

  fs.renameSync(marketplace, fallbackMarketplace);
  const installed = health();
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(manifests(installed).status, 'PASS');
  assert.match(manifests(installed).note, /^5 manifests, /);
});

test('health full reports plugin load failures and omits the superpowers presence check', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-health-full-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const core = path.join(temp, 'plugins', 'rstaff');
  fs.cpSync(path.join(ROOT, 'plugins', 'rstaff'), core, { recursive: true });
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}
console.log(JSON.stringify([{ id: 'rstaff@rstaff', enabled: true },
  { id: 'rstaff-ai@rstaff', enabled: true, errors: ['Dependency not installed'] }]));
`);
  fs.chmodSync(cli, 0o755);
  const result = spawnSync(process.execPath, [path.join(core, 'scripts', 'health.js'), '--json'], {
    cwd: temp, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', HOME: temp,
      RSTAFF_HOME: '', CLAUDE_CONFIG_DIR: path.join(temp, 'config'), PATH: bin + ':/bin' },
  });
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  const loads = report.results.find(row => row.check === 'rstaff plugin loads');
  assert.equal(loads?.status, 'WARN');
  assert.match(loads.note, /rstaff-ai@rstaff.*claude plugin marketplace add obra\/superpowers-marketplace/);
  assert.ok(report.results.every(row => !row.check.includes('superpowers')));
  assert.ok(report.results.every(row => !['gh auth', 'codex CLI'].includes(row.check)));
});

test('node check: floor is 22.5 (nbgate .rstaff-nbignore matcher)', () => {
  assert.equal(checkNode('v22.4.0').status, 'FAIL');
  assert.equal(checkNode('v22.5.0').status, 'PASS');
  assert.equal(checkNode('v18.20.0').status, 'FAIL');
  assert.equal(checkNode('v26.7.0').status, 'PASS');
  assert.equal(checkNode('v23.0.0').status, 'PASS');
  assert.equal(checkNode('v22.4.0').note, "found v22.4.0 — upgrade node (nbgate's .rstaff-nbignore matcher needs 22.5)");
});
