'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const claim = /hook-blocked|cannot be bypassed|checkpoint memory|session checkpoint/i;

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const base = path.basename(p);
    if (base === 'node_modules' || p === path.join(root, 'docs/research')) return out;
    for (const e of fs.readdirSync(p)) walk(path.join(p, e), out);
  } else out.push(p);
  return out;
}

test('docs and plugin make no overclaiming enforcement/memory claims', () => {
  const files = [path.join(root, 'README.md')];
  walk(path.join(root, 'docs'), files);
  walk(path.join(root, 'plugins', 'rstaff'), files);
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (claim.test(l)) hits.push(`${path.relative(root, f)}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('README and SECURITY do not recommend a verify-run.js glob allow rule', () => {
  for (const f of ['README.md', 'SECURITY.md']) {
    assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes('verify-run.js*'), f);
  }
});
