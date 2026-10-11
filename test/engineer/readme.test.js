'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

function engineerSection() {
  const start = readme.indexOf('\n## Engineer quick start\n');
  assert.ok(start >= 0, 'README has the "## Engineer quick start" heading');
  const rest = readme.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end < 0 ? rest : rest.slice(0, end);
}

test('README Engineer quick start sits between the AI section and the allowlist section', () => {
  const ai = readme.indexOf('\n## AI engineer quick start\n');
  const eng = readme.indexOf('\n## Engineer quick start\n');
  const allow = readme.indexOf('\n## Allowlisting your verify command\n');
  assert.ok(ai >= 0 && eng >= 0 && allow >= 0, 'all three headings exist');
  assert.ok(ai < eng, 'Engineer section comes after the AI engineer section');
  assert.ok(eng < allow, 'Engineer section comes before the allowlist section');
});

test('README Engineer quick start keeps the install and setup order', () => {
  const s = engineerSection();
  const at = (needle) => {
    const i = s.indexOf(needle);
    assert.ok(i >= 0, `section contains ${needle}`);
    return i;
  };
  const sp = at('claude plugin marketplace add obra/superpowers-marketplace');
  const repoAdd = at('claude plugin marketplace add ryoochi0112/rstaff');
  const core = at('claude plugin install rstaff@rstaff');
  const eng = at('claude plugin install rstaff-engineer@rstaff');
  assert.ok(sp < repoAdd, 'superpowers marketplace add comes before the repo add');
  assert.ok(sp < core && sp < eng, 'superpowers marketplace add comes before both installs');
  assert.ok(repoAdd < core && core < eng, 'repo add, then rstaff install, then engineer install');
  const setup = at('/rstaff:setup <work-dir>');
  const exp = at('export RSTAFF_HOME=');
  const cd = at('cd <work-dir> && claude');
  assert.ok(eng < setup, 'installs come before setup');
  assert.ok(setup < exp, 'setup comes before the RSTAFF_HOME export');
  assert.ok(exp < cd, 'export comes before starting claude in the work dir');
  const verify = at('make verify');
  const review = at('/rstaff:review HEAD');
  assert.ok(cd < verify && verify < review, 'verify comes before review, both after the work-dir session starts');
});

test('README Engineer quick start content', () => {
  const s = engineerSection();
  assert.ok(s.includes('samples/slugify'), 'uses the slugify sample');
  assert.ok(s.includes('TASK.md'), 'points at TASK.md');
  assert.ok(/git commit -m sample/.test(s), 'commits the sample');
  assert.ok(s.includes('rstaff-pm') && s.includes('superpowers'), 'says what rstaff-engineer also installs');
  // Built from parts: the repo-wide stale-reference scan greps for these literals.
  for (const name of ['doctor', 'plan', 'interview']) {
    const bad = '/' + name;
    assert.ok(!s.includes(bad), `section must not mention ${bad}`);
  }
});
