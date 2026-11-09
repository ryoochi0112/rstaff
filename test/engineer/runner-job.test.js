'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(ROOT, 'plugins/rstaff-engineer/scripts/runner');
const { parseJob, forbiddenTouched, outsideAllowed, globToRegExp } = require(path.join(RUNNER, 'job.js'));
const { resolveVerify, resolveInstall } = require(path.join(RUNNER, 'profile.js'));
const { parseArgs, resolveHome } = require(path.join(RUNNER, 'cli.js'));
const { stopRequested } = require(path.join(RUNNER, 'run.js'));

test('the kill switch fails closed: absent is null, present or unreadable both stop', { skip: process.getuid?.() === 0 ? 'root bypasses permissions' : false }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-runner-stop-'));
  t.after(() => { fs.chmodSync(path.join(dir, 'locked'), 0o755); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(stopRequested(path.join(dir, 'var', '.STOP')), null);
  fs.writeFileSync(path.join(dir, 'file'), '');
  assert.equal(stopRequested(path.join(dir, 'file', '.STOP')), null, 'a file where var/ should be means no switch');
  fs.writeFileSync(path.join(dir, '.STOP'), '');
  assert.equal(stopRequested(path.join(dir, '.STOP')), 'present');
  fs.mkdirSync(path.join(dir, 'locked'));
  fs.chmodSync(path.join(dir, 'locked'), 0o000);
  assert.equal(stopRequested(path.join(dir, 'locked', '.STOP')), 'unreadable (EACCES)');
});

const JOB = `# Job: T-1 — stop the double count
- repo: acme
- ticket: T-1

## What should be true when done
Counting twice is gone.

## Checks
1. \`test -f done.txt\` → exit 0
2. \`grep -q changed src/keep.txt\` → exit 1
3. \`echo hello\` → exit 0, output contains "hello"

## Do not touch
- src/keep.txt
- \`docs/**\`

## Caps
- time: 90 minutes
- money: 8 USD
- worker turns: 40
- rounds: 2
`;

test('parseJob reads title, fields, checks, forbidden paths and caps', () => {
  const job = parseJob(JOB);
  assert.equal(job.title, 'Job: T-1 — stop the double count');
  assert.equal(job.summary, 'stop the double count');
  assert.equal(parseJob(JOB.replace('# Job: T-1 — stop', '# T-1: stop')).summary, 'stop the double count');
  assert.equal(job.repo, 'acme');
  assert.equal(job.ticket, 'T-1');
  assert.equal(job.branch, 'rstaff/t-1');
  assert.deepEqual(job.checks, [
    { command: 'test -f done.txt', exit: 0, contains: null },
    { command: 'grep -q changed src/keep.txt', exit: 1, contains: null },
    { command: 'echo hello', exit: 0, contains: 'hello' },
  ]);
  assert.deepEqual(job.forbidden, ['src/keep.txt', 'docs/**']);
  assert.deepEqual(job.caps, { timeMinutes: 90, moneyUsd: 8, workerTurns: 40, rounds: 2 });
  assert.equal(parseJob(JOB.replace('- time: 90 minutes', '- time: 2 hours')).caps.timeMinutes, 120);
  assert.equal(parseJob(JOB.replace(/- worker turns: 40\n- rounds: 2\n/, '')).caps.workerTurns, 60);
  assert.equal(parseJob(JOB.replace('- rounds: 2', '- rounds: 9')).caps.rounds, 3, 'rounds are capped at three');
  assert.equal(parseJob(JOB.replace('- ticket: T-1', '- ticket: T-1\n- branch: feat/custom')).branch, 'feat/custom');
});

test('## Files lists what the worker may change; outsideAllowed names every other path; no list means no limit', () => {
  const job = parseJob(`${JOB}\n## Files\n- done.txt\n- \`src/lib/\`\n- docs/*.md\n`);
  assert.deepEqual(job.allowed, ['done.txt', 'src/lib/', 'docs/*.md']);
  assert.deepEqual(outsideAllowed(job.allowed, ['done.txt', 'src/lib/a.ts', 'src/lib/deep/b.ts', 'docs/x.md', 'extra.txt', 'docs/sub/y.md', 'src/other.ts', 'done.txt.bak']),
    ['extra.txt', 'docs/sub/y.md', 'src/other.ts', 'done.txt.bak']);
  assert.deepEqual(parseJob(JOB).allowed, []);
  assert.deepEqual(outsideAllowed([], ['anything', 'at/all.txt']), []);
});

test('parseJob refuses a job it cannot run and names every problem', () => {
  assert.throws(() => parseJob(JOB.replace(/3\. `echo hello`.*\n/, '')), /three to six checks, found 2/);
  assert.throws(() => parseJob(JOB.replace('- money: 8 USD', '- budget: 8')), /caps need `- money: N USD`/);
  assert.throws(() => parseJob(JOB.replace('- time: 90 minutes', '- time: soon')), /caps need `- time: N minutes`/);
  assert.throws(() => parseJob(JOB.replace('1. `test -f done.txt` → exit 0', '1. run the tests')), /check line not runnable: 1\. run the tests/);
  assert.throws(() => parseJob(JOB.replace('- repo: acme\n', '')), /needs a `- repo:` line/);
  const seven = JOB.replace('## Do not touch', '4. `true` → exit 0\n5. `true` → exit 0\n6. `true` → exit 0\n7. `true` → exit 0\n\n## Do not touch');
  assert.throws(() => parseJob(seven), /found 7/);
});

test('forbiddenTouched matches files, directories and globs', () => {
  assert.deepEqual(forbiddenTouched(['src/keep.txt', 'docs/**', 'packages/engine/'], [
    'src/keep.txt', 'src/other.txt', 'docs/a/b.md', 'packages/engine/x.ts', 'packages/enginex/y.ts', 'README.md',
  ]), ['src/keep.txt', 'docs/a/b.md', 'packages/engine/x.ts']);
  assert.equal(globToRegExp('*.md').test('a/b.md'), false);
  assert.equal(globToRegExp('**/*.md').test('a/b.md'), true);
});

test('resolveVerify follows the profile formats in use, then the Makefile', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-runner-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveVerify('- **Verify (DoD):** `make verify` = tsc + vitest\n- verify: `pnpm test`\n', dir), 'make verify');
  assert.equal(resolveVerify('- cwd for all commands: `orchestra/`\n- verify: `pnpm typecheck && pnpm test`\n', dir), 'pnpm typecheck && pnpm test');
  assert.equal(resolveVerify('## verify — Definition of Done\n```bash\nmake test && make lint     # uv run pytest\n```\n', dir), 'make test && make lint');
  assert.equal(resolveVerify('## Focus\nnothing here\n', dir), null);
  fs.writeFileSync(path.join(dir, 'Makefile'), 'verify: typecheck test\n');
  assert.equal(resolveVerify('## Focus\nnothing here\n', dir), 'make verify');
});

