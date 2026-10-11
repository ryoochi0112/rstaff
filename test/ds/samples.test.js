'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { checkCounts } = require('../../plugins/rstaff/scripts/nbgate.js');

const ROOT = path.resolve(__dirname, '../..');
const SAMPLE = 'plugins/rstaff-ds/samples/analysis/analysis.ipynb';
const nb = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const sourceOf = cell => [].concat(cell.source).join('');

test('sample analysis is saved in run order', () => {
  assert.deepEqual(checkCounts(nb(SAMPLE)), { ok: true });
});

test('seeded fixture fails the count check', () => {
  assert.equal(checkCounts(nb('test/fixtures/ds/seeded.ipynb')).ok, false);
});

test('seeded fixture uses a name before a later cell defines it', () => {
  const code = nb('test/fixtures/ds/seeded.ipynb').cells.filter(c => c.cell_type === 'code').map(sourceOf);
  const use = code.findIndex(s => /clean\[|in clean/.test(s));
  const def = code.findIndex(s => /clean\s*=|clean\.append/.test(s));
  assert.ok(use >= 0 && def > use);
});

test('review-bad metadata indexes the four seeded defects', () => {
  const bad = nb('test/fixtures/ds/review-bad.ipynb');
  const seeded = bad.metadata.rstaff_seeded;
  assert.deepEqual(Object.keys(seeded).sort(), ['no-dumps', 'no-secrets', 'raw-immutable', 'validation']);
  for (const idx of Object.values(seeded)) assert.ok(bad.cells[idx - 1], `cell ${idx} exists`);
});

test('sample has no secret-shaped string and no write call', () => {
  const text = fs.readFileSync(path.join(ROOT, SAMPLE), 'utf8');
  assert.ok(!/sk-/.test(text));
  const src = nb(SAMPLE).cells.map(sourceOf).join('\n');
  assert.ok(!/open\([^)]*['"]w/.test(src));
});

test('sample data has the duplicate row the dedup check reports', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'plugins/rstaff-ds/samples/analysis/data/raw/sales.csv'), 'utf8').trim().split('\n');
  assert.equal(lines[0], 'date,region,units,price');
  assert.equal(lines.length - 1 - new Set(lines.slice(1)).size, 1);
});
