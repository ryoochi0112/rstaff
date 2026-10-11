'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = process.env.RSTAFF_CORE_ROOT || path.resolve(__dirname, '../../plugins/rstaff');
const text = fs.readFileSync(path.join(core, 'commands/setup.md'), 'utf8');

test('setup command preserves all five PM golden lines verbatim', () => {
  const lines = text.split('\n').map(line => line.replace(/^ {3}/, ''));
  for (const line of [
    'Control repo created at ~/rstaff-home',
    '  rstaff.json, profiles/, backlog/acme.md, .gitignore (var/)  · git init done',
    'Mode: PM (no product repo) — done signal: backlog validate (blocks stop when red)',
    'Next: export RSTAFF_HOME=~/rstaff-home',
    '      cd ~/rstaff-home && claude, then: /rstaff-pm:interview <your idea>',
  ]) {
    assert.ok(lines.includes(line), `missing golden line: ${line}`);
  }
});

test('setup command routes names and paths and asks once for an existing bare directory', () => {
  assert.ok(text.includes('argument-hint: <product-path | product-name> [--home <dir>]'));
  assert.ok(text.includes('--home "<home>" --name "<name>"'));
  assert.ok(text.includes('containing `/`'));
  assert.ok(text.includes('starting with `.` or `~`'));
  assert.ok(text.includes('any other bare word is a name'));
  assert.ok(text.includes('`./acme` forces'));
  assert.match(text, /bare word is also an existing directory under the cwd, ask once\nwhich mode is meant/);
  assert.ok(text.includes('wait for the answer'));
});

test('setup command retains the path-mode profile golden line', () => {
  assert.ok(text.split('\n').includes('   Profile: profiles/acme-api.md'));
  assert.ok(text.includes('--home "<home>" --product "<product>"'));
});

test('setup command shows adapters under verify only for a non-empty adapters list', () => {
  assert.ok(text.includes('     verify: make verify   (found in ~/work/acme-api/Makefile)\n'
    + '     adapter: label-exact-match   (from rstaff-adapter.json)'));
  assert.ok(text.includes('Show the adapter line only when `adapters` is non-empty'));
  assert.ok(text.includes('one line per adapter name'));
});

test('setup command documents the notebook verify line and the override', () => {
  assert.ok(text.includes('  verify: rstaff:nbgate   (<n> notebooks in <product> — fresh-kernel re-run + run-order check)'));
  assert.ok(text.includes('--verify "<cmd>"'));
});
