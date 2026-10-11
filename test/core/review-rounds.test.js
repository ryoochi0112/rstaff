// Review-round counter tests — the breaker must remember whole-branch review
// rounds while keeping task-mode evidence visible without feeding the streak.
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const CORE = process.env.RSTAFF_CORE_ROOT || path.resolve(__dirname, '../../plugins/rstaff');
const R = require(path.join(CORE, 'scripts', 'lib-review-rounds.js'));

const CLI = path.join(CORE, 'scripts', 'lib-review-rounds.js');
const REVIEW_COMMAND = path.join(CORE, 'commands', 'review.md');
const FILLED_GOAL = 'consumers can run lifecycle queries without PII surviving erasure';
const FILLED_WHY = 'disclosure decisions have no single chokepoint';

function filledMemoFields() {
  return Object.fromEntries(
    Object.keys(R.MEMO_PLACEHOLDERS).map((field) => [field, `filled ${field} evidence`]),
  );
}

function memoFieldArgs(values, omittedField) {
  return Object.keys(R.MEMO_PLACEHOLDERS).flatMap((field) => (
    field === omittedField ? [] : [`--${field}`, values[field]]
  ));
}

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-review-rounds-'));
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-review-repo-'));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@e', '-c', 'user.name=t', ...args]);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'x'), 'x');
  git('add', 'x');
  git('commit', '-qm', 'x');
  return dir;
}

function record(home, repo, branch, mode, verdict, p0, p1) {
  return R.record(home, repo, branch, { mode, verdict, p0, p1 }, { cwd: home });
}

