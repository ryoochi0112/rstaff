// lib-state eng-collector tests — node:test, zero deps.
// The collector reads the control repo's engineering state: managed repos
// (product profiles) and active /dispatch runs. Strategy is not read here.
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require(path.join(__dirname, '..', '..', 'plugins', 'rstaff-backlog', 'scripts', 'lib-state.js'));
const HEALTH = path.join(__dirname, '..', '..', 'plugins', 'rstaff', 'scripts', 'health.js');

function mkControl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-state-'));
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profiles', 'proj-a.md'), '# proj-a\n**Repo:** `/tmp/proj-a` — a repo\n');
  fs.writeFileSync(path.join(dir, 'profiles', 'no-repo.md'), '# no-repo\nprofile with no Repo line — should be skipped\n');
  return dir;
}

function runHealth(home, { staticMode = true, env = {} } = {}) {
  const args = [HEALTH, ...(staticMode ? ['--static'] : []), '--json'];
  const result = spawnSync(process.execPath, args, {
    cwd: home,
    encoding: 'utf8',
    env: { ...process.env, RSTAFF_HOME: '', ...env },
  });
  assert.equal(result.error, undefined, 'health must spawn successfully');
  assert.ok(result.status === 0 || result.status === 1,
    `health exited unexpectedly (${result.status}); stderr: ${result.stderr}`);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`health did not emit JSON; stderr: ${result.stderr}\n${error.message}`);
  }
  const check = report.results.find((item) => item.check === 'dispatch state coverage');
  assert.ok(check, 'health must report dispatch state coverage');
  return { result, report, check };
}

function runStaticHealth(home, env = {}) {
  return runHealth(home, { env });
}

test('collect discovers managed repos from profiles/ incl. the control repo', () => {
  const home = mkControl();
  const d = S.collect(home);
  assert.ok(d.repos.some((r) => r.control === true), 'control repo included');
  assert.ok(d.repos.some((r) => r.path === '/tmp/proj-a' && r.slug === 'proj-a'), 'profile repo discovered');
  assert.ok(!d.repos.some((r) => r.slug === 'no-repo'), 'profile without a Repo line is skipped');
});

test('collect reads active dispatch status files from var/dispatch/', () => {
  const home = mkControl();
  const dd = path.join(home, 'var', 'dispatch', 'myapp');
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, 'greet.md'),
    '# myapp / greet\nstate: needs_human\nbranch: feat/greet\ntasks: 2/3 done (1 parked: T3)\nupdated: 2026-07-03T10:00+09:00\nnext_human_action: decide: exit-reason source\n');
  const d = S.collect(home);
  assert.equal(d.dispatch.length, 1);
  assert.equal(d.dispatch[0].slug, 'greet');
  assert.equal(d.dispatch[0].repo, 'myapp');
  assert.equal(d.dispatch[0].state, 'needs_human');
  assert.equal(d.dispatch[0].branch, 'feat/greet');
  assert.match(d.dispatch[0].tasks, /2\/3 done/);
  assert.equal(d.dispatch[0].next, 'decide: exit-reason source');
});

test('collect returns empty dispatch when none active', () => {
  assert.deepEqual(S.collect(mkControl()).dispatch, []);
});

test('a top-level brief without state is not a dispatch row', () => {
  const home = mkControl();
  const dd = path.join(home, 'var', 'dispatch', 'r');
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, 's.md'), '# r / s\nstate: building\n');
  fs.writeFileSync(path.join(dd, 's.T4.brief.md'), '# r / s T4\nbranch: feat/s\n');
  const rows = S.collectDispatch(home, { refsFor: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, 's');
});

test('a status-only file is not a dispatch row', () => {
  const home = mkControl();
  const dd = path.join(home, 'var', 'dispatch', 'r');
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, 's.md'), '# r / s\nstatus: building\n');
  assert.deepEqual(S.collectDispatch(home, { refsFor: null }), []);
});

