'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const PLUGINS = path.resolve(__dirname, '../../plugins');
const plugins = fs.readdirSync(PLUGINS).filter(d => fs.existsSync(path.join(PLUGINS, d, '.claude-plugin/plugin.json')));
const CORE = path.join(PLUGINS, 'rstaff');
const VENDORED = ['hooks/lib.js', 'scripts/locate.js'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === 'evals' ? [] : walk(f)) : [f];
  });
}

test('every vendored lib.js / locate.js is byte-identical to the core copy', () => {
  assert.ok(plugins.includes('rstaff') && plugins.length >= 6);
  for (const rel of VENDORED) {
    const core = fs.readFileSync(path.join(CORE, rel));
    for (const p of plugins) {
      const copy = path.join(PLUGINS, p, rel);
      if (fs.existsSync(copy)) assert.ok(core.equals(fs.readFileSync(copy)), `${p}/${rel} drifted from core`);
    }
  }
});

test('every plugin has its own locate.js; a plugin requiring ./lib.js has its own copy', () => {
  for (const p of plugins) {
    assert.ok(fs.existsSync(path.join(PLUGINS, p, 'scripts/locate.js')), `${p} lacks scripts/locate.js`);
    for (const file of walk(path.join(PLUGINS, p)).filter(f => f.endsWith('.js'))) {
      const src = fs.readFileSync(file, 'utf8');
      const needsLib = /require\(\s*['"]\.\/lib(\.js)?['"]\s*\)/.test(src) || /require\(\s*['"]\.\.\/hooks\/lib(\.js)?['"]\s*\)/.test(src);
      if (needsLib) assert.ok(fs.existsSync(path.join(PLUGINS, p, 'hooks/lib.js')), `${p} requires lib.js (${path.relative(PLUGINS, file)}) but has no hooks/lib.js`);
      const needsLocate = /require\(\s*['"]\.\/locate(\.js)?['"]\s*\)/.test(src);
      if (needsLocate) assert.ok(fs.existsSync(path.join(PLUGINS, p, 'scripts/locate.js')), `${p} requires locate.js without a copy`);
    }
  }
});

test('no plugin requires a sibling plugin by relative path', () => {
  for (const p of plugins) {
    for (const file of walk(path.join(PLUGINS, p)).filter(f => f.endsWith('.js'))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (!m[1].startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), m[1]);
        assert.ok(target.startsWith(path.join(PLUGINS, p) + path.sep), `${path.relative(PLUGINS, file)} requires outside its plugin: ${m[1]}`);
      }
    }
  }
});
