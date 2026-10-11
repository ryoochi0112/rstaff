'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-delegation-split-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const core = path.join(temp, 'plugins', 'rstaff');
  fs.cpSync(path.join(root, 'plugins', 'rstaff'), core, { recursive: true });
  const home = path.join(temp, 'control');
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{"rstaff":"control-repo"}');
  const env = { ...process.env, NODE_OPTIONS: '', RSTAFF_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(temp, 'empty-config'),
    RSTAFF_CODEX_HOME: path.join(temp, 'codex'), CODEX_HOME: path.join(temp, 'shared-codex') };
  delete env.RSTAFF_GEMINI_PROJECT;
  delete env.GOOGLE_CLOUD_PROJECT;
  function run(script, args = [], input) {
    return spawnSync(process.execPath, [path.join(core, script), ...args], {
      cwd: home, env, encoding: 'utf8', input,
    });
  }
  function installDelegation() {
    fs.cpSync(path.join(root, 'plugins', 'rstaff-delegation'),
      path.join(temp, 'plugins', 'rstaff-delegation'), { recursive: true });
  }
  return { temp, home, env, run, installDelegation };
}

test('health --static passes without delegation and runs its checks when located', t => {
  const f = fixture(t);
  const absent = f.run('scripts/health.js', ['--static', '--json']);
  assert.equal(absent.status, 0, absent.stderr || absent.stdout);
  assert.equal(absent.stderr, '');
  const report = JSON.parse(absent.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.summary, 'all green');
  assert.ok(report.results.some(row => row.check === 'delegation' && /not installed/.test(row.note)));
  for (const check of ['gemini project', 'gemini CLI', 'gemini ADC', 'codex tier support', 'codex default model']) {
    assert.equal(report.results.some(row => row.check === check), false, check);
  }
  f.installDelegation();
  const present = f.run('scripts/health.js', ['--static', '--json']);
  assert.equal(present.status, 0, present.stderr || present.stdout);
  const installed = JSON.parse(present.stdout);
  for (const check of ['gemini project', 'gemini CLI', 'gemini ADC', 'codex tier support', 'codex default model']) {
    assert.ok(installed.results.some(row => row.check === check), check);
  }
  assert.equal(installed.results.find(row => row.check === 'gemini project').status, 'WARN');
  assert.match(installed.results.find(row => row.check === 'gemini CLI').note, /gemini-3\.8-flash/);
  // Prove the static check invokes the located router rather than emitting a placeholder.
  fs.mkdirSync(f.env.RSTAFF_CODEX_HOME);
  fs.writeFileSync(path.join(f.env.RSTAFF_CODEX_HOME, 'models_cache.json'), JSON.stringify({
    models: [{ slug: 'gpt-6.1-sol', supported_reasoning_levels: [{ effort: 'low' }] }],
  }));
  const unsupported = f.run('scripts/health.js', ['--static', '--json']);
  assert.equal(unsupported.status, 1, unsupported.stdout);
  assert.equal(JSON.parse(unsupported.stdout).results.find(row => row.check === 'codex tier support').status, 'FAIL');
});

test('guard-bash skips the route deny without delegation and enforces it when located', t => {
  const f = fixture(t);
  const ledgerDir = path.join(f.home, 'var', 'specs', 'r');
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, 's.tasks.md'), '## T1: Unrouted\n- risk: low\n- class: logic\n- impl: -\n- reviewer: -\n');
  const event = JSON.stringify({ cwd: f.home, tool_name: 'Bash', tool_input: {
    command: 'node "$P/scripts/delegate.js" codex execute --label r/s/T1/implement',
  } });
  const absent = f.run('hooks/guard-bash.js', [], event);
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, '');
  f.installDelegation();
  const present = f.run('hooks/guard-bash.js', [], event);
  assert.equal(present.status, 0, present.stderr);
  const output = JSON.parse(present.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /unrouted writer dispatch/);
});