function writeState(home, repo, branch, state) {
  const file = R.statePath(home, repo, branch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function roundCLI(home, cwd, command, args = [], env = process.env) {
  const result = spawnSync(process.execPath, [
    CLI, command, '--repo', 'repo', '--branch', 'main', '--home', home, '--cwd', cwd, ...args,
  ], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function reusedCounterState() {
  return {
    repo: 'old/repo',
    branch: 'feat/alpha',
    rounds: [{
      n: 1,
      mode: 'whole',
      verdict: 'block',
      p0: 1,
      p1: 0,
      ts: '2026-08-28T00:00:00.000Z',
    }],
    streak: 1,
    tripped: false,
  };
}

test('S1: record stamps clean and edited working trees without changing the real index', () => {
  const home = mkHome();
  const repo = mkRepo();
  const details = { mode: 'whole', verdict: 'pass', p0: 0, p1: 0 };
  const index = path.join(repo, '.git', 'index');
  const originalIndex = fs.readFileSync(index);
  const first = R.record(home, 'repo', 'main', details, { cwd: repo }).rounds[0].tree;
  for (const field of ['head', 'tree', 'wtree']) assert.match(first[field], /^[0-9a-f]{40}$/);
  assert.equal(first.dirty, 0);
  assert.equal(first.wtree, first.tree);
  assert.deepEqual(fs.readFileSync(index), originalIndex);

  fs.writeFileSync(path.join(repo, 'x'), 'edited');
  const second = R.record(home, 'repo', 'main', details, { cwd: repo }).rounds[1].tree;
  assert.equal(second.dirty, 1);
  assert.notEqual(second.wtree, first.wtree);
  assert.deepEqual(fs.readFileSync(index), originalIndex);
  const task = R.record(home, 'repo', 'main', { ...details, mode: 'task' }, { cwd: repo });
  assert.deepEqual(task.rounds[2].tree, second);
});

test('S2: record off-repo persists a null tree and CLI warns once with --cwd', () => {
  const home = mkHome();
  const cwd = mkHome();
  const state = R.record(home, 'repo', 'main', { mode: 'whole', verdict: 'pass', p0: 0, p1: 0 }, { cwd });
  assert.equal(state.rounds.length, 1);
  assert.equal(state.rounds[0].tree, null);
  const result = spawnSync(process.execPath, [
    CLI, 'record', '--repo', 'repo', '--branch', 'cli', '--mode', 'whole', '--verdict', 'pass',
    '--cwd', cwd, '--home', home,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /rstaff:/);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  const recorded = JSON.parse(result.stdout);
  assert.equal(recorded.rounds.length, 1);
  assert.equal(recorded.rounds[0].tree, null);
});

test('S3: fingerprint and recorded stamps include untracked files and exclude ignored files', () => {
  const home = mkHome();
  const repo = mkRepo();
  const details = { mode: 'whole', verdict: 'pass', p0: 0, p1: 0 };
  const baseline = R.fingerprint(repo);
  fs.writeFileSync(path.join(repo, 'extra'), 'untracked');
  const untracked = R.fingerprint(repo);
  assert.notEqual(untracked.wtree, baseline.wtree);
  const recorded = R.record(home, 'repo', 'main', details, { cwd: repo });
  assert.deepEqual(recorded.rounds[0].tree, untracked);

  fs.unlinkSync(path.join(repo, 'extra'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'extra\n');
  execFileSync('git', ['-C', repo, 'add', '.gitignore']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'ignore extra']);
  const ignoredBaseline = R.fingerprint(repo);
  fs.writeFileSync(path.join(repo, 'extra'), 'ignored');
  const ignored = R.fingerprint(repo);
  assert.equal(ignored.wtree, ignoredBaseline.wtree);
  const next = R.record(home, 'repo', 'main', details, { cwd: repo });
  assert.deepEqual(next.rounds[1].tree, ignored);
});

test('S4: CLI status reports the tracked file edited after a whole PASS', () => {
  const home = mkHome();
  const repo = mkRepo();
  const recorded = roundCLI(home, repo, 'record', ['--mode', 'whole', '--verdict', 'pass']);
  assert.equal(Object.hasOwn(recorded, 'reviewed'), false);
  const file = R.statePath(home, 'repo', 'main');
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(path.join(repo, 'x'), 'edited after review');
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  const state = roundCLI(home, nested, 'status');
  assert.deepEqual(state.reviewed, {
    round: 1, verdict: 'pass', current: false, moved: ['x'], reason: 'working tree changed since round 1',
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'status must not persist reviewed');
});

test('S5: CLI status stays current when reviewed uncommitted edits are committed', () => {
  const home = mkHome();
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'x'), 'reviewed edit');
  const recorded = roundCLI(home, repo, 'record', ['--mode', 'whole', '--verdict', 'pass']);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'reviewed edit']);
  const state = roundCLI(home, repo, 'status');
  assert.notEqual(recorded.rounds[0].tree.head, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.deepEqual(state.reviewed, {
    round: 1, verdict: 'pass', current: true, moved: [], reason: 'working tree matches round 1',
  });
});

test('S6: CLI status names the legacy round when its tree stamp is absent', () => {
  const home = mkHome();
  const repo = mkRepo();
  fs.renameSync(path.join(repo, '.git'), path.join(home, 'saved-git'));
  for (const tree of [undefined, null, {}]) {
    writeState(home, 'repo', 'main', {
      repo: 'repo', branch: 'main', rounds: [{ n: 7, mode: 'whole', verdict: 'pass', tree }, { n: 8, mode: 'whole' }],
      streak: 0, tripped: false,
    });
    const state = roundCLI(home, repo, 'status');
    assert.deepEqual(state.reviewed, {
      round: 7, verdict: 'pass', current: null, moved: null, reason: 'round 7 has no tree stamp; re-run /review',
    });
  }
});

test('S7: CLI status reports an unavailable stored tree without a warning', () => {
  const home = mkHome();
  const repo = mkRepo();
  writeState(home, 'repo', 'main', {
    repo: 'repo', branch: 'main', rounds: [{ n: 3, mode: 'whole', verdict: 'pass', tree: { wtree: '1'.repeat(40) } }],
    streak: 0, tripped: false,
  });
  const state = roundCLI(home, repo, 'status');
  assert.equal(state.reviewed.round, 3);
  assert.equal(state.reviewed.current, false);
  assert.equal(state.reviewed.moved, null);
  assert.match(state.reviewed.reason, /unavailable/);
});

test('S8: CLI status keeps a whole BLOCK verdict after a task PASS', () => {
  const home = mkHome();
  const repo = mkRepo();
  roundCLI(home, repo, 'record', ['--mode', 'whole', '--verdict', 'block']);
  roundCLI(home, repo, 'record', ['--mode', 'task', '--verdict', 'pass']);
  let state = roundCLI(home, repo, 'status');
  assert.equal(state.reviewed.verdict, 'block');
  assert.equal(state.reviewed.round, 1);
  roundCLI(home, repo, 'record', ['--mode', 'whole', '--verdict', 'pass']);
  roundCLI(home, repo, 'reset', ['--reason', 'override']);
  state = roundCLI(home, repo, 'status');
  assert.equal(state.reviewed.verdict, 'pass');
  assert.equal(state.reviewed.round, 3);
  assert.equal(Object.hasOwn(roundCLI(home, repo, 'reset', ['--reason', 'override again']), 'reviewed'), false);
});

test('CLI status reports no whole review for fresh or task-only state', () => {
  const home = mkHome();
  const repo = mkRepo();
  const expected = { round: 0, verdict: null, current: null, moved: null, reason: 'no whole-branch review recorded' };
  assert.deepEqual(roundCLI(home, repo, 'status').reviewed, expected);
  roundCLI(home, repo, 'record', ['--mode', 'task', '--verdict', 'pass']);
  fs.renameSync(path.join(repo, '.git'), path.join(home, 'saved-git'));
  assert.deepEqual(roundCLI(home, repo, 'status').reviewed, expected);
});

test('CLI status reports null currency when a stamped cwd is no longer a git repo', () => {
  const home = mkHome();
  const repo = mkRepo();
  roundCLI(home, repo, 'record', ['--mode', 'whole', '--verdict', 'pass']);
  fs.renameSync(path.join(repo, '.git'), path.join(home, 'saved-git'));
  const result = spawnSync(process.execPath, [
    CLI, 'status', '--repo', 'repo', '--branch', 'main', '--home', home, '--cwd', repo,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /cannot fingerprint/);
  assert.deepEqual(JSON.parse(result.stdout).reviewed, {
    round: 1, verdict: 'pass', current: null, moved: null, reason: 'cwd is not a git repo',
  });
});

test('CLI record and status ignore inherited git directory, work tree, and index overrides', () => {
  const home = mkHome();
  const repo = mkRepo();
  const foreign = mkRepo();
  fs.writeFileSync(path.join(foreign, 'x'), 'foreign edit');
  execFileSync('git', ['-C', foreign, 'add', '-A']);
  const baseline = roundCLI(home, repo, 'record', ['--mode', 'whole', '--verdict', 'pass']).rounds[0].tree;
  const bin = path.join(home, 'bin');
  const log = path.join(home, 'git-env.jsonl');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  command: args[2], GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
}) + '\\n');
const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
  for (const [key, value] of Object.entries({
    GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: path.join(foreign, '.git', 'index'),
  })) {
    fs.writeFileSync(log, '');
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, [key]: value };
    const recorded = roundCLI(home, repo, 'record', ['--mode', 'whole', '--verdict', 'pass'], env);
    assert.deepEqual(recorded.rounds.at(-1).tree, baseline, key);
    fs.writeFileSync(path.join(repo, 'x'), 'local edit');
    const state = roundCLI(home, repo, 'status', [], env);
    assert.equal(state.reviewed.current, false, key);
    assert.deepEqual(state.reviewed.moved, ['x'], key);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(calls.some((call) => call.command === 'diff'));
    for (const call of calls) {
      assert.equal(call.GIT_DIR, undefined);
      assert.equal(call.GIT_WORK_TREE, undefined);
      if (['add', 'write-tree'].includes(call.command)) {
        assert.ok(call.GIT_INDEX_FILE);
        assert.notEqual(call.GIT_INDEX_FILE, path.join(foreign, '.git', 'index'));
      } else {
        assert.equal(call.GIT_INDEX_FILE, undefined);
      }
    }
    fs.writeFileSync(path.join(repo, 'x'), 'x');
  }
});

