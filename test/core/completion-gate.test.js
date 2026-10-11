'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CORE = process.env.RSTAFF_CORE_ROOT || path.resolve(__dirname, '../../plugins/rstaff');
const { fingerprint } = require(path.join(CORE, 'scripts/lib-review-rounds.js'));
const { slug } = require(path.join(CORE, 'hooks/lib.js'));
const { shellquote } = require(path.join(CORE, 'scripts/lib-gate.js'));
const VALIDATE = `node '${path.join(fs.realpathSync(CORE), 'scripts/lib-backlog.js')}' validate`;
function isolation(root) {
  const home = path.join(root, 'home');
  const config = path.join(root, 'claude-config');
  fs.mkdirSync(home);
  fs.mkdirSync(config);
  return { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config };
}

const HOOKS = path.join(CORE, 'hooks');
const sid = 'completion-session_1';
function git(f, ...args) {
  const r = spawnSync('git', ['-C', f.top, ...args], { encoding: 'utf8', env: f.env });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
function fixture(t, recipe = 'true') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-completion-gate-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctrl = path.join(root, 'control');
  const top = path.join(root, 'Product Repo');
  fs.mkdirSync(path.join(ctrl, 'profiles'), { recursive: true });
  fs.mkdirSync(top);
  fs.writeFileSync(path.join(ctrl, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.writeFileSync(path.join(top, 'Makefile'), `verify: ; @${recipe}\n`);
  fs.writeFileSync(path.join(top, 'tracked.txt'), 'before\n');
  fs.writeFileSync(path.join(top, '.gitignore'), 'ignored.txt\n');
  const f = { root, ctrl, top, profile: path.join(ctrl, 'profiles', `${slug(top)}.md`),
    env: { PATH: process.env.PATH, RSTAFF_HOME: ctrl, TMPDIR: root, ...isolation(root),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } };
  git(f, 'init', '-q');
  git(f, 'add', '.');
  git(f, '-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return f;
}
function runHookRaw(f, script, args, input, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, script), ...args], {
    input, encoding: 'utf8', cwd: f.ctrl, env: { ...f.env, ...env }, timeout: 10000,
  });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch (_) {}
  return { ...r, out };
}
function runHook(f, mode, extra = {}, env = {}) {
  return runHookRaw(f, 'completion-gate.js', [mode], JSON.stringify({ session_id: sid, cwd: f.top, ...extra }), env);
}
function file(f) { return path.join(f.ctrl, 'var', 'gate', `${sid}.json`); }
function readState(f) { return JSON.parse(fs.readFileSync(file(f), 'utf8')); }
function writeState(f, state) {
  fs.mkdirSync(path.dirname(file(f)), { recursive: true });
  fs.writeFileSync(file(f), typeof state === 'string' ? state : JSON.stringify(state));
}
function tree(f) {
  const fp = fingerprint(f.top);
  assert.ok(fp, 'scratch repo must fingerprint');
  return fp.wtree;
}
function edit(f) { fs.writeFileSync(path.join(f.top, 'tracked.txt'), 'edited after session start, longer\n'); }
function silent(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
}
function blocked(r, error) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.decision, 'block', r.stdout);
  if (error) assert.match(r.out.reason, error);
  assert.match(r.out.reason, /RSTAFF_GATE=off/);
  assert.match(r.out.reason, /SECURITY\.md/);
  assert.equal(r.out.systemMessage, undefined);
}
function golden(hash, { verify = 'make verify', baseline = 'edited since session start', green = 'none', count = 1 } = {}) {
  return `rstaff completion gate: this session changed the tree, but no green \`${verify}\` matches it.\n`
    + `  tree: ${hash.slice(0, 7)} (${baseline}) · last green: ${green}\n`
    + `  → run \`${verify}\`; the stop is allowed once it exits 0 on this tree.\n`
    + `  (block ${count}/3 · escape: RSTAFF_GATE=off — see SECURITY.md)`;
}
function verify(f, command = 'make verify', cwd = f.top) {
  const r = runHookRaw(f, 'verify-recorder.js', [], JSON.stringify({
    session_id: sid, cwd, tool_name: 'Bash', tool_input: { command },
  }));
  assert.equal(r.status, 0, r.stderr);
  const rewritten = r.out.hookSpecificOutput?.updatedInput?.command;
  assert.ok(rewritten, `expected real recorder rewrite: ${r.stdout} ${r.stderr}`);
  return spawnSync('sh', ['-c', rewritten], { cwd, env: f.env, encoding: 'utf8', timeout: 10000 });
}

function pmFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-pm-gate-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctrl = path.join(root, 'control');
  fs.mkdirSync(path.join(ctrl, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(ctrl, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.writeFileSync(path.join(ctrl, '.gitignore'), 'var/\n');
  const backlog = path.join(ctrl, 'backlog/acme.md');
  const ticket = '# Backlog — acme\n\n## PRODUCT-001: Test a product idea\n'
    + '- status: open\n- pri: P1\n- route: plan\n- deps: -\n- source: hand\n'
    + '- filed: 2026-10-06\n- falsifier: -\n- cheapest-test: -\n- links: -\n- context: A testable idea.\n';
  fs.writeFileSync(backlog, ticket);
  const gitConfig = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  // tree() fingerprints in-process; its git calls must use the fixture's config too.
  for (const [key, value] of Object.entries(gitConfig)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const f = { root, ctrl, top: ctrl, backlog, ticket,
    env: { PATH: process.env.PATH, RSTAFF_HOME: ctrl, TMPDIR: root, ...isolation(root), ...gitConfig } };
  git(f, 'init', '-q');
  git(f, 'add', '.');
  git(f, '-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return f;
}

for (const subdirectory of [false, true]) {
  test(`PM fallback: invalid backlog blocks until recorded validate passes (${subdirectory ? 'backlog cwd' : 'root cwd'})`, (t) => {
    const f = pmFixture(t);
    const cwd = subdirectory ? path.join(f.ctrl, 'backlog') : f.ctrl;
    silent(runHook(f, 'baseline', { cwd }));
    silent(runHook(f, 'stop', { cwd }));
    fs.writeFileSync(f.backlog, f.ticket.replace('- source: hand', '- source: interview'));
    const invalidTree = tree(f);
    const stop = runHook(f, 'stop', { cwd });
    blocked(stop);
    assert.equal(stop.out.reason, golden(invalidTree, { verify: VALIDATE }));
    const red = verify(f, VALIDATE, cwd);
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stdout, /PRODUCT-001: interview source requires falsifier/);
    assert.match(red.stdout, /PRODUCT-001: interview source requires cheapest-test/);
    assert.deepEqual(readState(f).repos[f.ctrl].greens, []);
    assert.equal(tree(f), invalidTree, 'gate state must be ignored by the tree fingerprint');
    const stillBlocked = runHook(f, 'stop', { cwd });
    blocked(stillBlocked);
    assert.equal(stillBlocked.out.reason, golden(invalidTree, { verify: VALIDATE, count: 2 }));
    fs.writeFileSync(f.backlog, fs.readFileSync(f.backlog, 'utf8')
      .replace('- falsifier: -', '- falsifier: Fewer than 3 of 5 users finish the task.')
      .replace('- cheapest-test: -', '- cheapest-test: Observe 5 users attempting the task.'));
    const fixedTree = tree(f);
    assert.notEqual(fixedTree, invalidTree);
    const green = verify(f, VALIDATE, cwd);
    assert.equal(green.status, 0, green.stderr);
    assert.equal(green.stdout, '');
    assert.equal(green.stderr, '');
    assert.deepEqual(readState(f).repos[f.ctrl].greens, [fixedTree]);
    silent(runHook(f, 'stop', { cwd }));
  });
}

// Commands outside verify (including inactive repos) must pass through unchanged.
function runOther(f, command = 'true', cwd = f.top) {
  const r = runHookRaw(f, 'verify-recorder.js', [], JSON.stringify({
    session_id: sid, cwd, tool_name: 'Bash', tool_input: { command },
  }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'non-verify commands must not be rewritten');
  return spawnSync('sh', ['-c', command], { cwd, env: f.env, encoding: 'utf8', timeout: 10000 });
}

test('AC 1: tracked edit without verify blocks with the byte-equal golden reason', (t) => {
  const f = fixture(t);
  silent(runHook(f, 'baseline'));
  edit(f);
  assert.equal(runOther(f).status, 0);
  const hash = tree(f);
  const r = runHook(f, 'stop');
  blocked(r);
  assert.equal(r.out.reason, golden(hash));
  assert.deepEqual(readState(f).repos[f.top].greens, []);
});

test('AC 2: green resolved verify on the edited tree allows Stop silently', (t) => {
  const f = fixture(t);
  silent(runHook(f, 'baseline'));
  edit(f);
  const hash = tree(f);
  const r = verify(f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readState(f).repos[f.top].greens, [hash]);
  silent(runHook(f, 'stop'));
});

test('AC 3: tracked and untracked changes invalidate green; ignored changes do not', (t) => {
  for (const change of ['tracked', 'untracked', 'ignored']) {
    const f = fixture(t);
    silent(runHook(f, 'baseline'));
    edit(f);
    const green = tree(f);
    const r = verify(f);
    assert.equal(r.status, 0, r.stderr);
    if (change === 'tracked') {
      fs.writeFileSync(path.join(f.top, 'tracked.txt'), 'a second, still longer tracked edit after the green verify\n');
    } else {
      fs.writeFileSync(path.join(f.top, change === 'ignored' ? 'ignored.txt' : 'new.txt'), 'after green\n');
    }
    const stop = runHook(f, 'stop');
    if (change === 'ignored') {
      assert.equal(tree(f), green);
      silent(stop);
    } else {
      assert.notEqual(tree(f), green);
      blocked(stop);
      assert.equal(stop.out.reason, golden(tree(f), { green: green.slice(0, 7) }));
    }
  }
});

test('AC 4: content commit and empty commit preserve green despite changing HEAD', (t) => {
  const f = fixture(t);
  silent(runHook(f, 'baseline'));
  edit(f);
  const r = verify(f);
  assert.equal(r.status, 0, r.stderr);
  const green = tree(f);
  let head = git(f, 'rev-parse', 'HEAD').stdout;
  git(f, 'add', 'tracked.txt');
  for (const message of ['commit verified content', 'empty commit']) {
    git(f, '-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', message);
    const next = git(f, 'rev-parse', 'HEAD').stdout;
    assert.notEqual(next, head);
    head = next;
    assert.equal(tree(f), green);
    silent(runHook(f, 'stop'));
  }
});

test('AC 5: failing verify stays red even when tail makes the pipeline exit zero', (t) => {
  const f = fixture(t, 'false');
  silent(runHook(f, 'baseline'));
  edit(f);
  const direct = verify(f);
  assert.notEqual(direct.status, 0);
  assert.deepEqual(readState(f).repos[f.top].greens, []);
  blocked(runHook(f, 'stop'));
  const piped = verify(f, 'make verify 2>&1 | tail -n 20');
  assert.equal(piped.status, 0, piped.stderr);
  assert.deepEqual(readState(f).repos[f.top].greens, []);
  blocked(runHook(f, 'stop'));
});

test('AC 6: a successful non-verify command never records green or allows an edit', (t) => {
  const f = fixture(t);
  silent(runHook(f, 'baseline'));
  edit(f);
  const r = runOther(f, 'node --version');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^v\d+/);
  assert.deepEqual(readState(f).repos[f.top].greens, []);
  blocked(runHook(f, 'stop'));
});

test('AC 7: a dirty start with no session changes allows Stop without green', (t) => {
  const f = fixture(t, 'false');
  edit(f);
  fs.writeFileSync(path.join(f.top, 'preexisting.txt'), 'already untracked at SessionStart\n');
  const baseline = tree(f);
  silent(runHook(f, 'baseline'));
  assert.equal(readState(f).repos[f.top].baseline, baseline);
  const r = verify(f);
  assert.notEqual(r.status, 0);
  assert.deepEqual(readState(f).repos[f.top].greens, []);
  silent(runHook(f, 'stop'));
});

test('AC 8: no verify command and non-git cwd allow with one exact inactive warning', (t) => {
  for (const nonGit of [false, true]) {
    const f = fixture(t);
    const cwd = nonGit ? f.ctrl : f.top;
    if (!nonGit) fs.rmSync(path.join(f.top, 'Makefile'));
    silent(runHook(f, 'baseline', { cwd }));
    if (!nonGit) edit(f);
    const r = runOther(f, 'true', cwd);
    assert.equal(r.status, 0, r.stderr);
    const stop = runHook(f, 'stop', { cwd });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(stop.stderr, '');
    assert.deepEqual(stop.out, { systemMessage: 'rstaff: no verify command — completion gate inactive' });
    assert.equal(stop.out.systemMessage.split('\n').length, 1);
  }
});

test('AC 9: corrupt state, missing baseline, bad sid and read-only git fail closed', async (t) => {
  for (const fault of ['corrupt state', 'missing baseline', 'bad sid']) {
    const f = fixture(t, 'false');
    silent(runHook(f, 'baseline'));
    // Leave the tree unchanged: losing the baseline must itself count as edited.
    const r = verify(f);
    assert.notEqual(r.status, 0);
    if (fault === 'corrupt state') writeState(f, '{');
    if (fault === 'missing baseline') fs.rmSync(file(f));
    const stop = runHook(f, 'stop', fault === 'bad sid' ? { session_id: '../bad' } : {});
    blocked(stop, fault === 'bad sid' ? /invalid session id/ : fault === 'corrupt state' ? /gate error:/ : /no session baseline/);
    if (fault === 'missing baseline') assert.equal(stop.out.reason, golden(tree(f), { baseline: 'no session baseline' }));
  }
  await t.test('read-only .git returns null fingerprint and blocks', {
    skip: process.getuid?.() === 0 ? 'root bypasses filesystem permissions' : false,
  }, (t) => {
    const f = fixture(t, 'false');
    silent(runHook(f, 'baseline'));
    assert.notEqual(verify(f).status, 0);
    // Use a new blob after verify, so an existing loose object cannot mask EACCES.
    edit(f);
    const modes = [];
    function lock(dir) {
      for (const name of fs.readdirSync(dir)) {
        const child = path.join(dir, name);
        if (fs.statSync(child).isDirectory()) lock(child);
      }
      modes.push([dir, fs.statSync(dir).mode & 0o777]);
      fs.chmodSync(dir, 0o555);
    }
    try {
      lock(path.join(f.top, '.git'));
      assert.equal(fingerprint(f.top), null);
      blocked(runHook(f, 'stop'), /null fingerprint/);
    } finally {
      for (const [dir, mode] of modes.reverse()) fs.chmodSync(dir, mode);
    }
  });
});

test('AC 10: three blocks name the escape then Stop gives up with byte-equal text', (t) => {
  const f = fixture(t, 'false');
  silent(runHook(f, 'baseline'));
  edit(f);
  assert.notEqual(verify(f).status, 0);
  const hash = tree(f);
  for (let count = 1; count <= 3; count++) {
    const r = runHook(f, 'stop', { stop_hook_active: true });
    blocked(r);
    assert.equal(r.out.reason, golden(hash, { count }));
  }
  const r = runHook(f, 'stop');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.out, { systemMessage: `rstaff completion gate gave up after 3 blocks: no green make verify on tree ${hash.slice(0, 7)} — this stop is NOT verified.` });
  assert.equal(readState(f).repos[f.top].blocks[hash], 4);
});

test('AC 11: RSTAFF_GATE=off allows an unverified edit with one warning per Stop', (t) => {
  const f = fixture(t, 'false');
  silent(runHook(f, 'baseline'));
  edit(f);
  assert.notEqual(verify(f).status, 0);
  for (let n = 0; n < 2; n++) {
    const r = runHook(f, 'stop', {}, { RSTAFF_GATE: 'off' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(r.out, { systemMessage: 'rstaff: completion gate disabled (RSTAFF_GATE=off) — see SECURITY.md' });
    assert.equal(r.out.systemMessage.split('\n').length, 1);
  }
  assert.deepEqual(readState(f).repos[f.top].blocks, {});
  assert.deepEqual(readState(f).repos[f.top].greens, []);
});

test('baseline writes only the first tree and preserves other evidence and repos', (t) => {
  const f = fixture(t);
  const entry = { baseline: null, greens: ['a'.repeat(40)], blocks: { older: 2 } };
  const other = { baseline: 'other', greens: [], blocks: {} };
  writeState(f, { v: 1, repos: { [f.top]: entry, '/other': other } });
  const hash = tree(f);
  silent(runHook(f, 'baseline'));
  assert.deepEqual(readState(f), { v: 1, repos: { [f.top]: { ...entry, baseline: hash }, '/other': other } });
  const before = fs.readFileSync(file(f), 'utf8');
  edit(f);
  silent(runHook(f, 'baseline'));
  assert.equal(fs.readFileSync(file(f), 'utf8'), before);
});

test('baseline errors warn but never block or exit nonzero', (t) => {
  for (const fault of ['malformed', 'sid', 'corrupt', 'fingerprint', 'save']) {
    const f = fixture(t);
    if (fault === 'corrupt') writeState(f, '{');
    if (fault === 'fingerprint') {
      fs.writeFileSync(path.join(f.top, '.git', 'index'), 'corrupt scratch index');
    }
    if (fault === 'save') fs.writeFileSync(path.join(f.ctrl, 'var'), 'not a directory');
    const r = fault === 'malformed'
      ? runHookRaw(f, 'completion-gate.js', ['baseline'], '{')
      : runHook(f, 'baseline', fault === 'sid' ? { session_id: '../bad' } : {});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /cannot record completion baseline/, fault);
  }
});

test('clean and already dirty trees are allowed without green verify when unchanged since baseline', (t) => {
  for (const dirty of [false, true]) {
    const f = fixture(t);
    if (dirty) edit(f);
    silent(runHook(f, 'baseline'));
    silent(runHook(f, 'stop'));
    assert.deepEqual(readState(f).repos[f.top].greens, []);
    assert.deepEqual(readState(f).repos[f.top].blocks, {});
  }
});

test('an edit after baseline blocks with the byte-equal golden reason even when stop_hook_active', (t) => {
  const f = fixture(t);
  silent(runHook(f, 'baseline'));
  edit(f);
  const hash = tree(f);
  const r = runHook(f, 'stop', { stop_hook_active: true });
  blocked(r);
  assert.equal(r.out.reason, golden(hash));
  assert.equal(readState(f).repos[f.top].blocks[hash], 1);
});

test('green verify permits Stop, ignored edits and a commit without content changes', (t) => {
  const f = fixture(t);
  silent(runHook(f, 'baseline'));
  edit(f);
  const r = verify(f);
  assert.equal(r.status, 0, r.stderr);
  silent(runHook(f, 'stop'));
  fs.writeFileSync(path.join(f.top, 'ignored.txt'), 'ignored content\n');
  silent(runHook(f, 'stop'));
  git(f, 'add', 'tracked.txt');
  git(f, '-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'content unchanged');
  silent(runHook(f, 'stop'));
});

test('tracked and untracked edits after green verify block and name the last green', (t) => {
  for (const untracked of [false, true]) {
    const f = fixture(t);
    silent(runHook(f, 'baseline'));
    assert.equal(verify(f).status, 0);
    const green = tree(f);
    if (untracked) fs.writeFileSync(path.join(f.top, 'new.txt'), 'new untracked file\n');
    else edit(f);
    const r = runHook(f, 'stop');
    blocked(r);
    assert.equal(r.out.reason, golden(tree(f), { green: green.slice(0, 7) }));
  }
});

test('missing baseline counts as edited and profile verify and newest green appear in the reason', (t) => {
  const f = fixture(t);
  const command = "printf 'profile verify\\n'";
  fs.writeFileSync(f.profile, `**Verify (DoD):** \`${command}\`\n`);
  const green = tree(f);
  const first = runHook(f, 'stop');
  blocked(first);
  assert.equal(first.out.reason, golden(green, { verify: command, baseline: 'no session baseline' }));
  writeState(f, { v: 1, repos: { [f.top]: { baseline: null,
    greens: ['a'.repeat(40), green], blocks: {} } } });
  edit(f);
  const r = runHook(f, 'stop');
  blocked(r);
  assert.equal(r.out.reason, golden(tree(f), { verify: command, baseline: 'no session baseline', green: green.slice(0, 7) }));
});

test('failed verify piped to tail and non-verify commands cannot allow an edited tree', (t) => {
  const f = fixture(t, 'false');
  silent(runHook(f, 'baseline'));
  edit(f);
  const r = verify(f, 'make verify 2>&1 | tail -n 20');
  assert.equal(r.status, 0, r.stderr);
  blocked(runHook(f, 'stop'));
  const other = runHookRaw(f, 'verify-recorder.js', [], JSON.stringify({
    session_id: sid, cwd: f.top, tool_name: 'Bash', tool_input: { command: 'true' },
  }));
  silent(other);
  const success = spawnSync('sh', ['-c', 'true'], { cwd: f.top, env: f.env, encoding: 'utf8' });
  assert.equal(success.status, 0);
  blocked(runHook(f, 'stop'));
  assert.deepEqual(readState(f).repos[f.top].greens, []);
});

test('three blocks persist per tree then give up with the byte-equal warning', (t) => {
  const f = fixture(t);
  silent(runHook(f, 'baseline'));
  edit(f);
  const hash = tree(f);
  for (let count = 1; count <= 3; count++) {
    const r = runHook(f, 'stop', { stop_hook_active: true });
    blocked(r);
    assert.equal(r.out.reason, golden(hash, { count }));
  }
  for (const count of [4, 5]) {
    const r = runHook(f, 'stop');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out, { systemMessage: `rstaff completion gate gave up after 3 blocks: no green make verify on tree ${hash.slice(0, 7)} — this stop is NOT verified.` });
    assert.equal(readState(f).repos[f.top].blocks[hash], count);
  }
  fs.writeFileSync(path.join(f.top, 'new.txt'), 'another tree\n');
  const next = runHook(f, 'stop');
  blocked(next);
  assert.equal(next.out.reason, golden(tree(f)));
});

test('off switch takes precedence over malformed input and storage errors and warns on one line', (t) => {
  const f = fixture(t);
  writeState(f, '{');
  const r = runHookRaw(f, 'completion-gate.js', ['stop'], '{', { RSTAFF_GATE: 'off' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { systemMessage: 'rstaff: completion gate disabled (RSTAFF_GATE=off) — see SECURITY.md' });
  assert.equal(r.out.systemMessage.split('\n').length, 1);
  assert.equal(fs.readFileSync(file(f), 'utf8'), '{');
});

test('non-git cwd and no verify command allow with the exact inactive warning before sid or state validation', (t) => {
  const f = fixture(t);
  writeState(f, '{');
  for (const cwd of [f.ctrl, f.top]) {
    fs.rmSync(path.join(f.top, 'Makefile'), { force: true });
    const r = runHook(f, 'stop', { cwd, session_id: null });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out, { systemMessage: 'rstaff: no verify command — completion gate inactive' });
  }
});

test('corrupt and unreadable state block even unchanged trees and skip the loop brake', (t) => {
  const f = fixture(t);
  silent(runHook(f, 'baseline'));
  for (const raw of ['{', '{"v":2,"repos":{}}']) {
    writeState(f, raw);
    for (let n = 0; n < 4; n++) blocked(runHook(f, 'stop'), /gate error:/);
    assert.equal(fs.readFileSync(file(f), 'utf8'), raw);
  }
  fs.rmSync(file(f));
  fs.mkdirSync(file(f));
  blocked(runHook(f, 'stop'), /EISDIR/);
});

test('invalid or missing session ids and malformed events fail closed', (t) => {
  const f = fixture(t);
  for (const session_id of [undefined, null, '', '../bad', 'x'.repeat(129), 123]) {
    blocked(runHook(f, 'stop', { session_id }), /invalid session id/);
  }
  for (const input of ['{', 'null', '[]']) {
    blocked(runHookRaw(f, 'completion-gate.js', ['stop'], input), /malformed event input/);
  }
  blocked(runHook(f, 'stop', { cwd: null }), /missing event cwd/);
  assert.equal(fs.existsSync(path.join(f.ctrl, 'var')), false);
});

test('null fingerprint and git, verify resolution or save errors block with the named error', (t) => {
  for (const fault of ['fingerprint', 'git', 'profile', 'save']) {
    const f = fixture(t);
    silent(runHook(f, 'baseline'));
    edit(f);
    if (fault === 'fingerprint') {
      fs.writeFileSync(path.join(f.top, '.git', 'index'), 'corrupt scratch index');
    }
    if (fault === 'profile') fs.mkdirSync(f.profile);
    if (fault === 'save') {
      fs.rmSync(path.join(f.ctrl, 'var'), { recursive: true });
      fs.writeFileSync(path.join(f.ctrl, 'var'), 'not a directory');
    }
    const r = runHook(f, 'stop', {}, fault === 'git' ? { PATH: f.root } : {});
    blocked(r, { fingerprint: /null fingerprint/, git: /ENOENT/, profile: /EISDIR/, save: /ENOTDIR/ }[fault]);
  }
});

test('dependency load errors in the real hook block Stop and still allow baseline', (t) => {
  const f = fixture(t);
  const script = path.join(f.root, 'completion-gate.js');
  fs.copyFileSync(path.join(HOOKS, 'completion-gate.js'), script);
  for (const mode of ['stop', 'baseline']) {
    const r = spawnSync(process.execPath, [script, mode], {
      input: JSON.stringify({ session_id: sid, cwd: f.top }),
      encoding: 'utf8', cwd: f.ctrl, env: f.env, timeout: 10000,
    });
    let out = {};
    try { out = JSON.parse(r.stdout); } catch (_) {}
    if (mode === 'stop') blocked({ ...r, out }, /Cannot find module/);
    else silent(r);
  }
});

test('manifest wires baseline, Stop and a separate Bash recorder with their required timeouts', () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  for (const [event, script, timeout, matcher] of [
    ['SessionStart', 'completion-gate.js" baseline', 10, '*'],
    ['Stop', 'completion-gate.js" stop', 15, '*'],
    ['PreToolUse', 'verify-recorder.js"', 5, 'Bash'],
  ]) {
    const entries = hooks[event].filter((entry) => entry.hooks.some((h) => h.command.endsWith(script)));
    assert.equal(entries.length, 1, script);
    assert.equal(entries[0].matcher, matcher);
    assert.equal(entries[0].hooks.length, 1, 'recorder and baseline must have their own entries');
    assert.deepEqual(entries[0].hooks[0], { type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${script}`, timeout });
  }
  const guard = hooks.PreToolUse.find((entry) => entry.hooks.some((h) => h.command.includes('/guard-bash.js')));
  assert.equal(guard.hooks.length, 1);
});

test('DS: rstaff:nbgate profile blocks a notebook edit until the expanded nbgate runs green via the recorder', (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.top, 'Makefile'));
  fs.writeFileSync(f.profile, '**Verify (DoD):** `rstaff:nbgate`\n');
  const notebook = (src) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{ cell_type: 'code', execution_count: 1, source: [src], outputs: [], metadata: {} }] });
  fs.writeFileSync(path.join(f.top, 'analysis.ipynb'), notebook('x = 1'));
  const py = path.join(f.root, 'stubpy');
  fs.writeFileSync(py, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  f.env.RSTAFF_NBGATE_PYTHON = py;
  const expanded = `node ${shellquote(path.join(fs.realpathSync(CORE), 'scripts', 'nbgate.js'))}`;
  silent(runHook(f, 'baseline'));
  fs.writeFileSync(path.join(f.top, 'analysis.ipynb'), notebook('x = 2  # edited after session start'));
  const hash = tree(f);
  const stop = runHook(f, 'stop');
  blocked(stop);
  assert.equal(stop.out.reason, golden(hash, { verify: expanded }));
  assert.ok(!stop.out.reason.includes('rstaff:nbgate'), stop.out.reason);
  const r = verify(f, expanded);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /analysis\.ipynb\s+counts ok · fresh run ok/);
  assert.equal(tree(f), hash, 'nbgate must leave the tree unchanged');
  assert.deepEqual(readState(f).repos[f.top].greens, [hash]);
  silent(runHook(f, 'stop'));
});
