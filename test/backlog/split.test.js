'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-split-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const core = path.join(temp, 'plugins', 'rstaff');
  fs.cpSync(path.join(root, 'plugins', 'rstaff'), core, { recursive: true });
  const home = path.join(temp, 'control');
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.writeFileSync(path.join(home, 'profiles', 'control.md'), '# Isolated profile\nVerify: make verify\n');
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'),
    '## TASK-1: Fixture\n- status: open\n- pri: P0\n- route: plan\n- deps: -\n'
    + '- source: hand\n- filed: 2026-07-25\n- falsifier: -\n- cheapest-test: -\n'
    + '- links: -\n- context: Fixture context\n');
  const configDir = path.join(temp, 'empty-config');
  const userHome = path.join(temp, 'user-home');
  fs.mkdirSync(configDir);
  fs.mkdirSync(userHome);
  const env = { ...process.env, NODE_OPTIONS: '', RSTAFF_HOME: home,
    CLAUDE_CONFIG_DIR: configDir, HOME: userHome, USERPROFILE: userHome };
  function run(script, args = [], input) {
    return spawnSync(process.execPath, [path.join(core, script), ...args], {
      cwd: home, env, encoding: 'utf8', input,
    });
  }
  return { temp, home, env, run };
}

test('session-start emits the profile without backlog, and ticket counts only with backlog located', t => {
  const f = fixture(t);
  const absent = f.run('hooks/session-start.js', [], JSON.stringify({ cwd: f.home }));
  assert.equal(absent.status, 0);
  assert.equal(absent.stderr, '');
  const context = JSON.parse(absent.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Isolated profile/);
  assert.doesNotMatch(context, /P0 ·|open across|rstaff-backlog:cockpit/);

  fs.cpSync(path.join(root, 'plugins', 'rstaff-backlog'),
    path.join(f.temp, 'plugins', 'rstaff-backlog'), { recursive: true });
  const present = f.run('hooks/session-start.js', [], JSON.stringify({ cwd: f.home }));
  assert.equal(present.status, 0);
  assert.equal(present.stderr, '');
  const withBacklog = JSON.parse(present.stdout).hookSpecificOutput.additionalContext;
  assert.match(withBacklog, /Isolated profile/);
  assert.match(withBacklog, /1 P0 · 1 open across 1 repos — \/rstaff-backlog:cockpit/);
});

test('copied cockpit loads the backlog parser from core and renders the ticket', t => {
  const f = fixture(t);
  const backlog = path.join(f.temp, 'plugins', 'rstaff-backlog');
  fs.cpSync(path.join(root, 'plugins', 'rstaff-backlog'), backlog, { recursive: true });
  const bin = path.join(f.temp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(backlog, 'scripts', 'cockpit.js'), '--json'], {
    cwd: f.home, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.queue.ranked.some(ticket => ticket.id === 'TASK-1'), true);
});

test('health passes and skips backlog state checks when the plugin is absent', t => {
  const f = fixture(t);
  // A malformed dispatch file must be ignored without the optional state collector.
  fs.mkdirSync(path.join(f.home, 'var', 'dispatch', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'var', 'dispatch', 'alpha', 'run.md'), '# No state\n');
  const result = f.run('scripts/health.js', ['--static', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.summary, 'all green');
  assert.equal(report.results.some(row => row.check === 'dispatch state coverage'), false);
});

test('backlog vendors the core hook helper and locator without drift', () => {
  for (const relative of ['hooks/lib.js', 'scripts/locate.js']) {
    assert.deepEqual(fs.readFileSync(path.join(root, 'plugins', 'rstaff-backlog', relative)),
      fs.readFileSync(path.join(root, 'plugins', 'rstaff', relative)), relative);
  }
});