test('U1: record appends a round with its number, mode, verdict, and counts', () => {
  const home = mkHome();
  const state = record(home, 'ontos', 'feat-lifecycle-queries', 'whole', 'block', 1, 4);

  assert.deepEqual(state.rounds[0], {
    n: 1,
    mode: 'whole',
    verdict: 'block',
    p0: 1,
    p1: 4,
    ts: state.rounds[0].ts,
    tree: state.rounds[0].tree,
  });
  assert.match(state.rounds[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(fs.readFileSync(R.statePath(home, 'ontos', 'feat-lifecycle-queries'), 'utf8')), state);
});

test('U2: two consecutive whole-branch BLOCKs trip the breaker', () => {
  const home = mkHome();
  record(home, 'ontos', 'feat-queries', 'whole', 'block', 3, 23);
  const state = record(home, 'ontos', 'feat-queries', 'whole', 'block', 1, 4);

  assert.equal(state.streak, 2);
  assert.equal(state.tripped, true);
  assert.equal(state.rounds.length, 2);
});

test('U3: a PASS resets a BLOCK streak before a later BLOCK', () => {
  const home = mkHome();
  record(home, 'ontos', 'feat-queries', 'whole', 'block', 1, 2);
  record(home, 'ontos', 'feat-queries', 'whole', 'pass', 0, 0);
  const state = record(home, 'ontos', 'feat-queries', 'whole', 'block', 0, 1);

  assert.equal(state.streak, 1);
  assert.equal(state.tripped, false);
});

test('U4: five task-mode BLOCKs never increment the whole-branch streak', () => {
  const home = mkHome();
  let state;
  for (let i = 0; i < 5; i++) {
    state = record(home, 'repo', 'branch', 'task', 'block', 1, i);
  }

  assert.equal(state.rounds.length, 5);
  assert.equal(state.streak, 0);
  assert.equal(state.tripped, false);
});

test('U5: task-mode rounds are recorded and summarized as memo evidence', () => {
  const home = mkHome();
  record(home, 'repo', 'branch', 'task', 'pass', 0, 0);
  record(home, 'repo', 'branch', 'task', 'block', 1, 2);
  record(home, 'repo', 'branch', 'whole', 'block', 2, 3);
  const state = record(home, 'repo', 'branch', 'whole', 'block', 1, 1);
  const output = R.memo(state, { goal: 'ship the bounded fix' });

  assert.equal(state.rounds.filter((round) => round.mode === 'task').length, 2);
  assert.match(output, /Task-mode evidence: 2 verdicts recorded \(PASS, BLOCK\)\./);
});

test('U6: reset clears the streak and appends a reasoned override entry', () => {
  const home = mkHome();
  record(home, 'repo', 'branch', 'whole', 'block', 1, 0);
  record(home, 'repo', 'branch', 'whole', 'block', 1, 0);
  const state = R.reset(home, 'repo', 'branch', { reason: 'human chose to continue' });

  assert.equal(state.streak, 0);
  assert.equal(state.tripped, false);
  assert.deepEqual(state.rounds[2], {
    n: 3,
    mode: 'override',
    reason: 'human chose to continue',
    ts: state.rounds[2].ts,
  });
  assert.throws(() => R.reset(home, 'repo', 'branch', { reason: '' }), /reason/i);
  assert.throws(() => R.reset(home, 'repo', 'branch', {}), /reason/i);
});

test('U7: missing, corrupt, and unreadable state files return zero state', () => {
  const home = mkHome();
  const missing = R.read(home, 'repo', 'missing');
  assert.deepEqual(missing, { repo: 'repo', branch: 'missing', rounds: [], streak: 0, tripped: false });

  const corruptPath = R.statePath(home, 'repo', 'corrupt');
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, '{{{not json');
  assert.deepEqual(R.read(home, 'repo', 'corrupt'), {
    repo: 'repo', branch: 'corrupt', rounds: [], streak: 0, tripped: false,
  });

  const unreadablePath = R.statePath(home, 'repo', 'unreadable');
  fs.mkdirSync(unreadablePath, { recursive: true });
  assert.deepEqual(R.read(home, 'repo', 'unreadable'), {
    repo: 'repo', branch: 'unreadable', rounds: [], streak: 0, tripped: false,
  });
});

