'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(ROOT, file));
const json = file => JSON.parse(read(file));
const CORE_VERSION = json('plugins/rstaff/.claude-plugin/plugin.json').version;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

test('PM manifest depends only on core and shares its version', () => {
  const manifest = json('plugins/rstaff-pm/.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'rstaff-pm');
  assert.deepEqual(manifest.dependencies, ['rstaff']);
  assert.equal(manifest.version, CORE_VERSION);
});

test('PM vendors locate.js byte-identically to core', () => {
  assert.deepEqual(read('plugins/rstaff-pm/scripts/locate.js'), read('plugins/rstaff/scripts/locate.js'));
});

test('interview belongs to PM and resolves backlog through core', () => {
  const commands = 'plugins/rstaff-backlog/commands';
  const interview = 'plugins/rstaff-pm/commands/interview.md';
  assert.ok(fs.existsSync(path.join(ROOT, interview)));
  assert.deepEqual(fs.readdirSync(path.join(ROOT, commands)).sort(), ['cockpit.md']);
  const content = read(interview).toString();
  assert.ok(content.includes('$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff)/scripts/lib-backlog.js'));
  assert.ok(!content.includes('${CLAUDE_PLUGIN_ROOT}/scripts/lib-backlog.js'));
});

test('PM owns spec, grilling and its evals; engineer depends on PM', () => {
  for (const relative of ['commands/spec.md', 'skills/grilling/SKILL.md',
    'evals/grilling-trigger', 'evals/grilling-compliance']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'plugins/rstaff-pm', relative)), `PM missing ${relative}`);
    assert.equal(fs.existsSync(path.join(ROOT, 'plugins/rstaff-engineer', relative)), false,
      `engineer still ships ${relative}`);
  }
  assert.ok(json('plugins/rstaff-engineer/.claude-plugin/plugin.json').dependencies.includes('rstaff-pm'));
});

test('PM markdown local and locate paths resolve in their owning plugins', () => {
  let directReferences = 0;
  let locatedReferences = 0;
  for (const file of files(path.join(ROOT, 'plugins/rstaff-pm')).filter(file => file.endsWith('.md'))) {
    const text = fs.readFileSync(file, 'utf8');
    const located = /\$\(node\s+["']?\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/locate\.js["']?\s+([a-z][a-z0-9-]*)\)\/([A-Za-z0-9._/-]+)/g;
    for (const match of text.matchAll(located)) {
      locatedReferences++;
      assert.ok(fs.existsSync(path.join(ROOT, 'plugins', match[1], match[2])),
        `${file}: missing located ${match[1]}/${match[2]}`);
    }
    for (const match of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g)) {
      directReferences++;
      assert.ok(fs.existsSync(path.join(ROOT, 'plugins/rstaff-pm', match[1])),
        `${file}: missing local ${match[1]}`);
    }
  }
  assert.ok(directReferences > 0);
  assert.ok(locatedReferences > 0);
});

test('PM namespace move leaves no old references except README rename notes', () => {
  const oldNamespace = /rstaff-backlog:interview|rstaff-engineer:spec|rstaff-engineer:grilling/;
  const scoped = ['plugins', 'maintainer', 'test', 'install', 'docs']
    .flatMap(dir => files(path.join(ROOT, dir)))
    .concat(['Makefile', 'CLAUDE.md', 'README.md'].map(file => path.join(ROOT, file)));
  for (const file of scoped) {
    if (file === __filename || file.startsWith(path.join(ROOT, 'docs/research') + path.sep)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (path.basename(file) === 'README.md' && line.includes('→ `/rstaff-pm:')) continue;
      assert.doesNotMatch(line, oldNamespace, `${path.relative(ROOT, file)}:${index + 1}: old PM namespace`);
    }
  }
});

test('marketplace places PM directly after core and before engineer', () => {
  const { plugins } = json('.claude-plugin/marketplace.json');
  const index = plugins.findIndex(plugin => plugin.name === 'rstaff-pm');
  const engineerIndex = plugins.findIndex(plugin => plugin.name === 'rstaff-engineer');
  assert.equal(plugins[0].name, 'rstaff');
  assert.equal(index, 1);
  assert.ok(engineerIndex > index, 'PM must precede engineer');
  assert.equal(plugins[index].source, './plugins/rstaff-pm');
  assert.equal(plugins[index].version, CORE_VERSION);
  assert.equal(plugins[index].description, json('plugins/rstaff-pm/.claude-plugin/plugin.json').description);
  assert.equal(plugins[index].category, 'workflow');
});

test('installer validates the PM manifest explicitly', () => {
  assert.ok(read('install/install-apply.sh').toString().includes('"plugins/rstaff-pm/.claude-plugin/plugin.json"'));
});
