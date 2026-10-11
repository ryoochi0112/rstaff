'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(ROOT, file));
const json = file => JSON.parse(read(file));
const CORE_VERSION = json('plugins/rstaff/.claude-plugin/plugin.json').version;

test('DS manifest depends only on core and shares its version', () => {
  const manifest = json('plugins/rstaff-ds/.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'rstaff-ds');
  assert.deepEqual(manifest.dependencies, ['rstaff']);
  assert.equal(manifest.version, CORE_VERSION);
});

test('DS vendors locate.js byte-identically to core', () => {
  assert.deepEqual(read('plugins/rstaff-ds/scripts/locate.js'), read('plugins/rstaff/scripts/locate.js'));
});

test('marketplace places DS after PM and before engineer', () => {
  const { plugins } = json('.claude-plugin/marketplace.json');
  const index = plugins.findIndex(plugin => plugin.name === 'rstaff-ds');
  const engineerIndex = plugins.findIndex(plugin => plugin.name === 'rstaff-engineer');
  assert.equal(plugins[0].name, 'rstaff');
  assert.equal(index, plugins.findIndex(plugin => plugin.name === 'rstaff-pm') + 1);
  assert.ok(engineerIndex > index, 'DS must precede engineer');
  assert.equal(plugins[index].source, './plugins/rstaff-ds');
  assert.equal(plugins[index].version, CORE_VERSION);
  assert.equal(plugins[index].description, json('plugins/rstaff-ds/.claude-plugin/plugin.json').description);
  assert.equal(plugins[index].category, 'workflow');
});

test('installer validates the DS manifest explicitly', () => {
  assert.ok(read('install/install-apply.sh').toString().includes('"plugins/rstaff-ds/.claude-plugin/plugin.json"'));
});
