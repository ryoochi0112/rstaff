'use strict';
// End-to-end contract of `rstaff run` against a scratch product repo, a stub claude and a stub gh.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(ROOT, 'plugins/rstaff-engineer/scripts/runner');
const { run, EXIT } = require(path.join(RUNNER, 'run.js'));
const STUBS = path.join(ROOT, 'test/fixtures/runner');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=Runner Test', '-c', 'user.email=runner@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const JOB = (extra = '') => `# Job: T-1 — make done.txt exist
- repo: acme
- ticket: T-1

## What should be true when done
A file named done.txt exists at the repo root.

## Checks
1. \`test -f done.txt\` → exit 0
2. \`grep -q changed src/keep.txt\` → exit 1
3. \`cat done.txt\` → exit 0, output contains "done"

## Do not touch
- src/keep.txt

## Caps
- time: 30 minutes
- money: 5 USD
- worker turns: 12
- rounds: 3
${extra}`;

function fixture(t, { verify = 'test ! -f broken.txt', job = JOB(), remote = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-runner-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'control');
  const repo = path.join(root, 'acme');
  const origin = path.join(root, 'origin.git');
  const stub = path.join(root, 'stub');
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(home, 'var', 'jobs', 'acme', 'T-1'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.writeFileSync(path.join(home, 'profiles', 'acme.md'), `# acme\n**Repo:** \`${repo}\` — scratch\n\n## verify\n\`\`\`bash\n${verify}   # the test command\n\`\`\`\n`);
  fs.writeFileSync(path.join(home, 'var', 'jobs', 'acme', 'T-1', 'job.md'), job);
  fs.writeFileSync(path.join(repo, 'src', 'keep.txt'), 'untouched\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'acme\n');
  fs.writeFileSync(path.join(stub, 'verdicts.json'), '[]');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  if (remote) {
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');
  }
  const env = { ...process.env, RSTAFF_CLAUDE_BIN: path.join(STUBS, 'claude-stub.js'), RSTAFF_GH_BIN: path.join(STUBS, 'gh-stub.js'), STUB_DIR: stub,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  fs.writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = Runner Test\n\temail = runner@example.invalid\n[commit]\n\tgpgsign = false\n');
  const lines = [];
  const f = { root, home, repo, origin, stub, env, dir: path.join(home, 'var', 'jobs', 'acme', 'T-1'), lines };
  f.run = (overrides = {}) => run({ home, repo: 'acme', ticket: 'T-1', env: { ...env, ...(overrides.env || {}) }, out: (l) => lines.push(l), now: overrides.now });
  f.log = () => fs.readFileSync(path.join(f.dir, 'run.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  f.calls = () => fs.readdirSync(stub).filter((n) => /^call-\d+\.json$/.test(n)).sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(stub, n), 'utf8')));
  f.verdicts = (list) => fs.writeFileSync(path.join(stub, 'verdicts.json'), JSON.stringify(list));
  return f;
}
const steps = (log) => log.map((l) => `${l.step}:${l.result}`);

test('accept: worker edits, runner verifies, referee accepts, draft PR opens with job, receipts and reasons', async (t) => {
  const f = fixture(t);
  f.verdicts([{ verdict: 'accept', summary: 'A done marker now exists at the root.', reasons: ['done.txt exists and the checks are green'] }]);
  const result = await f.run();
  assert.equal(result.exit, EXIT.accepted, JSON.stringify(f.log(), null, 1));
  assert.deepEqual(steps(f.log()), ['prepare:worktree', 'worker:done', 'verify:green', 'checks:green', 'referee:accept', 'commit:' + result.detail.sha, 'push:ok', 'pr:draft', 'end:accepted']);
  assert.equal(result.detail.pr, 'https://github.com/example/acme/pull/7');
  for (const record of f.log()) {
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof record.costUsd, 'number');
    assert.equal(typeof record.elapsedMin, 'number');
  }
  assert.equal(f.log().at(-1).costUsd, 1, 'worker 0.5 + referee 0.5');
  // The branch reached origin with one commit whose message names the ticket.
  assert.equal(git(f.origin, 'log', '-1', '--format=%s', 'rstaff/t-1'), 'T-1: make done.txt exist');
  assert.match(git(f.origin, 'log', '-1', '--format=%b', 'rstaff/t-1'), /Co-Authored-By: Claude \(claude-stub-1\)/);
  assert.equal(git(f.origin, 'show', 'rstaff/t-1:done.txt'), 'done');
  // gh got a draft PR against main from the worktree, with the body file.
  const gh = JSON.parse(fs.readFileSync(path.join(f.stub, 'gh.json'), 'utf8'));
  assert.deepEqual(gh.args.slice(0, 7), ['pr', 'create', '--draft', '--base', 'main', '--head', 'rstaff/t-1']);
  assert.equal(gh.cwd, fs.realpathSync(path.join(f.dir, 'tree')));
  const body = fs.readFileSync(path.join(f.dir, 'pr-body.md'), 'utf8');
  // Short and structured: what changed, the verdict line, short reasons; receipts and job folded away.
  // "What changed" sits in a GitHub callout so it is the first thing a reviewer's eye lands on.
  assert.match(body, /^> \[!NOTE\]\n> \*\*What changed:\*\* A done marker now exists at the root\.\n\n\*\*Referee:\*\* accept · 1 round · [\d.]+ min · \$1\n\nWhy it passed:\n- done\.txt exists and the checks are green\n/);
  assert.match(body, /<details><summary>Receipts \(4 commands the runner ran\)<\/summary>\n\n\| command \| cwd \| exit \| head \| tree \|/);
  assert.match(body, /<details><summary>Job<\/summary>\n\n# Job: T-1 — make done\.txt exist/);
  assert.ok(body.indexOf('What changed') < body.indexOf('<details>'), 'the fold comes after the verdict');
  assert.ok(body.split('\n').filter((l) => l.trim()).length < 40, `the body stays short: ${body.split('\n').length} lines`);
  assert.match(body, /\| `test ! -f broken\.txt` \| \. \| 0 \(expected 0\) \| [0-9a-f]{7} \| [0-9a-f]{7} \|/);
  assert.match(body, /\| `grep -q changed src\/keep\.txt` \| \. \| 1 \(expected 1\) \|/);
  // Receipts carry command, exit, head and tree.
  const receipts = fs.readdirSync(path.join(f.dir, 'receipts')).sort();
  assert.deepEqual(receipts, ['r1-check-1.json', 'r1-check-1.out', 'r1-check-2.json', 'r1-check-2.out', 'r1-check-3.json', 'r1-check-3.out',
    'r1-diff.patch', 'r1-referee-prompt.md', 'r1-referee.json', 'r1-referee.out', 'r1-verify.json', 'r1-verify.out', 'r1-worker-prompt.md', 'r1-worker.json', 'r1-worker.out']);
  const verify = JSON.parse(fs.readFileSync(path.join(f.dir, 'receipts', 'r1-verify.json'), 'utf8'));
  assert.equal(verify.command, 'test ! -f broken.txt');
  assert.equal(verify.exit, 0);
  assert.match(verify.head, /^[0-9a-f]{40}$/);
  assert.match(verify.tree, /^[0-9a-f]{40}$/);
  assert.equal(verify.head, git(f.repo, 'rev-parse', 'main'), 'checks ran before the commit, on the base head');
  assert.notEqual(verify.tree, git(f.repo, 'rev-parse', 'main^{tree}'), 'the tree hash is the edited worktree, not HEAD');
  // Worker and referee were started with the agreed flags and prompts.
  const [worker, referee] = f.calls();
  assert.equal(worker.role, 'worker');
  assert.ok(worker.args.includes('--permission-mode') && worker.args[worker.args.indexOf('--permission-mode') + 1] === 'acceptEdits');
  assert.ok(worker.args.includes('--permission-prompts'));
  for (const call of [worker, referee]) {
    assert.ok(call.args.includes('--strict-mcp-config'), `${call.role} keeps MCP servers out`);
    assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], 'project', `${call.role} loads only project settings`);
  }
  assert.deepEqual(worker.args.slice(worker.args.indexOf('--max-turns'), worker.args.indexOf('--max-turns') + 4), ['--max-turns', '12', '--max-budget-usd', '5.00']);
  assert.match(worker.prompt, /Do not commit/);
  assert.ok(worker.prompt.endsWith(JOB()), 'the job text is the prompt body');
  assert.ok(!worker.prompt.includes('referee rejected'));
  assert.equal(referee.role, 'referee');
  assert.equal(referee.args[referee.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(referee.args[referee.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash', 'no Write or Edit tool exists for the referee');
  assert.ok(!referee.args.includes('--json-schema') && !referee.args.includes('--disallowedTools'), 'flags that defeat prompt caching stay out');
  assert.ok(referee.args.includes('Bash(git diff:*)') && referee.args.includes('Bash(cat:*)'));
  const allowed = referee.args.slice(referee.args.indexOf('--allowedTools') + 1);
  const allowedList = allowed.slice(0, allowed.findIndex((a) => a.startsWith('--')));
  assert.ok(allowedList.length > 5 && allowedList.every((a) => /^Bash\([a-z -]+:\*\)$/.test(a)), `the referee never gets unrestricted Bash: ${allowedList}`);
  assert.equal(referee.args[referee.args.indexOf('--max-budget-usd') + 1], '4.50', 'the referee gets what the worker left');
  assert.match(referee.prompt, /## Receipts\n\n- `test ! -f broken\.txt` \(cwd \.\) → exit 0 \(expected 0\)/);
  assert.match(referee.prompt, /## Diff\n\n```diff\ndiff --git a\/done\.txt b\/done\.txt/);
  assert.match(referee.prompt, /cannot edit anything/);
  assert.match(referee.prompt, /"summary": "\.\.\."/, 'the referee is asked for a one-sentence summary');
  assert.match(referee.prompt, /at most five/, 'and for few, short reasons');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'result.json'), 'utf8')).pr, 'https://github.com/example/acme/pull/7');
});

test('reject then accept: the second worker is told the referee reasons and the run ends accepted after two rounds', async (t) => {
  const f = fixture(t);
  f.verdicts([{ verdict: 'reject', reasons: ['done.txt must say done, not DONE'] }, { verdict: 'accept', reasons: ['fixed'] }]);
  const result = await f.run();
  assert.equal(result.exit, EXIT.accepted);
  assert.deepEqual(steps(f.log()).filter((s) => s.startsWith('worker') || s.startsWith('referee') || s.startsWith('end')),
    ['worker:done', 'referee:reject', 'worker:done', 'referee:accept', 'end:accepted']);
  const calls = f.calls();
  assert.equal(calls.length, 4);
  assert.match(calls[2].prompt, /A referee rejected the previous attempt\. Fix these reasons first:\n- done\.txt must say done, not DONE/);
  assert.equal(f.log().at(-1).round, 2);
  assert.ok(fs.existsSync(path.join(f.dir, 'receipts', 'r2-referee.json')));
});

test('three rejects: no commit, no PR, exit 2 with the last reasons', async (t) => {
  const f = fixture(t);
  f.verdicts([{ verdict: 'reject', reasons: ['r1'] }, { verdict: 'reject', reasons: ['r2'] }, { verdict: 'reject', reasons: ['r3'] }]);
  const result = await f.run();
  assert.equal(result.exit, EXIT.rejected);
  assert.deepEqual(result.detail, { rounds: 3, reasons: ['r3'] });
  assert.equal(f.calls().length, 6);
  assert.equal(git(f.repo, 'rev-parse', 'rstaff/t-1'), git(f.repo, 'rev-parse', 'main'), 'nothing committed');
  assert.equal(fs.existsSync(path.join(f.stub, 'gh.json')), false);
  assert.equal(spawnSync('git', ['-C', f.origin, 'rev-parse', '--verify', 'rstaff/t-1'], { encoding: 'utf8' }).status, 128, 'nothing pushed');
});

test('a referee answer that is not a verdict counts as reject', async (t) => {
  const f = fixture(t);
  f.verdicts([{ garbage: true }, { verdict: 'accept', reasons: ['ok'] }]);
  assert.equal((await f.run()).exit, EXIT.accepted);
  const first = f.log().find((l) => l.step === 'referee');
  assert.equal(first.result, 'reject');
  assert.match(first.detail.reasons[0], /referee gave no valid verdict: I cannot decide/);
  assert.equal(f.calls().length, 4, 'the garbage answer cost a second round');
  assert.equal(f.log().at(-1).round, 2);
});

test('red receipts skip the referee and go back to the worker with the command and its output', async (t) => {
  const f = fixture(t);
  f.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  const result = await f.run({ env: { STUB_WORKER_ACTION: 'break-verify' } });
  assert.equal(result.exit, EXIT.rejected);
  assert.deepEqual(steps(f.log()).slice(1, 6), ['worker:done', 'verify:red', 'checks:green', 'referee:skipped', 'worker:done']);
  assert.equal(f.calls().filter((c) => c.role === 'referee').length, 0, 'no referee money spent on a red tree');
  assert.ok(f.calls().every((c) => c.role === 'worker' && !c.args.includes('--tools')), 'workers keep the full tool set');
  assert.match(f.calls()[1].prompt, /the test command `test ! -f broken\.txt` exited 1/);
  const g = fixture(t);
  g.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  assert.equal((await g.run({ env: { STUB_WORKER_ACTION: 'touch-forbidden' } })).exit, EXIT.rejected);
  const firstChecks = g.log().find((l) => l.step === 'checks');
  assert.equal(firstChecks.result, 'red');
  assert.match(g.calls()[1].prompt, /check `grep -q changed src\/keep\.txt` exited 0, expected 1/);
  assert.match(g.calls()[1].prompt, /the worker changed a path the job forbids: src\/keep\.txt/);
  const h = fixture(t);
  assert.equal((await h.run({ env: { STUB_WORKER_ACTION: 'noop' } })).exit, EXIT.rejected);
  assert.deepEqual(steps(h.log()).slice(1, 3), ['worker:done', 'checks:skipped']);
  assert.match(h.calls()[1].prompt, /the worker changed nothing/);
});

test('a file outside the job\'s Files list goes back to the worker before any referee; without a list the same change is accepted', async (t) => {
  const f = fixture(t, { job: JOB('\n## Files\n- done.txt\n') });
  f.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  const result = await f.run({ env: { STUB_WORKER_ACTION: 'write-extra' } });
  assert.equal(result.exit, EXIT.rejected);
  assert.deepEqual(steps(f.log()).slice(1, 6), ['worker:done', 'verify:green', 'checks:green', 'files:outside', 'referee:skipped']);
  assert.equal(f.calls().filter((c) => c.role === 'referee').length, 0, 'no referee money on a change outside the list');
  assert.match(f.calls()[0].prompt, /Change only these files: done\.txt/);
  assert.match(f.calls()[1].prompt, /the worker changed a file the job does not list: extra\.txt \(the job allows: done\.txt\)/);
  assert.deepEqual(f.log().find((l) => l.step === 'files').detail, { outside: ['extra.txt'], allowed: ['done.txt'] });
  const g = fixture(t);
  g.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  assert.equal((await g.run({ env: { STUB_WORKER_ACTION: 'write-extra' } })).exit, EXIT.accepted, 'no Files section, no limit');
  assert.ok(!steps(g.log()).some((s) => s.startsWith('files:')), 'no files line without a list');
  assert.ok(!g.calls()[0].prompt.includes('Change only these files'));
});

test('a red test command is re-run once: green on the re-run counts and both receipts are kept; red twice stays red', async (t) => {
  const f = fixture(t, { verify: 'test -f $FLAKE || { touch $FLAKE; false; }' });
  f.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  const result = await f.run({ env: { FLAKE: path.join(f.root, 'flaked') } });
  assert.equal(result.exit, EXIT.accepted, JSON.stringify(f.log(), null, 1));
  assert.deepEqual(steps(f.log()).slice(1, 5), ['worker:done', 'verify:green after re-run', 'checks:green', 'referee:accept']);
  assert.deepEqual(f.log().find((l) => l.step === 'verify').detail, { command: 'test -f $FLAKE || { touch $FLAKE; false; }', exit: 0, firstExit: 1 });
  const first = JSON.parse(fs.readFileSync(path.join(f.dir, 'receipts', 'r1-verify.json'), 'utf8'));
  const again = JSON.parse(fs.readFileSync(path.join(f.dir, 'receipts', 'r1-verify-rerun.json'), 'utf8'));
  assert.equal(first.exit, 1); assert.equal(first.ok, false); assert.equal(first.attempt, undefined);
  assert.equal(again.exit, 0); assert.equal(again.ok, true); assert.equal(again.attempt, 2);
  const body = fs.readFileSync(path.join(f.dir, 'pr-body.md'), 'utf8');
  assert.match(body, /\| `test -f \$FLAKE \|\| \{ touch \$FLAKE; false; \}` \| \. \| 0 \(expected 0\) — second attempt; the first was red \|/);
  const referee = f.calls().find((c) => c.role === 'referee');
  assert.match(referee.prompt, /→ exit 0 \(expected 0\) — second attempt; the first was red/);
  const g = fixture(t, { verify: 'false' });
  g.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  assert.equal((await g.run()).exit, EXIT.rejected);
  assert.deepEqual(steps(g.log()).slice(1, 5), ['worker:done', 'verify:red', 'checks:green', 'referee:skipped']);
  assert.deepEqual(g.log().find((l) => l.step === 'verify').detail, { command: 'false', exit: 1, firstExit: 1 });
  assert.ok(fs.existsSync(path.join(g.dir, 'receipts', 'r1-verify-rerun.json')), 'the re-run is on record');
  assert.match(g.calls()[1].prompt, /the test command `false` exited 1, and 1 again on a re-run:/);
});

test('var/.STOP raised during a worker ends the worker at once; the run stops with its receipt on record', async (t) => {
  const f = fixture(t);
  f.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  const started = Date.now();
  const pending = f.run({ env: { STUB_SLEEP_MS: '30000', RSTAFF_RUNNER_STOP_POLL_MS: '100' } });
  setTimeout(() => fs.writeFileSync(path.join(f.home, 'var', '.STOP'), ''), 500);
  const result = await pending;
  assert.equal(result.exit, EXIT.stop, JSON.stringify(f.log(), null, 1));
  assert.ok(Date.now() - started < 15000, `the worker was ended, not waited for (${Date.now() - started} ms)`);
  assert.deepEqual(steps(f.log()).slice(-2), ['worker:stopped', 'end:stop']);
  assert.match(result.detail, /var\/\.STOP exists; the worker was ended/);
  const worker = JSON.parse(fs.readFileSync(path.join(f.dir, 'receipts', 'r1-worker.json'), 'utf8'));
  assert.equal(worker.stopped, true);
  assert.equal(worker.ok, false);
  assert.equal(f.calls().length, 1, 'no referee and no second worker after a stop');
  assert.equal(fs.existsSync(path.join(f.stub, 'gh.json')), false);
  assert.equal(spawnSync('git', ['-C', f.origin, 'rev-parse', '--verify', 'rstaff/t-1'], { encoding: 'utf8' }).status, 128, 'nothing pushed');
});

test('var/.STOP stops before the next step and nothing is spent', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'var', '.STOP'), '');
  const present = fs.existsSync(path.join(f.home, 'var', '.STOP'));
  const result = await f.run();
  assert.equal(result.exit, EXIT.stop, `STOP present before run: ${present}; log: ${JSON.stringify(f.log())}`);
  assert.deepEqual(steps(f.log()), ['end:stop']);
  assert.match(result.detail, /var\/\.STOP exists; stopped before prepare/);
  assert.equal(f.calls().length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'tree')), false);
});