test('/health --static warns for a top-level dispatch file without a parseable state', () => {
  const home = mkControl();
  mkRun(home, 'proj-a', 'good', '# proj-a / good\nstate: building\nbranch: feat/good\n');
  mkRun(home, 'proj-a', 'bad', '# proj-a / bad\nstatus: building\n');
  const realHome = fs.realpathSync(home);
  const good = path.join(realHome, 'var', 'dispatch', 'proj-a', 'good.md');
  const bad = path.join(realHome, 'var', 'dispatch', 'proj-a', 'bad.md');
  const { result, report, check } = runStaticHealth(home);
  assert.equal(result.status, 0);
  assert.equal(report.ok, true);
  assert.equal(check.status, 'WARN');
  assert.ok(check.note.includes(bad), `health note must name ${bad}`);
  assert.ok(!check.note.includes(good), `health note must not flag ${good}`);
  assert.match(check.note, /add a state: line, or move it to briefs\//);
});

test('/health full run fails for the same stateless dispatch file and names the fix', () => {
  const home = mkControl();
  mkRun(home, 'proj-a', 'bad', '# proj-a / bad\nstatus: building\n');
  const bad = path.join(fs.realpathSync(home), 'var', 'dispatch', 'proj-a', 'bad.md');
  const { result, check } = runHealth(home, { staticMode: false });
  assert.equal(result.status, 1);
  assert.equal(check.status, 'FAIL');
  assert.ok(check.note.includes(bad), `health note must name ${bad}`);
  assert.match(check.note, /add a state: line, or move it to briefs\//);
});

test('/health ignores dispatch files under briefs/', () => {
  const home = mkControl();
  const briefs = path.join(home, 'var', 'dispatch', 'r', 'briefs');
  fs.mkdirSync(briefs, { recursive: true });
  fs.writeFileSync(path.join(briefs, 'x.md'), '# r / x\nstatus: building\n');
  const { result, check } = runStaticHealth(home);
  assert.equal(result.status, 0);
  assert.equal(check.status, 'PASS');
});

test('/health passes without throwing when var/dispatch/ is absent', () => {
  const home = mkControl();
  const { result, check } = runStaticHealth(home);
  assert.equal(result.status, 0);
  assert.equal(check.status, 'PASS');
  assert.equal(runHealth(home, { staticMode: false }).check.status, 'PASS');
});

test('/health --static does not spawn git while scanning dispatch state', () => {
  const home = mkRun(mkControl(), 'proj-a', 'good',
    '# proj-a / good\nstate: building\nbranch: feat/good\n');
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-git-shim-'));
  const log = path.join(shimDir, 'git.log');
  const shim = path.join(shimDir, 'git');
  fs.writeFileSync(log, '');
  fs.writeFileSync(shim, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RSTAFF_GIT_LOG"\nexit 97\n');
  fs.chmodSync(shim, 0o755);

  const { result, check } = runStaticHealth(home, {
    PATH: `${shimDir}:${process.env.PATH}`,
    RSTAFF_GIT_LOG: log,
  });
  assert.equal(result.status, 0);
  assert.equal(check.status, 'PASS');
  assert.equal(fs.readFileSync(log, 'utf8'), '', 'static health must not invoke git');
});

test('collectRepos tolerates a missing profiles/ dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-noprof-'));
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{}');
  const repos = S.collectRepos(dir);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].control, true);
});

// --- rows are reconciled against git so a dead branch reads stale ---
// `refsFor` is the injected seam: a (repoDir) -> Set|null function. Passing a fake
// keeps these cases offline — no git, no gh, no network, zero process spawns.

function mkRun(home, repo, slug, body) {
  const dir = path.join(home, 'var', 'dispatch', repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), body);
  return home;
}

test('a row whose branch is absent from the live refs is marked stale', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: ready_for_review\nworktree: /x    branch: feat/gone\nnext_human_action: merge PR #39\n');
  const [row] = S.collect(home, { refsFor: () => new Set(['main', 'feat/other']) }).dispatch;
  assert.equal(row.ref, 'feat/gone');
  assert.equal(row.live, false);
});

test('a branch still present locally or on origin reads live', () => {
  const home = mkRun(mkControl(), 'r', 's', '# r / s\nstate: building\nbranch: feat/here\n');
  assert.equal(S.collectDispatch(home, { refsFor: () => new Set(['feat/here']) })[0].live, true);
  // origin/<branch> alone vouches for it: the local head may be checked out in a
  // sibling worktree, or the row may predate the local branch being created.
  assert.equal(S.collectDispatch(home, { refsFor: () => new Set(['origin/feat/here']) })[0].live, true);
});

test('staleness is never claimed without positive evidence', () => {
  const control = mkControl();
  mkRun(control, 'r', 'probe-failed', '# r / probe-failed\nstate: needs_human\nbranch: feat/x\n');
  assert.equal(S.collectDispatch(control, { refsFor: () => null })[0].live, null);

  // A value naming no ref, an absent key, and a placeholder are all unknown — and
  // none of them may cost a probe.
  for (const branch of ['branch: (deleted — merged to main)\n', '', 'branch: -\n']) {
    const home = mkRun(mkControl(), 'r', 's', `# r / s\nstate: shipped\n${branch}`);
    let calls = 0;
    const [row] = S.collectDispatch(home, { refsFor: () => { calls += 1; return new Set(); } });
    assert.equal(row.ref, '', `no ref parsed from ${JSON.stringify(branch)}`);
    assert.equal(row.live, null, `unknown, not stale, for ${JSON.stringify(branch)}`);
    assert.equal(calls, 0, `no probe for ${JSON.stringify(branch)}`);
  }
});