test('U8: repo and branch slugs cannot escape the review-rounds directory', () => {
  const home = mkHome();
  const root = path.resolve(home, 'var', 'review-rounds');
  const file = path.resolve(R.statePath(home, '../../etc', 'a/b'));
  const relative = path.relative(root, file);
  const repoRoot = path.resolve(root, 'repo');
  const branchTraversal = path.resolve(R.statePath(home, 'repo', '../../etc/passwd'));
  const branchRelative = path.relative(repoRoot, branchTraversal);

  assert.ok(file.startsWith(root + path.sep), `state path escaped root: ${file}`);
  assert.ok(!relative.split(path.sep).includes('..'), `state path contains traversal: ${file}`);
  assert.deepEqual(
    relative.split(path.sep),
    ['etc', path.basename(file)],
    `resolved state path has unexpected components: ${file}`,
  );
  assert.ok(
    branchRelative.split(path.sep).length === 1 && !branchRelative.split(path.sep).includes('..'),
    `branch traversal escaped the repo directory: ${branchTraversal}`,
  );
});

test('R1: branch key round-trips a generated corpus of branch names', () => {
  const home = mkHome();
  // Generate branch names from depth and segment values rather than asserting
  // a hand-maintained set of expected filenames. The derived assertion below
  // is the contract: decoding the key must recover the complete input.
  const branches = new Set(Array.from({ length: 64 }, (_, index) => {
    const depth = 1 + (index % 4);
    return Array.from({ length: depth }, (_, segment) => {
      const variant = (index + segment) % 5;
      if (variant === 0) return '..';
      if (variant === 1) return '.';
      if (variant === 2) return `日本語-${index}-${segment}`;
      return `segment-${index}-${segment}`;
    }).join('/');
  }));

  for (const branch of branches) {
    const file = R.statePath(home, 'repo', branch);
    assert.equal(
      Buffer.from(path.basename(file, '.json'), 'hex').toString('utf8'),
      branch,
      `branch key did not round-trip: ${branch}`,
    );
  }
});

test('R1: read migrates a legacy slug-key counter to the full branch key', () => {
  const home = mkHome();
  const repo = 'repo';
  const branch = 'feat/lifecycle-queries';
  const legacy = path.join(home, 'var', 'review-rounds', repo, 'lifecycle-queries.json');
  const legacyState = reusedCounterState();
  legacyState.rounds[0].p0 = 2;
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify(legacyState));

  const state = R.read(home, repo, branch);
  const expected = { ...legacyState, repo, branch };
  assert.deepEqual(
    {
      state,
      persisted: JSON.parse(fs.readFileSync(R.statePath(home, repo, branch), 'utf8')),
    },
    { state: expected, persisted: expected },
  );
  assert.equal(fs.existsSync(legacy), false, 'legacy counter remains after successful migration');
});

