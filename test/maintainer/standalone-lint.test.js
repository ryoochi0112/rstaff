'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { lintStandalone, readPending } = require('../../maintainer/lib-skill-lint.js');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'maintainer/lib-skill-lint.js');
const PENDING = path.join(ROOT, 'maintainer/standalone-pending.txt');
const fixture = name => path.join(ROOT, 'test/fixtures/standalone', name, 'SKILL.md');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const names = ['agent-evaluation', 'data-science', 'datadog-llmobs-analysis',
  'experiment-design', 'grilling', 'harness-validation', 'parallel-build',
  'token-efficient-delegation'];

for (const [name, line, token] of [
  ['unmarked', 6, 'RSTAFF_HOME'],
  ['control-repo', 6, 'Control Repo'],
  ['var-path', 6, 'var/specs/example.md'],
  ['plugin-command', 6, '/rstaff-pm:spec'],
  ['unclosed', 6, 'unclosed with-rstaff block'],
]) {
  test(`standalone rejects ${name} with file, line and token`, () => {
    const file = fixture(name);
    const result = run('--standalone', file);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(`standalone ${file}:${line}: ${token}`), result.stdout);
  });
}

test('marked reference passes as a file and a directory', () => {
  for (const target of [fixture('marked'), path.dirname(fixture('marked'))]) {
    const result = run('--standalone', target);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
  }
});

test('missing standalone instructions fail with the specified message', () => {
  const file = fixture('missing-use');
  const result = run('--standalone', file);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(`standalone ${file}: missing "Use without rstaff:" line`));
});

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-lint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('pending applies only to listed violators and warns for stale entries', t => {
  const dir = temp(t);
  const pending = path.join(dir, 'pending.txt');
  fs.writeFileSync(pending, '# fixture exemptions\nunmarked # reason\nmarked\n');
  assert.deepEqual([...readPending(pending)].sort(), ['marked', 'unmarked']);
  const listed = run('--standalone', fixture('unmarked'), '--pending', pending);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, 'pending: unmarked\n');
  const unlisted = run('--standalone', fixture('control-repo'), '--pending', pending);
  assert.equal(unlisted.status, 1);
  assert.ok(unlisted.stdout.includes('Control Repo'));
  const stale = run('--standalone', fixture('marked'), '--pending', pending);
  assert.equal(stale.status, 0);
  assert.equal(stale.stdout, 'pending-stale: marked\n');
});

test('pending list contains exactly the eight contracted skills', () => {
  assert.deepEqual([...readPending(PENDING)].sort(), names);
});

test('removing grilling from a temporary pending list fails on the live skill', t => {
  const pending = path.join(temp(t), 'pending.txt');
  fs.writeFileSync(pending, [...readPending(PENDING)].filter(name => name !== 'grilling').join('\n'));
  const result = run('--standalone', path.join(ROOT, 'plugins'), '--pending', pending);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /standalone .*\/grilling\/SKILL\.md:/);
});

test('default CLI runs standalone with the checked-in pending list', () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').sort(), names.map(name => `pending: ${name}`));
});

test('fenced tokens count, path substrings do not, and blocks end precisely', () => {
  const text = 'Use without rstaff: Work locally.\r\n```sh\r\nRSTAFF_HOME\r\n```\r\n'
    + 'foovar/file /tmp/var/file variable/\r\n'
    + '<!-- with-rstaff -->control repo var/foo /rstaff-pm:spec<!-- /with-rstaff -->RSTAFF_HOME\r\n';
  const violations = lintStandalone('fixture.md', text);
  assert.deepEqual(violations.map(v => [v.file, v.line, v.detail]), [
    ['fixture.md', 3, 'RSTAFF_HOME'], ['fixture.md', 6, 'RSTAFF_HOME'],
  ]);
});

test('a required line inside an optional block cannot supply standalone instructions', () => {
  const result = lintStandalone('fixture.md', '<!-- with-rstaff -->\nUse without rstaff: Hidden.\n<!-- /with-rstaff -->\n');
  assert.equal(result.length, 1);
  assert.equal(result[0].detail, 'missing "Use without rstaff:" line');
});

test('fixture directory scanning ignores references and refuses missing or empty input', t => {
  const dir = temp(t);
  fs.copyFileSync(fixture('marked'), path.join(dir, 'SKILL.md'));
  fs.mkdirSync(path.join(dir, 'references'));
  fs.copyFileSync(fixture('unmarked'), path.join(dir, 'references/SKILL.md'));
  assert.equal(run('--standalone', dir).status, 0);
  assert.equal(run('--standalone', path.join(dir, 'absent')).status, 1);
  assert.equal(run('--standalone', path.join(dir, 'references/empty')).status, 1);
  fs.mkdirSync(path.join(dir, 'empty'));
  assert.equal(run('--standalone', path.join(dir, 'empty')).status, 1);
});