test('keys sharing a line with an earlier key are parsed, and trailing prose is not part of the ref', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: shipped\nworktree: /Users/x/p    branch: feat/mcp-2x (merged, deleted)\n'
    + 'last_commit: a1b2c3d    updated: 2026-09-08T12:20:00+09:00\n');
  const [row] = S.collectDispatch(home, { refsFor: null });
  assert.equal(row.branch, 'feat/mcp-2x (merged, deleted)');
  assert.equal(row.ref, 'feat/mcp-2x');
  assert.equal(row.updated, '2026-09-08T12:20:00+09:00');

  // A key AFTER branch on the same line ends the value; it is not swallowed into it.
  const brief = mkRun(mkControl(), 'r', 'b', '# r / b\nstate: building\ncwd: /Users/x/p    branch: fix/x    HEAD: b40837f\n');
  assert.equal(S.collectDispatch(brief, { refsFor: null })[0].branch, 'fix/x');
});

test('a bare-word leading token is unknown rather than a fabricated stale ref', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: building\nbranch: renamed to feat/new\n');
  let calls = 0;
  const [row] = S.collectDispatch(home, { refsFor: () => { calls += 1; return new Set(); } });
  assert.equal(row.ref, '');
  assert.equal(row.live, null);
  assert.equal(calls, 0, 'an unknown ref costs no probe');
});

test('an origin-prefixed branch is normalized before lookup', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: building\nbranch: origin/feat/x\n');
  const [row] = S.collectDispatch(home, { refsFor: () => new Set(['feat/x']) });
  assert.equal(row.ref, 'feat/x');
  assert.equal(row.live, true);
});

test('word-led trailing prose does not hide a slash-bearing branch ref', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: shipped\nbranch: feat/x pushed; gate green pre-push\n');
  const [row] = S.collectDispatch(home, { refsFor: () => new Set(['feat/x']) });
  assert.equal(row.ref, 'feat/x');
  assert.equal(row.live, true);
});

test('an indented branch inside block content is not parsed or probed', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: needs_human\nnext_human_action: |\n'
    + '  inspect the recorded outcome\n  branch: feat/ghost\n');
  let calls = 0;
  const [row] = S.collectDispatch(home, { refsFor: () => { calls += 1; return new Set(); } });
  assert.equal(row.ref, '');
  assert.equal(row.live, null);
  assert.equal(calls, 0, 'indented content costs zero probes');
});

test('a bare pipe collects and joins the following indented action lines', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: needs_human\nnext_human_action: |\n'
    + '  inspect the recorded outcome\n  run /review\n');
  const [row] = S.collectDispatch(home, { refsFor: null });
  assert.equal(row.next, 'inspect the recorded outcome run /review');
});

test('an indented next_human_action decoy in notes does not beat the real scalar', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: needs_human\nnotes: |\n'
    + '  schema reminder:\n'
    + '  next_human_action: none | run /review\n'
    + 'next_human_action: |\n'
    + '  merge PR #91\n');
  const [row] = S.collectDispatch(home, { refsFor: null });
  assert.equal(row.next, 'merge PR #91');
});

test('a single-line next_human_action remains unchanged', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: needs_human\nnext_human_action: run /review\n');
  const [row] = S.collectDispatch(home, { refsFor: null });
  assert.equal(row.next, 'run /review');
});

test('a block scalar at EOF without a trailing newline keeps its final line', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: needs_human\nnext_human_action: >\n  final action at EOF');
  const [row] = S.collectDispatch(home, { refsFor: null });
  assert.equal(row.next, 'final action at EOF');
});

test('an indented ## line stays content while a column-zero ## line ends the block', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: needs_human\nnext_human_action: |\n'
    + '  first action\n  ## content heading\n'
    + '## ship 2026-09-09\n  after the ship heading\nstate: shipped\n');
  const [row] = S.collectDispatch(home, { refsFor: null });
  assert.equal(row.next, 'first action ## content heading');
  assert.equal(row.state, 'shipped');
});

test('the live refs of a repo are probed at most once per run', () => {
  const home = mkControl();
  mkRun(home, 'r', 'one', '# r / one\nstate: building\nbranch: feat/one\n');
  mkRun(home, 'r', 'two', '# r / two\nstate: building\nbranch: feat/two\n');
  let calls = 0;
  const rows = S.collectDispatch(home, { refsFor: () => { calls += 1; return new Set(['feat/one']); } });
  assert.equal(rows.length, 2);
  assert.equal(calls, 1, 'one probe for the two rows sharing a repo');
});

