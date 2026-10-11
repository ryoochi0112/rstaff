'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const PLUGINS = path.join(ROOT, 'plugins');
const CORE = path.join(PLUGINS, 'rstaff');
const ENGINEER = path.join(PLUGINS, 'rstaff-engineer');
const MOVED = [
  ...['design', 'build', 'dispatch', 'sweep', 'qa', 'land', 'replan', 'secaudit', 'research']
    .map(name => `commands/${name}.md`),
  'skills/parallel-build',
  ...['implementer', 'feature-runner', 'loop-operator'].map(name => `agents/${name}.md`),
  ...['loop-brakes', 'surgical-changes', 'git-workflow', 'testing', 'session-hygiene']
    .map(name => `rules/${name}.md`),
  'schemas/task-review.schema.json',
];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

const markdownFiles = dir => files(dir).filter(file => file.endsWith('.md'));

test('rstaff-engineer manifest depends on core, PM and superpowers at 0.13.0', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ENGINEER, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'rstaff-engineer');
  assert.equal(manifest.version, '0.13.0');
  assert.deepEqual(manifest.dependencies, ['rstaff', 'rstaff-pm', 'superpowers@superpowers-marketplace']);
});

test('engineer owns every moved unit and core owns none', () => {
  for (const relative of MOVED) {
    assert.equal(fs.existsSync(path.join(ENGINEER, relative)), true, `engineer missing ${relative}`);
    assert.equal(fs.existsSync(path.join(CORE, relative)), false, `core still ships ${relative}`);
  }
});

test('core commands are exactly review ship health setup and old filenames ship nowhere', () => {
  assert.deepEqual(fs.readdirSync(path.join(CORE, 'commands')).sort(), ['health.md', 'review.md', 'setup.md', 'ship.md']);
  for (const file of files(PLUGINS)) {
    assert.ok(!['plan.md', 'batch.md'].includes(path.basename(file)), `old command filename: ${file}`);
  }
});

test('engineer markdown local and locate paths resolve in their owning plugins', () => {
  let directReferences = 0;
  let locatedReferences = 0;
  for (const file of markdownFiles(ENGINEER)) {
    const text = fs.readFileSync(file, 'utf8');
    const located = /\$\(node\s+["']?\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/locate\.js["']?\s+([a-z][a-z0-9-]*)\)\/([A-Za-z0-9._/-]+)/g;
    for (const match of text.matchAll(located)) {
      locatedReferences++;
      assert.ok(['rstaff', 'rstaff-delegation'].includes(match[1]), `${file}: unexpected plugin ${match[1]}`);
      assert.equal(fs.existsSync(path.join(PLUGINS, match[1], match[2])), true, `${file}: missing located ${match[2]}`);
    }
    for (const match of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g)) {
      directReferences++;
      assert.equal(fs.existsSync(path.join(ENGINEER, match[1])), true, `${file}: missing local ${match[1]}`);
    }
  }
  assert.ok(directReferences > 0);
  assert.ok(locatedReferences > 0);
});

test('engineer review-round calls all locate core', () => {
  const callers = [
    'skills/parallel-build/SKILL.md', 'agents/feature-runner.md',
    'commands/land.md', 'rules/loop-brakes.md',
  ];
  for (const relative of callers) {
    const text = fs.readFileSync(path.join(ENGINEER, relative), 'utf8');
    assert.ok(text.includes('$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-review-rounds.js'), relative);
  }
  for (const file of markdownFiles(ENGINEER)) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('${CLAUDE_PLUGIN_ROOT}/scripts/lib-review-rounds.js'), file);
  }
});

test('renamed commands and moved namespaces leave no old references', () => {
  const oldCommands = /\/plan\b(?!\.[A-Za-z]|\/)|\/batch\b(?!\.[A-Za-z]|\/)|\brstaff:(?:plan|batch)\b/g;
  const oldNamespace = /\brstaff:(?:spec|build|dispatch|qa|land|replan|secaudit|research|grilling|parallel-build|implementer|feature-runner|loop-operator)\b/g;
  const scoped = ['plugins', 'maintainer', 'test', 'install'].flatMap(dir => files(path.join(ROOT, dir)))
    .concat(['Makefile', 'CLAUDE.md', 'docs/ROLES.md'].map(file => path.join(ROOT, file)));
  for (const file of scoped) {
    if (file === __filename) continue; // The guard names the forbidden references in its regex.
    // Historical usage mode remains readable after the namespace move.
    const text = fs.readFileSync(file, 'utf8').replace(
      file === path.join(PLUGINS, 'rstaff-usage/scripts/usage.js')
        ? /'subagent:rstaff:implementer'/g : /$^/g, '');
    assert.deepEqual([...text.matchAll(oldCommands)], [], file);
    assert.deepEqual([...text.matchAll(oldNamespace)], [], file);
  }
});

test('core review locates engineer rules and documents an absent layer', () => {
  const text = fs.readFileSync(path.join(CORE, 'commands/review.md'), 'utf8');
  assert.ok(text.includes('$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-engineer)/rules/loop-brakes.md'));
  assert.match(text, /If `locate\.js rstaff-engineer` exits 1, say/);
  for (const name of ['review', 'ship']) {
    assert.ok(fs.readFileSync(path.join(CORE, `commands/${name}.md`), 'utf8')
      .includes('${CLAUDE_PLUGIN_ROOT}/scripts/lib-review-rounds.js'), name);
  }
});

test('engineer is listed in the marketplace and installer validation', () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  const entry = marketplace.plugins.find(plugin => plugin.name === 'rstaff-engineer');
  assert.ok(entry);
  assert.equal(entry.source, './plugins/rstaff-engineer');
  assert.equal(entry.version, '0.13.0');
  assert.match(fs.readFileSync(path.join(ROOT, 'install/install-apply.sh'), 'utf8'),
    /"plugins\/rstaff-engineer\/\.claude-plugin\/plugin\.json"/);
});

test('engineer vendors locate.js byte-identically', () => {
  assert.deepEqual(fs.readFileSync(path.join(ENGINEER, 'scripts/locate.js')),
    fs.readFileSync(path.join(CORE, 'scripts/locate.js')));
});