test('the time cap stops the run and the worker gets at most the remaining time', async (t) => {
  const f = fixture(t);
  let clock = 1_000_000;
  const now = () => clock;
  f.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  const stepped = await run({ home: f.home, repo: 'acme', ticket: 'T-1', env: f.env, out: () => {}, now: () => { clock += 31 * 60000; return clock; } });
  assert.equal(stepped.exit, EXIT.time);
  assert.match(stepped.detail, /time cap 30 min reached before/);
  assert.equal(f.calls().length <= 1, true, 'the cap fires before the second claude call at the latest');
  const g = fixture(t, { job: JOB().replace('- time: 30 minutes', '- time: 0 minutes') });
  const immediate = await run({ home: g.home, repo: 'acme', ticket: 'T-1', env: g.env, out: () => {}, now });
  assert.equal(immediate.exit, EXIT.time);
  assert.deepEqual(steps(g.log()), ['end:time']);
});

test('the money cap stops the run once the recorded cost reaches it', async (t) => {
  const f = fixture(t, { job: JOB().replace('- money: 5 USD', '- money: 1 USD') });
  f.verdicts([{ verdict: 'reject', reasons: ['again'] }, { verdict: 'accept', reasons: ['ok'] }]);
  const result = await f.run({ env: { STUB_COST: '0.5' } });
  assert.equal(result.exit, EXIT.money);
  assert.match(result.detail, /money cap 1 USD reached before worker/);
  assert.equal(f.calls().length, 2, 'worker + referee spent the cap; the second worker never started');
  assert.equal(f.log().at(-1).costUsd, 1);
  const worker = f.calls()[0];
  assert.equal(worker.args[worker.args.indexOf('--max-budget-usd') + 1], '1.00');
});