test('a placeholder branch value is unknown, not a ref to look up', () => {
  for (const value of ['none', 'N/A', 'TBD', '-']) {
    const home = mkRun(mkControl(), 'r', 's', `# r / s\nstate: building\nbranch: ${value}\n`);
    let calls = 0;
    const [row] = S.collectDispatch(home, { refsFor: () => { calls += 1; return new Set(); } });
    assert.equal(row.ref, '', `${value} names no ref`);
    assert.equal(row.live, null, `${value} is unknown, never stale`);
    assert.equal(calls, 0, `${value} costs no probe`);
  }
});

// --- an appended later state block, past the read window ---
// Real runs end by an operator APPENDING a `## ship`/`## withdrawn` block rather than
// rewriting the file, so one file carries several `state:` lines. Both halves of this
// are load-bearing and neither is sufficient alone: last-match cannot see a block the
// read cap truncated away, and a raised cap still reports the stale value under
// first-match. The combined case below is the one the real store actually hit.

test('an appended later state block supersedes the first — last-match wins', () => {
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: ready_for_review\nbranch: feat/s\nnext_human_action: run /review\n'
    + '\n## ship 2026-08-15\nstate: shipped\npr: https://example.invalid/pull/17\n');
  assert.equal(S.collectDispatch(home, { refsFor: null })[0].state, 'shipped');

  // Three blocks: the LAST one is the truth, not merely a later one.
  const w = mkRun(mkControl(), 'r', 'w',
    '# r / w\nstate: ready_for_review\nbranch: feat/w\n'
    + '\n## ship 2026-08-15\nstate: shipped\n'
    + '\n## withdrawn 2026-08-15\nstate: withdrawn (operator decision)\n');
  assert.equal(S.collectDispatch(w, { refsFor: null })[0].state, 'withdrawn (operator decision)');
});

test('a verbose early value does not push later keys out of the read window', () => {
  // The 800-byte cap dropped `next_human_action:` on a real row whose `tasks:` ran long.
  const home = mkRun(mkControl(), 'r', 's',
    `# r / s\nstate: building\nbranch: feat/s\ntasks: ${'4/4 done, all reviewed. '.repeat(40)}\n`
    + 'next_human_action: inspect\n');
  const [row] = S.collectDispatch(home, { refsFor: null });
  assert.ok(row.tasks.length > 900, 'the early value really is long enough to have truncated');
  assert.equal(row.next, 'inspect');
});

test('a later state block BEYOND the old read window is still seen (042+043 together)', () => {
  // The shape of the two real casualties: `state: shipped` sat at char 1364 and 4064,
  // far past the old 800-byte cap. Reverting EITHER half fails this case.
  const notes = `notes: |\n${'  a reviewed task with a long note about its verify run.\n'.repeat(30)}`;
  const body = '# r / s\nstate: ready_for_review\nbranch: feat/s\n' + notes
    + '\n## ship 2026-08-15\nstate: shipped\n';
  const home = mkRun(mkControl(), 'r', 's', body);
  assert.ok(body.indexOf('state: shipped') > 800, 'the later block really is past the old cap');
  assert.equal(S.collectDispatch(home, { refsFor: null })[0].state, 'shipped');
});

test('a column-zero ship state after blank lines and long indented notes still wins', () => {
  const notes = `notes: |\n${'  purpose-built indented prose that remains content.\n'.repeat(30)}`;
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: ready_for_review\nbranch: feat/s\n\n' + notes
    + '\n\n## ship 2026-09-09\nstate: shipped\n');
  assert.equal(S.collectDispatch(home, { refsFor: null })[0].state, 'shipped');
});

test('last-match is scoped to state: — a repeated branch keeps its clean leading ref', () => {
  // The append block RESTATES the branch with prose ("feat/s pushed; gate green ...").
  // `state:` supersedes; `branch:` does not, so it stays first-match.
  const home = mkRun(mkControl(), 'r', 's',
    '# r / s\nstate: ready_for_review\nbranch: feat/s\ntasks: 4/4 done\n'
    + 'updated: 2026-08-15T13:56:00+09:00\nnext_human_action: run /review\n'
    + '\n## ship 2026-08-15\nstate: shipped\n'
    + 'branch: feat/s pushed; gate green pre-push; whole-branch /review PASS on record\n');
  const [row] = S.collectDispatch(home, { refsFor: () => new Set(['feat/s']) });
  assert.equal(row.state, 'shipped', 'state supersedes');
  assert.equal(row.branch, 'feat/s', 'branch does not');
  assert.equal(row.ref, 'feat/s');
  assert.equal(row.live, true);
});
