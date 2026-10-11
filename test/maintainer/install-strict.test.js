'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'install/install-apply.sh');

// A PATH with node + system tools but no `claude`, plus an optional stub claude.
function sandbox(t, stubBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-strict-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  if (stubBody !== undefined) {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${stubBody}\n`, { mode: 0o755 });
  }
  const log = path.join(dir, 'calls.log');
  const run = () => spawnSync('/bin/bash', [SCRIPT], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CALL_LOG: log },
  });
  return { run, log };
}

test('strict validation runs on the marketplace and on every plugins/* directory', t => {
  const s = sandbox(t, 'echo "$@" >> "$CALL_LOG"');
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = fs.readFileSync(s.log, 'utf8').trim().split('\n');
  const plugins = fs.readdirSync(path.join(ROOT, 'plugins')).filter(d => fs.statSync(path.join(ROOT, 'plugins', d)).isDirectory());
  assert.equal(calls.length, plugins.length + 1);
  assert.ok(calls.every(c => c.startsWith('plugin validate --strict ')), calls.join('\n'));
  assert.ok(calls.includes(`plugin validate --strict ${ROOT}`), 'marketplace (repo root) not validated');
  for (const p of plugins) assert.ok(calls.includes(`plugin validate --strict ${path.join(ROOT, 'plugins', p)}`), `${p} not validated`);
});

test('a strict validation failure fails the script', t => {
  const s = sandbox(t, 'echo "✘ Validation failed" >&2; exit 1');
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /strict validation failed/);
});

test('no claude on PATH: one clear WARN that validation was skipped, not a failure', t => {
  const s = sandbox(t);
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const warns = r.stderr.split('\n').filter(l => /strict/.test(l) && /SKIPPED/.test(l));
  assert.equal(warns.length, 1, r.stderr);
  assert.match(warns[0], /WARN/);
});
