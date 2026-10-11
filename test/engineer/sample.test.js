'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const SAMPLE = path.join(ROOT, 'plugins/rstaff-engineer/samples/slugify');
const SETUP = path.join(ROOT, 'plugins/rstaff/scripts/setup.js');
const FIXED_SOURCE = `'use strict';
function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
module.exports = { slugify };
`;

function counts(output) {
  const count = label => {
    const match = output.match(new RegExp(`^(?:#|ℹ) ${label} (\\d+)\\r?$`, 'm'));
    assert.ok(match, `expected node:test ${label} count, got:\n${output}`);
    return Number(match[1]);
  };
  return { tests: count('tests'), passed: count('pass'), failed: count('fail') };
}

function runTests(directory) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', 'slugify.test.js'], {
    cwd: directory,
    encoding: 'utf8',
    env
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('sample starts with one failing case, passes after a fix, and setup detects make verify', t => {
  assert.ok(fs.existsSync(SAMPLE), 'slugify sample exists');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-engineer-sample-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const copy = path.join(temp, 'slugify');
  const home = path.join(temp, 'home');
  fs.cpSync(SAMPLE, copy, { recursive: true });

  const shipped = runTests(copy);
  assert.notEqual(shipped.status, 0, shipped.output);
  assert.deepEqual(counts(shipped.output), { tests: 5, passed: 4, failed: 1 });
  assert.match(shipped.output, /^(?:not ok \d+ - collapses repeated separators|✖ collapses repeated separators(?:\s|$))/m);

  fs.writeFileSync(path.join(copy, 'slugify.js'), FIXED_SOURCE);
  const fixed = runTests(copy);
  assert.equal(fixed.status, 0, fixed.output);
  assert.deepEqual(counts(fixed.output), { tests: 5, passed: 5, failed: 0 });

  const setup = spawnSync(process.execPath, [SETUP, '--home', home, '--product', copy], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(setup.error, undefined, setup.error?.message);
  assert.equal(setup.status, 0, setup.stderr);
  const result = JSON.parse(setup.stdout);
  assert.equal(result.verify, 'make verify');
  assert.equal(result.verifySource, 'Makefile');
});