test('R1: record refreshes both persisted identity fields and the memo on a reused correct-key file', () => {
  const home = mkHome();
  const repo = 'new/repo';
  const branch = 'fix/alpha';
  // The file is at the requested full-key path, but its payload is from an
  // earlier owner. This is the reused-counter case write() must repair.
  writeState(home, repo, branch, reusedCounterState());
  const state = record(home, repo, branch, 'whole', 'block', 0, 1);
  const persisted = JSON.parse(fs.readFileSync(R.statePath(home, repo, branch), 'utf8'));
  const output = R.memo(state);

  assert.deepEqual({ repo: persisted.repo, branch: persisted.branch }, { repo, branch });
  assert.match(output, /on new\/repo\/fix\/alpha/);
});

test('R1: record refreshes the persisted repo identity on a reused correct-key file', () => {
  const home = mkHome();
  const repo = 'new/repo';
  const branch = 'fix/alpha';
  writeState(home, repo, branch, reusedCounterState());
  record(home, repo, branch, 'whole', 'block', 0, 1);
  const persisted = JSON.parse(fs.readFileSync(R.statePath(home, repo, branch), 'utf8'));

  assert.equal(persisted.repo, repo);
});

test('R1: record refreshes the persisted branch identity on a reused correct-key file', () => {
  const home = mkHome();
  const repo = 'new/repo';
  const branch = 'fix/alpha';
  writeState(home, repo, branch, reusedCounterState());
  record(home, repo, branch, 'whole', 'block', 0, 1);
  const persisted = JSON.parse(fs.readFileSync(R.statePath(home, repo, branch), 'utf8'));

  assert.equal(persisted.branch, branch);
});

test('R1: memo names the repo and branch from a reused counter file', () => {
  const home = mkHome();
  const repo = 'new/repo';
  const branch = 'fix/alpha';
  writeState(home, repo, branch, reusedCounterState());
  const state = record(home, repo, branch, 'whole', 'block', 0, 1);
  const output = R.memo(state);

  assert.match(output, /on new\/repo\/fix\/alpha/);
});

