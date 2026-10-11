'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

function dsSection() {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('## Data scientist quick start');
  assert.ok(start >= 0, 'README has the DS quick start heading');
  const rest = readme.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}

test('README DS quick start activates the gate after setup', () => {
  const section = dsSection();
  const setupAt = section.indexOf('/rstaff:setup <analysis-path>');
  const exportAt = section.indexOf('export RSTAFF_HOME=');
  assert.ok(setupAt >= 0, 'DS section shows /rstaff:setup <analysis-path>');
  assert.ok(exportAt >= 0, 'DS section sets RSTAFF_HOME');
  assert.ok(section.includes('cd <analysis-path> && claude'), 'DS section starts claude in the analysis folder');
  assert.ok(exportAt > setupAt, 'RSTAFF_HOME export comes after the setup command');
});