test('a worker that cannot run (auth error, zero turns) ends the run as an error without retrying', async (t) => {
  const f = fixture(t);
  const result = await f.run({ env: { STUB_AUTH_ERROR: '1' } });
  assert.equal(result.exit, EXIT.error);
  assert.match(result.detail, /worker could not run: Failed to authenticate/);
  assert.equal(f.calls().length, 1);
});

test('after the progress threshold a green round writes a progress note before the referee', async (t) => {
  const f = fixture(t);
  f.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  assert.equal((await f.run({ env: { RSTAFF_RUNNER_PROGRESS_AFTER_MS: '0' } })).exit, EXIT.accepted);
  assert.ok(steps(f.log()).includes('progress:note'));
  const note = fs.readFileSync(path.join(f.dir, 'progress.md'), 'utf8');
  assert.match(note, /First working version after [\d.]+ min on T-1\./);
  assert.match(note, /Open: the worktree .*\/tree \(branch rstaff\/t-1\) or the patch .*r1-diff\.patch/);
  const g = fixture(t);
  g.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  await g.run();
  assert.equal(fs.existsSync(path.join(g.dir, 'progress.md')), false, 'a short run posts no progress note');
});

test('setup problems end the run as errors before anything is spent', async (t) => {
  const f = fixture(t, { job: JOB().replace('- repo: acme', '- repo: other') });
  const result = await f.run();
  assert.equal(result.exit, EXIT.error);
  assert.match(result.detail, /job\.md is for other T-1, not acme T-1/);
  const g = fixture(t);
  fs.writeFileSync(path.join(g.home, 'profiles', 'acme.md'), `**Repo:** \`${g.repo}\`\nno verify here\n`);
  assert.match((await g.run()).detail, /declares no verify command/);
  const h = fixture(t);
  git(h.repo, 'branch', 'rstaff/t-1');
  assert.match((await h.run()).detail, /branch rstaff\/t-1 already exists/);
  assert.equal(h.calls().length, 0);
});