test('resolveInstall prefers the profile line, then make setup, then the lockfile', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-runner-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveInstall('', dir), null);
  fs.writeFileSync(path.join(dir, 'uv.lock'), '');
  assert.equal(resolveInstall('', dir), 'uv sync');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.equal(resolveInstall('', dir), 'pnpm install --frozen-lockfile --prefer-offline');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'setup:\n\tuv sync --all-extras\n');
  assert.equal(resolveInstall('', dir), 'make setup');
  assert.equal(resolveInstall('- install: `pnpm install --offline`\n', dir), 'pnpm install --offline');
});

test('cli parses run arguments and finds the control repo from the bin location', (t) => {
  assert.deepEqual(parseArgs(['run', 'acme', 'T-1', '--home', '/x']), { positional: ['run', 'acme', 'T-1'], options: { home: '/x' } });
  assert.throws(() => parseArgs(['run', '--bogus']), /unknown option --bogus/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-runner-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{}');
  assert.equal(resolveHome(undefined, {}, path.join(dir, 'bin')), dir);
  assert.equal(resolveHome(undefined, { RSTAFF_HOME: dir }, '/nowhere/bin'), dir);
  assert.throws(() => resolveHome('/nowhere', {}, '/nowhere/bin'), /cannot find the control repo/);
});
