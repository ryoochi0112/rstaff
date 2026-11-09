'use strict';
// `rstaff job <repo> <ticket>`: a read-only author turns the backlog ticket into job.md; a pre-flight
// baselines the checks on untouched main and finds files coupled to the allowed list, before any run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(ROOT, 'plugins/rstaff-engineer/scripts/runner');
const { authorJob, readTicket, coupledFiles, EXIT: JOB_EXIT } = require(path.join(RUNNER, 'author.js'));
const { run, EXIT } = require(path.join(RUNNER, 'run.js'));
const STUBS = path.join(ROOT, 'test/fixtures/runner');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=Runner Test', '-c', 'user.email=runner@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const TICKET = `## T-1: make done.txt exist
- status: open
- pri: P2
- route: build
- deps: -
- source: hand
- filed: 2026-11-09
- falsifier: The repo root has no done.txt, so the marker test is red.
- cheapest-test: test -f done.txt
- links: src/keep.txt
- context: Scratch ticket for the author tests.
`;
// What a good author answers: a job that lists the coupled test file as well as the file it creates.
const GOOD_JOB = `# Job: T-1 — a done marker exists at the root
- repo: acme
- ticket: T-1

## What should be true when done
A file named done.txt exists at the repo root and says done.

## Checks
1. \`test -f done.txt\` → exit 0
2. \`grep -q changed src/keep.txt\` → exit 1
3. \`cat done.txt\` → exit 0, output contains "done"

## Files
- done.txt
- test/marker.test.js

## Do not touch
- src/keep.txt

## Caps
- time: 30 minutes
- money: 5 USD
`;
const NARROW_JOB = GOOD_JOB.replace('- done.txt\n- test/marker.test.js\n', '- done.txt\n');
const BROKEN_JOB = GOOD_JOB.replace(/## Checks[\s\S]*?## Files/, '## Checks\n1. run the tests\n\n## Files');

function fixture(t, { ticket = TICKET } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-author-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'control');
  const repo = path.join(root, 'acme');
  const origin = path.join(root, 'origin.git');
  const stub = path.join(root, 'stub');
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(home, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(home, 'var'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.writeFileSync(path.join(home, 'profiles', 'acme.md'), `# acme\n**Repo:** \`${repo}\` — scratch\n\n## verify\n\`\`\`bash\ntest ! -f broken.txt   # the test command\n\`\`\`\n`);
  fs.writeFileSync(path.join(home, 'backlog', 'acme.md'), `# acme backlog\n\n## T-0: an older ticket\n- status: done\n- pri: P2\n\n${ticket}\n## T-2: another\n- status: open\n- pri: P2\n`);
  fs.writeFileSync(path.join(repo, 'src', 'keep.txt'), 'untouched\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'acme\n');
  // A test that pins the marker file: the author must list it or explain it.
  fs.writeFileSync(path.join(repo, 'test', 'marker.test.js'), "// expects done.txt to say done\n");
  fs.writeFileSync(path.join(stub, 'verdicts.json'), '[]');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  const env = { ...process.env, RSTAFF_CLAUDE_BIN: path.join(STUBS, 'claude-stub.js'), RSTAFF_GH_BIN: path.join(STUBS, 'gh-stub.js'), STUB_DIR: stub,
    STUB_JOB_TEXT: GOOD_JOB, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  fs.writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = Runner Test\n\temail = runner@example.invalid\n[commit]\n\tgpgsign = false\n');
  const lines = [];
  const f = { root, home, repo, origin, stub, env, lines, dir: path.join(home, 'var', 'jobs', 'acme', 'T-1') };
  f.author = (overrides = {}) => authorJob({ home, repo: 'acme', ticket: 'T-1', env: { ...env, ...(overrides.env || {}) }, out: (l) => lines.push(l) });
  f.calls = () => fs.readdirSync(stub).filter((n) => /^call-\d+\.json$/.test(n)).sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(stub, n), 'utf8')));
  return f;
}

test('readTicket finds one ticket block in the backlog with its fields; a missing id throws', (t) => {
  const f = fixture(t);
  const ticket = readTicket(f.home, 'acme', 'T-1');
  assert.equal(ticket.id, 'T-1');
  assert.equal(ticket.title, 'make done.txt exist');
  assert.equal(ticket.fields.falsifier, 'The repo root has no done.txt, so the marker test is red.');
  assert.equal(ticket.fields['cheapest-test'], 'test -f done.txt');
  assert.equal(ticket.fields.status, 'open');
  assert.match(ticket.text, /^## T-1: make done\.txt exist\n- status: open/);
  assert.ok(!ticket.text.includes('T-2'), 'the block ends at the next ticket');
  assert.throws(() => readTicket(f.home, 'acme', 'T-9'), /no ticket T-9 in backlog\/acme\.md/);
  assert.throws(() => readTicket(f.home, 'nope', 'T-1'), /backlog\/nope\.md/);
});

test('coupledFiles names repo files that mention an allowed path and are not on the list', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.repo, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'node_modules', 'x', 'a.js'), 'done.txt\n');
  fs.writeFileSync(path.join(f.repo, 'src', 'build.js'), '// writes done.txt from src/keep.txt\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-qm', 'more');
  const found = coupledFiles(f.repo, ['done.txt', 'test/marker.test.js']);
  assert.deepEqual(found, [{ path: 'src/build.js', mentions: ['done.txt'] }], 'tracked files only; the allowed files themselves and node_modules do not count');
  assert.deepEqual(coupledFiles(f.repo, []), []);
});