test('no git identity: the run stops at setup before any worktree or worker is paid', async (t) => {
  const f = fixture(t);
  f.verdicts([{ verdict: 'accept', summary: 'x', reasons: ['x'] }]);
  const noIdentity = { GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '', EMAIL: '' };
  const result = await f.run({ env: noIdentity });
  assert.equal(result.kind, 'error');
  assert.match(result.detail, /no committer identity/);
  assert.deepEqual(steps(f.log()), ['setup:error', 'end:error']);
  assert.deepEqual(f.calls(), [], 'no worker or referee was started');
  assert.equal(fs.existsSync(path.join(f.dir, 'tree')), false, 'no worktree was made');
});

test('without an origin remote the commit stays on the branch and no PR is attempted', async (t) => {
  const f = fixture(t, { remote: false });
  f.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  const result = await f.run();
  assert.equal(result.exit, EXIT.accepted);
  assert.equal(result.detail.pr, null);
  assert.ok(steps(f.log()).includes('pr:skipped'));
  assert.equal(git(f.repo, 'log', '-1', '--format=%s', 'rstaff/t-1'), 'T-1: make done.txt exist');
  const body = fs.readFileSync(path.join(f.dir, 'pr-body.md'), 'utf8');
  assert.match(body, /^> \[!NOTE\]\n> \*\*What changed:\*\* make done\.txt exist\n/, 'without a referee summary the job title stands in');
});

test('bin/rstaff runs the CLI end to end and maps the result to the exit code', async (t) => {
  const f = fixture(t);
  f.verdicts([{ verdict: 'accept', reasons: ['ok'] }]);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'rstaff'), 'run', 'acme', 'T-1', '--home', f.home], { encoding: 'utf8', env: f.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /rstaff run acme T-1: accepted — .*pull\/7/);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'rstaff'), 'run', 'acme'], { encoding: 'utf8', env: f.env });
  assert.equal(bad.status, 64);
  assert.match(bad.stderr, /usage: rstaff run <repo> <ticket>/);
});
