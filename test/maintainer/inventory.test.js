'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');
const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'maintainer/inventory.json'), 'utf8'));
const PLUGIN_NAMES = ['rstaff', 'rstaff-pm', 'rstaff-ds', 'rstaff-engineer', 'rstaff-ai', 'rstaff-ai-datadog', 'rstaff-delegation', 'rstaff-backlog', 'rstaff-usage'];
const DESTS = new Set([...PLUGIN_NAMES, 'maintainer', 'installer', 'deleted']);
// Build-only overlays replace public files; their source directory is never shipped.
const BUILD_ONLY_PREFIX = 'maintainer/public-overlay/';

// Spec 9 core inventory: the only files `dest: "rstaff"` may contain.
const CORE_ALLOWED = new Set([
  '.claude-plugin/plugin.json', 'hooks/hooks.json',
  ...['lib', 'guard-bash', 'completion-gate', 'verify-recorder', 'session-start', 'secret-scan'].map(n => `hooks/${n}.js`),
  ...['lib-backlog', 'lib-gate', 'lib-review-rounds', 'verify-run', 'health', 'locate', 'setup', 'nbgate'].map(n => `scripts/${n}.js`),
  ...['review', 'ship', 'health', 'setup'].map(n => `commands/${n}.md`),
  'agents/reviewer.md', 'rules/review-severity.md', 'rules/security.md',
  'templates/Makefile.sample', 'templates/profile.sample.md',
]);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? walk(f) : [f];
  });
}
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const destOf = to => to.startsWith('plugins/') ? to.split('/')[1]
  : to.startsWith('maintainer/') ? 'maintainer' : to.startsWith('install/') ? 'installer' : null;

// Pure checker over (inventory, current files) so fixtures can prove each rule fires.
function problems(inventory, current, exists) {
  const out = [];
  const count = (items) => items.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
  const froms = count(inventory.entries.filter(e => e.from !== null).map(e => e.from));
  for (const f of inventory.main) if (froms.get(f) !== 1) out.push(`pre-split ${f} appears ${froms.get(f) || 0}x as from`);
  for (const f of froms.keys()) if (!inventory.main.includes(f)) out.push(`from ${f} is not a pre-split file`);
  const tos = count(inventory.entries.filter(e => e.to !== null).map(e => e.to));
  for (const f of current) if (tos.get(f) !== 1) out.push(`current ${f} appears ${tos.get(f) || 0}x as to`);
  for (const e of inventory.entries) {
    if (!DESTS.has(e.dest)) { out.push(`bad dest ${e.dest}`); continue; }
    if (e.dest === 'deleted') {
      if (e.to !== null) out.push(`deleted ${e.from} has to`);
      if (e.from === null) out.push('deleted entry without from');
      if (e.from && exists(e.from)) out.push(`deleted ${e.from} still exists`);
      continue;
    }
    if (e.to === null) { out.push(`${e.from} has no to but dest ${e.dest}`); continue; }
    if (!exists(e.to)) out.push(`to ${e.to} does not exist`);
    if (destOf(e.to) !== e.dest) out.push(`${e.to} dest ${e.dest} disagrees with its path`);
    if (e.dest === 'rstaff') {
      const inside = e.to.slice('plugins/rstaff/'.length);
      if (!CORE_ALLOWED.has(inside)) out.push(`${e.to} is not in the spec 9 core inventory`);
    }
  }
  return out;
}

const inCurrentScope = f => !f.endsWith('.DS_Store') && !f.startsWith('evals/results/')
  && !f.startsWith(BUILD_ONLY_PREFIX);
const current = [...walk(path.join(ROOT, 'plugins')), ...walk(path.join(ROOT, 'install')),
  ...walk(path.join(ROOT, 'maintainer')), ...walk(path.join(ROOT, 'evals'))]
  .map(rel).filter(inCurrentScope);
const exists = f => fs.existsSync(path.join(ROOT, f));

test('inventory covers every pre-split and current file exactly once', () => {
  assert.deepEqual(problems(inv, current, exists), []);
});

test('the inventory lists itself and the marketplace names exactly nine plugins that exist (AC1)', () => {
  assert.ok(inv.entries.some(e => e.to === 'maintainer/inventory.json'));
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.deepEqual(market.plugins.map(p => p.name).sort(), [...PLUGIN_NAMES].sort());
  for (const p of market.plugins) assert.ok(exists(`${p.source.replace(/^\.\//, '')}/.claude-plugin/plugin.json`), p.name);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'plugins')).filter(d => !d.startsWith('.')).sort(), [...PLUGIN_NAMES].sort());
});

test('checker fixtures: each rule fires on a broken inventory', () => {
  const base = { main: ['old/a.js', 'old/gone.js'], entries: [
    { from: 'old/a.js', to: 'plugins/rstaff/hooks/lib.js', dest: 'rstaff' },
    { from: 'old/gone.js', to: null, dest: 'deleted' },
  ] };
  const files = ['plugins/rstaff/hooks/lib.js'];
  const ex = f => files.includes(f);
  assert.deepEqual(problems(base, files, ex), []);
  const clone = () => JSON.parse(JSON.stringify(base));
  let b = clone(); b.main.push('old/missing.js');
  assert.match(problems(b, files, ex).join('|'), /old\/missing\.js appears 0x/);
  b = clone(); b.entries.push({ from: 'old/a.js', to: null, dest: 'deleted' });
  assert.match(problems(b, files, ex).join('|'), /old\/a\.js appears 2x/);
  assert.match(problems(base, [...files, 'plugins/rstaff/hooks/new.js'], ex).join('|'), /new\.js appears 0x as to/);
  b = clone(); b.entries[0].dest = 'rstaff-ai';
  assert.match(problems(b, files, ex).join('|'), /disagrees with its path/);
  b = clone(); b.entries[0].to = 'plugins/rstaff/hooks/ghost.js';
  assert.match(problems(b, files, ex).join('|'), /does not exist/);
  assert.match(problems(base, files, f => f === 'old/gone.js' || ex(f)).join('|'), /deleted old\/gone\.js still exists/);
  b = clone(); b.entries[1].to = 'x';
  assert.match(problems(b, files, ex).join('|'), /deleted old\/gone\.js has to/);
  b = clone(); b.entries[0].to = 'plugins/rstaff/hooks/extra.js';
  assert.match(problems(b, ['plugins/rstaff/hooks/extra.js'], f => true).join('|'), /not in the spec 9 core inventory/);
});

test('checker excludes build-only overlays but still rejects stray maintainer files', () => {
  const base = { main: [], entries: [
    { from: null, to: 'maintainer/example.js', dest: 'maintainer' },
  ] };
  const files = ['maintainer/example.js', 'maintainer/public-overlay/CLAUDE.md'];
  const ex = f => files.includes(f);
  assert.deepEqual(problems(base, files.filter(inCurrentScope), ex), []);
  for (const stray of ['maintainer/stray.js', 'maintainer/public-overlay-other/stray.js']) {
    const current = [...files, stray].filter(inCurrentScope);
    assert.ok(problems(base, current, f => ex(f) || f === stray)
      .includes(`current ${stray} appears 0x as to`), stray);
  }
});