test('a good author answer becomes job.md, the pre-flight baselines the checks on main and finds no loose coupling', async (t) => {
  const f = fixture(t);
  const result = await f.author();
  assert.equal(result.exit, JOB_EXIT.ready, f.lines.join('\n'));
  const job = fs.readFileSync(path.join(f.dir, 'job.md'), 'utf8');
  assert.equal(job, GOOD_JOB);
  const pre = JSON.parse(fs.readFileSync(path.join(f.dir, 'preflight.json'), 'utf8'));
  assert.equal(pre.verdict, 'ready');
  assert.deepEqual(pre.baseline.map((b) => [b.command, b.ok]), [['test -f done.txt', false], ['grep -q changed src/keep.txt', true], ['cat done.txt', false]]);
  assert.deepEqual(pre.coupled, []);
  assert.equal(pre.auth.loggedIn, true);
  // The author ran read-only, in a scratch tree of main that is gone afterwards, with the ticket in its prompt.
  const [author] = f.calls();
  assert.equal(author.args[author.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');
  assert.ok(!author.args.includes('acceptEdits'));
  assert.match(author.prompt, /^You write the job for one ticket/);
  assert.match(author.prompt, /## T-1: make done\.txt exist\n- status: open/);
  assert.match(author.prompt, /test command.*`test ! -f broken\.txt`/);
  assert.match(author.prompt, /three to six checks/i);
  assert.equal(author.cwd, path.join(f.dir, 'author-tree'), 'the author worked in the scratch tree');
  assert.equal(fs.existsSync(path.join(f.dir, 'author-tree')), false, 'the scratch tree is removed');
  assert.equal(git(f.repo, 'worktree', 'list').split('\n').length, 1, 'no worktree left behind');
  assert.ok(fs.existsSync(path.join(f.dir, 'author', 'a1-prompt.md')));
  assert.ok(fs.existsSync(path.join(f.dir, 'author', 'a1-author.json')));
  // The report a human reads: title, checks with their baseline, files, coupling, caps, cost.
  const report = f.lines.join('\n');
  assert.match(report, /job: T-1 — a done marker exists at the root/);
  assert.match(report, /check 1: `test -f done\.txt` → red on main \(expected: turns green\)/);
  assert.match(report, /check 2: `grep -q changed src\/keep\.txt` → green on main/);
  assert.match(report, /files: done\.txt, test\/marker\.test\.js/);
  assert.match(report, /coupled files outside the list: none/);
  assert.match(report, /pre-flight: ready/);
});

test('a job that leaves a coupled file off its list gets a second author pass with the finding; a second miss is "needs a look"', async (t) => {
  const f = fixture(t);
  const result = await f.author({ env: { STUB_AUTHOR_FIRST: NARROW_JOB } });
  assert.equal(result.exit, JOB_EXIT.ready, f.lines.join('\n'));
  const calls = f.calls();
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /Your previous answer had these problems/);
  assert.match(calls[1].prompt, /test\/marker\.test\.js mentions done\.txt but is not under ## Files/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'job.md'), 'utf8'), GOOD_JOB);
  const g = fixture(t);
  const twice = await g.author({ env: { STUB_AUTHOR_FIRST: NARROW_JOB, STUB_JOB_TEXT: NARROW_JOB } });
  assert.equal(twice.exit, JOB_EXIT.look);
  const pre = JSON.parse(fs.readFileSync(path.join(g.dir, 'preflight.json'), 'utf8'));
  assert.equal(pre.verdict, 'needs a look');
  assert.deepEqual(pre.coupled, [{ path: 'test/marker.test.js', mentions: ['done.txt'] }]);
  assert.match(g.lines.join('\n'), /pre-flight: needs a look — test\/marker\.test\.js mentions done\.txt but is not under ## Files/);
  assert.equal(fs.readFileSync(path.join(g.dir, 'job.md'), 'utf8'), NARROW_JOB, 'the job is still written for the human to fix');
});

test('an answer that is not a runnable job gets one more pass naming the parse problem; two failures end as an error with no job.md', async (t) => {
  const f = fixture(t);
  const result = await f.author({ env: { STUB_AUTHOR_FIRST: BROKEN_JOB } });
  assert.equal(result.exit, JOB_EXIT.ready);
  assert.match(f.calls()[1].prompt, /check line not runnable: 1\. run the tests/);
  const g = fixture(t);
  const failed = await g.author({ env: { STUB_AUTHOR_FIRST: BROKEN_JOB, STUB_JOB_TEXT: BROKEN_JOB } });
  assert.equal(failed.exit, JOB_EXIT.error);
  assert.match(failed.detail, /check line not runnable/);
  assert.equal(fs.existsSync(path.join(g.dir, 'job.md')), false);
  assert.ok(fs.existsSync(path.join(g.dir, 'author', 'a2-author.out')), 'the answers stay on record');
});

test('checks that are all green on untouched main make the job "needs a look": there is nothing for the worker to turn green', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'done.txt'), 'done\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-qm', 'already done');
  git(f.repo, 'push', '-q', 'origin', 'main');
  const result = await f.author();
  assert.equal(result.exit, JOB_EXIT.look);
  assert.match(f.lines.join('\n'), /every check is already green on main/);
  assert.equal(f.calls().length, 2, 'the author was told once and could not change that');
});

test('a logged-out claude stops the author before any model call, and stops a run before any worktree', async (t) => {
  const f = fixture(t);
  const result = await f.author({ env: { STUB_LOGGED_OUT: '1' } });
  assert.equal(result.exit, JOB_EXIT.error);
  assert.match(result.detail, /claude is not logged in on this machine: run `claude auth login`/);
  assert.equal(f.calls().length, 0);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'job.md'), GOOD_JOB);
  const lines = [];
  const ran = await run({ home: f.home, repo: 'acme', ticket: 'T-1', env: { ...f.env, STUB_LOGGED_OUT: '1' }, out: (l) => lines.push(l) });
  assert.equal(ran.exit, EXIT.error);
  assert.match(ran.detail, /not logged in/);
  assert.equal(fs.existsSync(path.join(f.dir, 'tree')), false, 'no worktree made for a run that cannot start');
  assert.equal(f.calls().length, 0);
});

test('bin/rstaff job runs the author end to end and maps the pre-flight to the exit code', (t) => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'rstaff'), 'job', 'acme', 'T-1', '--home', f.home], { encoding: 'utf8', env: f.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pre-flight: ready/);
  assert.match(r.stdout, /rstaff job acme T-1: ready — .*job\.md/);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'rstaff'), 'job', 'acme'], { encoding: 'utf8', env: f.env });
  assert.equal(bad.status, 64);
  assert.match(bad.stderr, /usage: rstaff (run|job)/);
});
