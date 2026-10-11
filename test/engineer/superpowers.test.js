'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const PLUGINS = path.join(ROOT, 'plugins');
const FALLBACK = 'rstaff-delegation not installed — all tasks use the Claude writer';
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

for (const name of fs.readdirSync(PLUGINS)) {
  test(`${name} declares only its required dependencies`, () => {
    const manifest = JSON.parse(read(`plugins/${name}/.claude-plugin/plugin.json`));
    const expected = name === 'rstaff' ? [] : ['rstaff'];
    if (name === 'rstaff-engineer') expected.push('rstaff-pm');
    if (['rstaff-engineer', 'rstaff-ai'].includes(name)) expected.push('superpowers@superpowers-marketplace');
    if (name === 'rstaff-ai-datadog') expected.splice(0, 1, 'rstaff-ai');
    assert.deepEqual(manifest.dependencies || [], expected);
  });
}

test('marketplace allowlists the superpowers marketplace', () => {
  const manifest = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.deepEqual(manifest.allowCrossMarketplaceDependenciesOn, ['superpowers-marketplace']);
});

test('plugins contain no degraded wording', () => {
  for (const file of files(PLUGINS)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /degrad/i, file);
});

test('plugins contain no peer-plugins filename or reference', () => {
  for (const file of files(PLUGINS)) {
    assert.notEqual(path.basename(file), 'peer-plugins.md', file);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('peer-plugins.md'), file);
  }
});

for (const relative of ['commands/build.md', 'skills/parallel-build/SKILL.md', 'agents/feature-runner.md']) {
  test(`${relative} pins the one-line auto fallback before routing`, () => {
    const text = read(`plugins/rstaff-engineer/${relative}`);
    assert.equal(text.split(FALLBACK).length - 1, 1);
    assert.match(text, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/locate\.js" rstaff-delegation/);
    assert.match(text, /`impl: auto`[\s\S]*every task to a fresh Claude `implementer`/);
    assert.match(text, /Print exactly once per run/);
    assert.match(text, /Skip `route\.js` resolve\/require and external dispatch/);
    assert.ok(text.indexOf(FALLBACK) < text.indexOf('/scripts/route.js'), 'preflight must precede routing');
  });
}

test('all delegation callers use the same fallback sentence', () => {
  let callers = 0;
  for (const file of files(PLUGINS)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('delegation is not installed; using Claude writer and reviewer'), file);
    if (text.includes('If `locate.js rstaff-delegation` exits 1')) {
      callers++;
      assert.ok(text.includes(FALLBACK), file);
    }
  }
  assert.equal(callers, 10); // All callers present in the T9 source tree.
});

test('usage verdicts attribute both historical and current implementer modes', () => {
  const usage = require('../../plugins/rstaff-usage/scripts/usage.js');
  for (const plugin of ['rstaff', 'rstaff-engineer']) {
    const mode = ['subagent', plugin, 'implementer'].join(':');
    const groups = usage.summarizeVerdicts([
      { mode, label: 'r/s/T1/implement', adapter: 'claude', model: 'sonnet', attempt: 1, timestamp: '2026-10-01T00:00:00Z' },
      { mode: 'verdict', label: 'r/s/T1', verdict: 'pass', attempt: 1, timestamp: '2026-10-01T00:01:00Z' },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].writer, 'claude / sonnet', mode);
    assert.equal(groups[0].pass, 1);
  }
});