test('U9: memo includes the breaker heading, both round counts, context, and options', () => {
  const home = mkHome();
  record(home, 'ontos', 'feat-lifecycle-queries', 'whole', 'block', 3, 23);
  const state = record(home, 'ontos', 'feat-lifecycle-queries', 'whole', 'block', 1, 4);
  const output = R.memo(state);

  assert.match(output, /^## Review circuit breaker: 2 consecutive BLOCKs on ontos\/feat-lifecycle-queries$/m);
  assert.match(output, /^Round 2 verdict: BLOCK \(1 P0, 4 P1\) — round 1 was BLOCK \(3 P0, 23 P1\)\.$/m);
  assert.match(output, /^Goal \(restated\): <restate from the spec's acceptance criteria>$/m);
  assert.match(output, /^Why convergence is failing: rounds are fixing per-surface instances of what may be ONE structural gap — <name the single structural gap these rounds keep circling>\.$/m);
  assert.doesNotMatch(output, /disclosure decisions|chokepoint/);
  const contextual = R.memo(state, { why: 'the retry boundary is duplicated' });
  assert.match(contextual, /^Why convergence is failing: rounds are fixing per-surface instances of what may be ONE structural gap — the retry boundary is duplicated\.$/m);
  assert.match(output, /^Assumption to test:/m);
  assert.match(output, /^Options:$/m);
  assert.match(output, /^\s+A\. \/replan .*recommended/m);
  assert.match(output, /^\s+B\./m);
  assert.match(output, /^\s+C\./m);
});

test('memo obligation covers the module-derived command, mode, verdict, and trip cross-product', () => {
  for (const command of R.COMMANDS) {
    for (const mode of R.MODES) {
      for (const verdict of R.VERDICTS) {
        for (const tripped of [false, true]) {
          const expected = command === 'record' && mode === 'whole' && tripped
            ? { emits: true, requiresFilled: true }
            : command === 'status' && tripped
              ? { emits: true, requiresFilled: false }
              : { emits: false, requiresFilled: false };
          assert.deepEqual(
            R.memoObligation({ command, mode, verdict, tripped }),
            expected,
            `${command}/${mode}/${verdict}/tripped=${tripped}`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    R.memoObligation({ command: 'unknown', mode: 'unknown', tripped: true }),
    { emits: false, requiresFilled: false },
    'the obligation must be total outside the CLI allowlists',
  );
});

test('memo placeholder keys and parseArgs memo flags are symmetric', () => {
  const expectedFlags = Object.fromEntries(
    Object.keys(R.MEMO_PLACEHOLDERS).map((field) => [`--${field}`, field]),
  );
  assert.deepEqual(R.MEMO_FLAGS, expectedFlags);

  const sentinels = Object.fromEntries(
    Object.keys(R.MEMO_PLACEHOLDERS).map((field) => [field, `sentinel-${field}`]),
  );
  const parsed = R.parseArgs(['status', ...memoFieldArgs(sentinels)]);
  assert.deepEqual(
    Object.fromEntries(Object.keys(R.MEMO_FLAGS).map((flag) => [R.MEMO_FLAGS[flag], parsed[R.MEMO_FLAGS[flag]]])),
    sentinels,
  );
});

test('CLI status keeps a tripped counter readable without memo fields', () => {
  const home = mkHome();
  R.record(home, 'repo', 'branch', { mode: 'whole', verdict: 'block', p0: 1, p1: 0 }, { cwd: home });
  R.record(home, 'repo', 'branch', { mode: 'whole', verdict: 'block', p0: 0, p1: 1 }, { cwd: home });
  const result = spawnSync(process.execPath, [
    CLI, 'status', '--repo', 'repo', '--branch', 'branch', '--home', home, '--cwd', home,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, 'status must remain a non-throwing read');
  assert.notEqual(result.stdout, '', 'status must print the counter JSON even when tripped');
  assert.doesNotMatch(result.stdout, /## Review circuit breaker:/, 'status without valid fields must not emit a memo');
  assert.doesNotMatch(result.stdout, /Goal \(restated\):/, 'status must not expose placeholder memo fields');
  const state = JSON.parse(result.stdout);
  assert.deepEqual(
    { rounds: state.rounds.length, streak: state.streak, tripped: state.tripped },
    { rounds: 2, streak: 2, tripped: true },
  );
});

test('CLI refusal cases derive from every memo field and invalid-value class after recording', () => {
  const invalidValues = {
    missing: undefined,
    blank: '',
    whitespace: ' \t',
    literal: null,
  };

  for (const [field, placeholder] of Object.entries(R.MEMO_PLACEHOLDERS)) {
    for (const [kind, invalidValue] of Object.entries(invalidValues)) {
      const values = filledMemoFields();
      values[field] = kind === 'literal' ? placeholder : invalidValue;
      const omittedField = kind === 'missing' ? field : undefined;
      const home = mkHome();
      R.record(home, 'repo', 'branch', { mode: 'whole', verdict: 'block', p0: 1, p1: 0 }, { cwd: home });
      const result = spawnSync(process.execPath, [
        CLI, 'record', '--repo', 'repo', '--branch', 'branch', '--home', home, '--cwd', home,
        '--mode', 'whole', '--verdict', 'block', '--p0', '0', '--p1', '1',
        ...memoFieldArgs(values, omittedField),
      ], { encoding: 'utf8' });

      assert.notEqual(result.status, 0, `${field}/${kind} must refuse the memo`);
      assert.equal(result.stdout, '', `${field}/${kind} must not emit JSON or memo after refusal`);
      assert.match(result.stderr, new RegExp(`--${field} is missing or still a placeholder`));
      assert.match(result.stderr, /round was recorded/i, 'the refusal must disclose the successful append');
      assert.match(
        result.stderr,
        /status --repo repo --branch branch --goal .* --why /,
        'the refusal must direct the coordinator to status with filled memo fields',
      );
      assert.doesNotMatch(
        result.stderr,
        /(?:re-?run|retry)[^\n]*\brecord\b/i,
        'the refusal must not instruct a duplicate record append',
      );
      const state = JSON.parse(fs.readFileSync(R.statePath(home, 'repo', 'branch'), 'utf8'));
      assert.deepEqual(
        { rounds: state.rounds.length, streak: state.streak, tripped: state.tripped },
        { rounds: 2, streak: 2, tripped: true },
        'the verdict must be persisted before memo refusal',
      );
    }
  }
});

test('CLI records task-mode verdicts on a tripped branch without emitting a whole-branch memo', () => {
  const home = mkHome();
  R.record(home, 'repo', 'branch', { mode: 'whole', verdict: 'block', p0: 1, p1: 0 }, { cwd: home });
  R.record(home, 'repo', 'branch', { mode: 'whole', verdict: 'block', p0: 0, p1: 1 }, { cwd: home });
  const result = spawnSync(process.execPath, [
    CLI, 'record', '--repo', 'repo', '--branch', 'branch', '--home', home, '--cwd', home,
    '--mode', 'task', '--verdict', 'block', '--p0', '0', '--p1', '1',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /## Review circuit breaker:/);
  const state = JSON.parse(result.stdout);
  assert.equal(state.rounds.length, 3);
  assert.equal(state.rounds.at(-1).mode, 'task');
  assert.equal(state.streak, 2);
});

test('CLI task-mode records do not emit a memo even when every memo field is valid', () => {
  const home = mkHome();
  R.record(home, 'repo', 'branch', { mode: 'whole', verdict: 'block', p0: 1, p1: 0 }, { cwd: home });
  R.record(home, 'repo', 'branch', { mode: 'whole', verdict: 'block', p0: 0, p1: 1 }, { cwd: home });
  const result = spawnSync(process.execPath, [
    CLI, 'record', '--repo', 'repo', '--branch', 'branch', '--home', home, '--cwd', home,
    '--mode', 'task', '--verdict', 'block', '--p0', '0', '--p1', '1',
    ...memoFieldArgs(filledMemoFields()),
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /## Review circuit breaker:/);
  const state = JSON.parse(result.stdout);
  assert.equal(state.rounds.at(-1).mode, 'task');
});

test('CLI emits a filled memo when --goal and --why are supplied', () => {
  const home = mkHome();
  R.record(home, 'repo', 'branch', { mode: 'whole', verdict: 'block', p0: 1, p1: 0 }, { cwd: home });
  R.record(home, 'repo', 'branch', { mode: 'whole', verdict: 'block', p0: 0, p1: 1 }, { cwd: home });
  const result = spawnSync(process.execPath, [
    CLI, 'status', '--repo', 'repo', '--branch', 'branch', '--home', home, '--cwd', home,
    '--goal', FILLED_GOAL, '--why', FILLED_WHY,
  ], { encoding: 'utf8' });

  assert.match(
    result.stdout,
    /Goal \(restated\): consumers can run lifecycle queries without PII surviving erasure[\s\S]+Why convergence is failing:[\s\S]+disclosure decisions have no single chokepoint\./,
  );
  assert.doesNotMatch(result.stdout, /<[^>\n]+>/, 'a filled memo must contain no placeholder token');
});

test('review record instructions require memo values from the spec and rounds', () => {
  const text = fs.readFileSync(REVIEW_COMMAND, 'utf8');

  for (const [field, placeholder] of Object.entries(R.MEMO_PLACEHOLDERS)) {
    assert.ok(
      text.includes(`--${field} "${placeholder}"`),
      `review record instructions omit --${field}`,
    );
  }
  assert.match(
    text,
    /Before running `record`, replace both quoted angle-bracket values with a\s+filled restatement from the spec's acceptance criteria and one structural\s+gap supported by the actual rounds and their findings\. The CLI refuses to\s+emit a tripped memo while either value remains a placeholder\./,
  );
  assert.match(
    text,
    /Before handing it to the user, fill\s+`Goal \(restated\):` from the spec’s acceptance criteria and fill\s+`Why convergence is failing:` from the actual rounds and their findings\.\s+Use evidence from the spec and rounds only; do not invent either value and\s+never hand the placeholder text to the user unfilled\./,
  );
  assert.match(
    text,
    /If `record` exits non-zero after reporting that the round was recorded, do\s+not run `record` again; re-run `status --repo <repo> --branch <branch> --goal\s+"<filled goal>" --why "<filled why>"`\./,
  );
});

test('CLI rejects invalid modes, verdicts, and missing reset reasons', () => {
  const home = mkHome();
  const cases = [
    ['record', '--repo', 'repo', '--branch', 'branch', '--mode', 'bad', '--verdict', 'block'],
    ['record', '--repo', 'repo', '--branch', 'branch', '--mode', 'whole', '--verdict', 'bad'],
    ['reset', '--repo', 'repo', '--branch', 'branch'],
  ];

  for (const args of cases) {
    const result = spawnSync(process.execPath, [CLI, ...args, '--home', home, '--cwd', home], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${args[0]} unexpectedly succeeded`);
    assert.match(result.stderr, /mode|verdict|reason|usage/i);
  }
});

test('E2E: CLI status prints zero JSON, then tripped JSON and the same memo as record', () => {
  const home = mkHome();
  const common = [
    '--repo', 'acme-api', '--branch', 'feat/rate-limit', '--home', home, '--cwd', home,
    '--goal', FILLED_GOAL, '--why', FILLED_WHY,
  ];
  const empty = spawnSync(process.execPath, [CLI, 'status', ...common], { encoding: 'utf8' });

  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stderr, '');
  const emptyState = JSON.parse(empty.stdout);
  assert.equal(emptyState.streak, 0);
  assert.equal(emptyState.tripped, false);

  const first = spawnSync(process.execPath, [CLI, 'record', ...common, '--mode', 'whole', '--verdict', 'block', '--p0', '3', '--p1', '23'], { encoding: 'utf8' });
  const second = spawnSync(process.execPath, [CLI, 'record', ...common, '--mode', 'whole', '--verdict', 'block', '--p0', '1', '--p1', '4'], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);

  const status = spawnSync(process.execPath, [CLI, 'status', ...common], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const [statusJson, statusMemo] = status.stdout.split('\n\n');
  const statusState = JSON.parse(statusJson);
  assert.equal(statusState.streak, 2);
  assert.equal(statusState.tripped, true);
  assert.match(statusMemo, /## Review circuit breaker: 2 consecutive BLOCKs on acme-api\/feat\/rate-limit/);
  assert.match(statusMemo, /Goal \(restated\): consumers can run lifecycle queries without PII surviving erasure/);
  assert.doesNotMatch(statusMemo, /<[^>\n]+>/, 'the E2E memo must not contain a placeholder token');
  const [recordJson, recordMemo] = second.stdout.split('\n\n');
  const { reviewed, ...recordedState } = statusState;
  assert.deepEqual(recordedState, JSON.parse(recordJson));
  assert.deepEqual(reviewed, {
    round: 2, verdict: 'block', current: null, moved: null, reason: 'round 2 has no tree stamp; re-run /review',
  });
  assert.equal(statusMemo, recordMemo);
});

test('E1: CLI is silent for absent state but warns for corrupt state', () => {
  const home = mkHome();
  const common = ['--repo', 'repo', '--branch', 'branch', '--home', home, '--cwd', home];
  const missing = spawnSync(process.execPath, [CLI, 'status', ...common], { encoding: 'utf8' });

  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stderr, '');
  assert.equal(JSON.parse(missing.stdout).streak, 0);

  const corruptPath = R.statePath(home, 'repo', 'branch');
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, '{{{not json');
  const corrupt = spawnSync(process.execPath, [CLI, 'status', ...common], { encoding: 'utf8' });

  assert.equal(corrupt.status, 0, corrupt.stderr);
  assert.match(corrupt.stderr, /rstaff: cannot read review-round state/);
  assert.equal(JSON.parse(corrupt.stdout).streak, 0);
});

test('E2E: CLI records two BLOCKs with a memo, then reset untrips it', () => {
  const home = mkHome();
  const common = [
    '--repo', 'e2e-repo', '--branch', 'feat/e2e', '--home', home, '--cwd', home,
    '--goal', FILLED_GOAL, '--why', FILLED_WHY,
  ];
  const first = spawnSync(process.execPath, [CLI, 'record', ...common, '--mode', 'whole', '--verdict', 'block', '--p0', '3', '--p1', '23'], { encoding: 'utf8' });
  const second = spawnSync(process.execPath, [CLI, 'record', ...common, '--mode', 'whole', '--verdict', 'block', '--p0', '1', '--p1', '4'], { encoding: 'utf8' });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"tripped": true/);
  assert.match(second.stdout, /## Review circuit breaker: 2 consecutive BLOCKs on e2e-repo\/feat\/e2e/);
  assert.match(second.stdout, /Goal \(restated\): consumers can run lifecycle queries without PII surviving erasure/);
  assert.doesNotMatch(second.stdout, /<[^>\n]+>/, 'the record memo must not contain a placeholder token');
  assert.match(second.stdout, /\/replan/);

  const reset = spawnSync(process.execPath, [CLI, 'reset', ...common, '--reason', 'human override'], { encoding: 'utf8' });
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /"streak": 0/);
  assert.match(reset.stdout, /"tripped": false/);
});

// a task verdict with --label/--attempt is also appended to
// var/usage.jsonl so /rstaff-usage:spend can join it to the writer row and report pass rate per tier.
// The two tests that assert the appended usage row live in test/usage/review-verdict-usage.test.js
// (they need rstaff-usage; core alone writes no row, which V2 pins).
function usageRows(home) {
  const file = path.join(home, 'var', 'usage.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('V2 task record without label/attempt writes no usage row', () => {
  const home = mkHome();
  record(home, 'repo', 'main', 'task', 'pass', 0, 0);
  assert.equal(fs.existsSync(path.join(home, 'var', 'usage.jsonl')), false);
});

test('V3 label/attempt validation rejects partial, whole-mode, and bad attempts without recording', () => {
  const home = mkHome();
  const bad = [
    { mode: 'task', label: 'r/s/T1' },
    { mode: 'task', attempt: 1 },
    { mode: 'whole', label: 'r/s/T1', attempt: 1 },
    { mode: 'task', label: 'r/s/T1', attempt: 0 },
    { mode: 'task', label: 'r/s/T1', attempt: 1.5 },
    { mode: 'task', label: 'r/s/T1', attempt: 'abc' },
    { mode: 'task', label: '  ', attempt: 1 },
  ];
  for (const extra of bad) {
    assert.throws(() => R.record(home, 'repo', 'main',
      { verdict: 'pass', p0: 0, p1: 0, ...extra }, { cwd: home }), /label|attempt/, JSON.stringify(extra));
  }
  assert.equal(R.read(home, 'repo', 'main').rounds.length, 0);
  assert.equal(usageRows(home).length, 0);
});

test('V5 CLI with an invalid tag still records the untagged round, warns, and exits 0', () => {
  const home = mkHome();
  const result = spawnSync(process.execPath, [
    CLI, 'record', '--repo', 'repo', '--branch', 'main', '--home', home, '--cwd', mkRepo(),
    '--mode', 'task', '--verdict', 'pass', '--label', 'repo/feat/T1', '--attempt', '0',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /attempt/);
  const state = JSON.parse(result.stdout);
  assert.equal(state.rounds.length, 1);
  assert.equal(state.rounds[0].label, undefined);
  assert.equal(usageRows(home).length, 0);
});
