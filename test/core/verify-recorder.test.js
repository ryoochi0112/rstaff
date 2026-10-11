'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CORE = process.env.RSTAFF_CORE_ROOT || path.resolve(__dirname, '../../plugins/rstaff');
const { fingerprint } = require(path.join(CORE, 'scripts/lib-review-rounds.js'));
const { shellquote } = require(path.join(CORE, 'scripts/lib-gate.js'));
const { slug } = require(path.join(CORE, 'hooks/lib.js'));

const hook = path.join(CORE, 'hooks/verify-recorder.js');
const runner = path.join(CORE, 'scripts/verify-run.js');
const sid = 'verify-session_1';
const VALIDATE = `node '${path.join(fs.realpathSync(CORE), 'scripts/lib-backlog.js')}' validate`;
function isolation(root) {
  const home = path.join(root, 'home');
  const config = path.join(root, 'claude-config');
  fs.mkdirSync(home);
  fs.mkdirSync(config);
  return { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config };
}

function scratchRepo(root, name, recipe = 'true') {
  const top = path.join(root, name);
  fs.mkdirSync(top);
  fs.writeFileSync(path.join(top, 'Makefile'), `verify: ; @${recipe}\n`);
  fs.writeFileSync(path.join(top, 'tracked.txt'), 'before\n');
  for (const args of [['init', '-q', top], ['-C', top, 'add', 'Makefile', 'tracked.txt']]) {
    const r = spawnSync('git', args, { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stderr);
  }
  return top;
}
function fixture(t, recipe) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-verify-recorder-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctrl = path.join(root, 'control');
  fs.mkdirSync(path.join(ctrl, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(ctrl, 'rstaff.json'), '{"rstaff":"control-repo"}');
  const top = scratchRepo(root, 'Product Repo', recipe);
  return { root, ctrl, top, profile: path.join(ctrl, 'profiles', `${slug(top)}.md`),
    env: { PATH: process.env.PATH, RSTAFF_HOME: ctrl, TMPDIR: root, ...isolation(root) } };
}
function pmFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-pm-recorder-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctrl = path.join(root, 'control');
  fs.mkdirSync(path.join(ctrl, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(ctrl, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.writeFileSync(path.join(ctrl, '.gitignore'), 'var/\n');
  fs.writeFileSync(path.join(ctrl, 'backlog/acme.md'), '# Backlog — acme\n\n## PRODUCT-001: Test an idea\n'
    + '- status: open\n- pri: P1\n- route: plan\n- deps: -\n- source: hand\n'
    + '- filed: 2026-10-06\n- falsifier: -\n- cheapest-test: -\n- links: -\n- context: A testable idea.\n');
  const gitConfig = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  for (const [key, value] of Object.entries(gitConfig)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const f = { root, ctrl, top: ctrl,
    env: { PATH: process.env.PATH, RSTAFF_HOME: ctrl, TMPDIR: root, ...isolation(root), ...gitConfig } };
  for (const args of [['init', '-q'], ['add', '.'],
    ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']]) {
    const r = spawnSync('git', ['-C', ctrl, ...args], { encoding: 'utf8', env: f.env });
    assert.equal(r.status, 0, r.stderr);
  }
  return f;
}
function runHookRaw(f, input) {
  const r = spawnSync(process.execPath, [hook], {
    input, encoding: 'utf8', cwd: f.ctrl, env: f.env, timeout: 10000,
  });
  let out;
  try { out = JSON.parse(r.stdout); } catch (_) {}
  return { ...r, out };
}
function runHook(f, command, extra = {}) {
  return runHookRaw(f, JSON.stringify({
    session_id: sid, cwd: f.top, tool_name: 'Bash', tool_input: { command }, ...extra,
  }));
}
function rewritten(f, command, extra) {
  const r = runHook(f, command, extra);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.out?.hookSpecificOutput?.updatedInput, `missing rewrite: ${r.stdout} ${r.stderr}`);
  return r.out.hookSpecificOutput.updatedInput.command;
}
function runShell(f, command) {
  return spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd: f.top, env: f.env, timeout: 10000 });
}
function runWrapper(f, command, session = sid, cwd = f.top) {
  return spawnSync(process.execPath, [runner, session, command], {
    input: '{}', encoding: 'utf8', cwd, env: f.env, timeout: 10000,
  });
}
function stateFile(f, session = sid) { return path.join(f.ctrl, 'var', 'gate', `${session}.json`); }
function readState(f, session = sid) {
  const file = stateFile(f, session);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { v: 1, repos: {} };
}
function assertPass(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'passing recorder must emit no permission decision or updated input');
}

test('PM recorder wraps exactly the fallback validate command and records the control tree', (t) => {
  const f = pmFixture(t);
  const fp = fingerprint(f.ctrl);
  assert.ok(fp);
  assertPass(runHook(f, `${VALIDATE} --json`));
  const r = runHook(f, VALIDATE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const command = `node ${shellquote(path.join(fs.realpathSync(CORE), 'scripts/verify-run.js'))} ${shellquote(sid)} ${shellquote(VALIDATE)}`;
  assert.deepEqual(r.out, { hookSpecificOutput: { hookEventName: 'PreToolUse',
    updatedInput: { command },
  } });
  const green = runShell(f, command);
  assert.equal(green.status, 0, green.stderr);
  assert.equal(green.stdout, '');
  assert.equal(green.stderr, '');
  assert.deepEqual(readState(f).repos, { [f.ctrl]: { baseline: null, greens: [fp.wtree], blocks: {} } });
  assert.equal(fingerprint(f.ctrl).wtree, fp.wtree, 'recording a green must not change the control tree');
});

test('recorder resolves event cwd and preserves all tool input fields without a permission decision', (t) => {
  const f = fixture(t);
  const cwd = path.join(f.top, 'src');
  fs.mkdirSync(cwd);
  const tool_input = { command: 'make verify 2>&1 | tail -n 20', timeout: 1234, run_in_background: true,
    description: 'check the tree' };
  const r = runHook(f, tool_input.command, { cwd, tool_input });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.out, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: {
    ...tool_input, command: `node ${shellquote(runner)} ${shellquote(sid)} 'make verify' 2>&1 | tail -n 20`,
  } } });
});

test('successful rewritten verify appends the current tree and preserves existing session state', (t) => {
  const f = fixture(t);
  const fp = fingerprint(f.top);
  assert.ok(fp);
  const entry = { baseline: 'baseline', greens: ['older-green'], blocks: { old: 2 } };
  const state = { v: 1, repos: { [f.top]: entry, '/other': { baseline: null, greens: [], blocks: {} } } };
  fs.mkdirSync(path.dirname(stateFile(f)), { recursive: true });
  fs.writeFileSync(stateFile(f), JSON.stringify(state));
  const command = rewritten(f, 'make verify');
  for (let n = 1; n <= 2; n++) {
    const r = runShell(f, command);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(readState(f), { ...state, repos: { ...state.repos,
      [f.top]: { ...entry, greens: ['older-green', ...Array(n).fill(fp.wtree)] },
    } });
  }
});

test('failing verify piped to tail exits zero but records no green', (t) => {
  const f = fixture(t, 'false');
  const r = runShell(f, rewritten(f, 'make verify 2>&1 | tail -n 20'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Error/);
  assert.deepEqual(readState(f).repos, {});
  const direct = runWrapper(f, 'make verify');
  assert.equal(direct.status, 2, direct.stderr);
  assert.deepEqual(readState(f).repos, {});
});

test('recorder passes non-verify commands including node tests, quotes and heredocs', (t) => {
  const f = fixture(t);
  for (const command of ['node --test test/foo.test.js', 'make verifyx', 'echo "make verify"',
    'echo "a; make verify | cat"', 'echo make verify', 'echo make\\|verify',
    "cat <<'EOF'\nmake verify | cat\nEOF", 'echo $(make verify)']) {
    const r = runHook(f, command);
    assertPass(r);
    assert.equal(r.stderr, '', command);
  }
  assert.deepEqual(readState(f).repos, {});
});

test('calling the wrapper directly with a successful non-verify command refuses and records nothing', (t) => {
  const f = fixture(t);
  const r = runWrapper(f, 'true');
  assert.equal(r.status, 126, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /rstaff: verify-run refused: 'true'.*\(resolved: make verify\)/);
  assert.deepEqual(readState(f).repos, {});
  assert.equal(fs.existsSync(stateFile(f)), false);
});

test('wrapper refusal line carries no control characters from the argv', (t) => {
  const f = fixture(t);
  const r = runWrapper(f, 'make verify\x1b[2K\x1b[1A\tok\x7f\x9b\r\n');
  assert.equal(r.status, 126, r.stderr);
  assert.ok(r.stderr.endsWith('\n'), r.stderr);
  assert.doesNotMatch(r.stderr.slice(0, -1), /[\x00-\x1f\x7f-\x9f]/);
  assert.match(r.stderr, /rstaff: verify-run refused: 'make verify \[2K \[1A ok {4}'/);
});

test('wrapper refuses arbitrary argv before execution', async (t) => {
  for (const [name, command] of [
    ['node argv', 'node -e "require(\'fs\').writeFileSync(\'marker\',\'x\')"'],
    ['semicolon chain', 'echo PWNED > marker; echo hi'],
  ]) {
    await t.test(name, (t) => {
      const f = fixture(t);
      const r = runWrapper(f, command);
      assert.equal(fs.existsSync(path.join(f.top, 'marker')), false, `${name} must not execute`);
      assert.equal(r.status, 126, r.stderr);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.startsWith(`rstaff: verify-run refused: '${command}'`), r.stderr);
      assert.ok(r.stderr.includes(`for ${f.top} (resolved: make verify)`), r.stderr);
      assert.equal(r.stderr.trim().split('\n').length, 1);
      assert.deepEqual(readState(f).repos, {});
      assert.equal(fs.existsSync(stateFile(f)), false);
    });
  }
});

test('cd to another repo records only its runtime tree and rechecks its verify command', (t) => {
  const f = fixture(t);
  const other = scratchRepo(f.root, "Other's Repo");
  const command = rewritten(f, `cd ${shellquote(other)} && make verify`);
  const r = runShell(f, command);
  assert.equal(r.status, 0, r.stderr);
  const fp = fingerprint(other);
  assert.ok(fp);
  assert.deepEqual(readState(f).repos, { [other]: { baseline: null, greens: [fp.wtree], blocks: {} } });
  fs.writeFileSync(path.join(f.ctrl, 'profiles', `${slug(other)}.md`), '**Verify (DoD):** `true`\n');
  const secondSid = 'runtime-command-mismatch';
  const mismatch = runShell(f, rewritten(f, `cd ${shellquote(other)} && make verify`, { session_id: secondSid }));
  assert.equal(mismatch.status, 126, mismatch.stderr);
  assert.match(mismatch.stderr, /rstaff: verify-run refused: 'make verify'.*\(resolved: true\)/);
  assert.deepEqual(readState(f, secondSid).repos, {});
  assert.equal(fs.existsSync(stateFile(f, secondSid)), false);
});

test('verify that edits a tracked file records no green for either tree', (t) => {
  const f = fixture(t, 'printf changed-longer > tracked.txt');
  const before = fingerprint(f.top);
  assert.ok(before);
  const r = runShell(f, rewritten(f, 'make verify'));
  assert.equal(r.status, 0, r.stderr);
  const after = fingerprint(f.top);
  assert.ok(after);
  assert.notEqual(before.wtree, after.wtree);
  assert.equal(fs.readFileSync(path.join(f.top, 'tracked.txt'), 'utf8'), 'changed-longer');
  assert.deepEqual(readState(f).repos, {});
});

test('profile verify overrides make and shell quoting preserves the complete command', (t) => {
  const f = fixture(t, 'false');
  const command = "printf 'profile verify\\n'";
  fs.writeFileSync(f.profile, `**Verify (DoD):** \`${command}\`\n`);
  assertPass(runHook(f, 'make verify'));
  const r = runShell(f, rewritten(f, command));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'profile verify\n');
  const fp = fingerprint(f.top);
  assert.ok(fp);
  assert.deepEqual(readState(f).repos, { [f.top]: { baseline: null, greens: [fp.wtree], blocks: {} } });
});

test('wrapper inherits stdout and stderr, preserves exit status and treats a signal as failure', (t) => {
  const f = fixture(t);
  for (const [command, status] of [["printf 'out\\n'; printf 'err\\n' >&2; exit 7", 7], ['kill -TERM $$', 1]]) {
    fs.writeFileSync(f.profile, `**Verify (DoD):** \`${command}\`\n`);
    const r = runWrapper(f, command);
    assert.equal(r.status, status, r.stderr);
    if (status === 7) {
      assert.equal(r.stdout, 'out\n');
      assert.equal(r.stderr, 'err\n');
    }
    assert.deepEqual(readState(f).repos, {});
  }
});

test('recording errors only warn and preserve a successful verify status', (t) => {
  for (const fault of ['corrupt state', 'unwritable storage', 'invalid session id',
    'null initial fingerprint', 'null final fingerprint']) {
    const f = fixture(t);
    if (fault === 'corrupt state') {
      fs.mkdirSync(path.dirname(stateFile(f)), { recursive: true });
      fs.writeFileSync(stateFile(f), '{');
    }
    if (fault === 'unwritable storage') fs.writeFileSync(path.join(f.ctrl, 'var'), 'not a directory');
    if (fault === 'null initial fingerprint') {
      fs.rmSync(path.join(f.top, '.git', 'index'));
      fs.mkdirSync(path.join(f.top, '.git', 'index'));
    }
    if (fault === 'null final fingerprint') {
      fs.writeFileSync(path.join(f.top, 'Makefile'), 'verify: ; @rm .git/index && mkdir .git/index\n');
    }
    const r = runWrapper(f, 'make verify', fault === 'invalid session id' ? '../escape' : sid);
    assert.equal(r.status, 0, `${fault}: ${r.stderr}`);
    assert.match(r.stderr, fault.startsWith('null ')
      ? /rstaff: cannot fingerprint review tree:/ : /rstaff: cannot record verify:/, fault);
    assert.equal(r.stdout, '', fault);
    if (fault === 'corrupt state') assert.equal(fs.readFileSync(stateFile(f), 'utf8'), '{');
    else assert.equal(fs.existsSync(stateFile(f)), false, fault);
    assert.equal(fs.existsSync(path.join(f.ctrl, 'var', 'escape.json')), false);
  }
});

test('non-git cwd refuses verify and runs nothing', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.ctrl, 'Makefile'), 'verify: ; @printf x > marker\n');
  const r = runWrapper(f, 'make verify', sid, f.ctrl);
  assert.equal(fs.existsSync(path.join(f.ctrl, 'marker')), false, 'non-git verify must not execute');
  assert.equal(r.status, 126, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /rstaff: verify-run refused: 'make verify'.*\(resolved: none\)/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.deepEqual(readState(f).repos, {});
  assert.equal(fs.existsSync(stateFile(f)), false);
});

test('unreadable profile refuses verify and runs nothing', (t) => {
  const f = fixture(t, 'printf x > marker');
  fs.mkdirSync(f.profile);
  const r = runWrapper(f, 'make verify');
  assert.equal(fs.existsSync(path.join(f.top, 'marker')), false, 'unreadable profile verify must not execute');
  assert.equal(r.status, 126, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /rstaff: verify-run refused: 'make verify'.*\(resolved: none\).*EISDIR/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.deepEqual(readState(f).repos, {});
  assert.equal(fs.existsSync(stateFile(f)), false);
});

test('wrapper refuses a repo without a resolved verify command', (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.top, 'Makefile'));
  const r = runWrapper(f, 'echo PWNED > marker; echo hi');
  assert.equal(fs.existsSync(path.join(f.top, 'marker')), false);
  assert.equal(r.status, 126, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /rstaff: verify-run refused:.*\(resolved: none\)/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.deepEqual(readState(f).repos, {});
  assert.equal(fs.existsSync(stateFile(f)), false);
});

test('recorder passes non-Bash events and repos without a verify command', (t) => {
  const f = fixture(t);
  assertPass(runHook(f, 'make verify', { tool_name: 'Read' }));
  assertPass(runHookRaw(f, '{}'));
  fs.rmSync(path.join(f.top, 'Makefile'));
  const r = runHook(f, 'make verify');
  assertPass(r);
  assert.equal(r.stderr, '');
});

test('recorder passes malformed JSON and non-object events with a warning', (t) => {
  const f = fixture(t);
  for (const input of ['{"tool_input":', 'null', '[]', '123', '"x"']) {
    const r = runHookRaw(f, input);
    assertPass(r);
    assert.match(r.stderr, /rstaff: cannot record verify: malformed event input/);
  }
});

test('recorder passes internal resolution errors with a warning and no permission decision', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.profile);
  for (const extra of [{}, { cwd: f.ctrl }, { cwd: path.join(f.root, 'absent') }, { cwd: '' }]) {
    const r = runHook(f, 'make verify', extra);
    assertPass(r);
    assert.match(r.stderr, /rstaff: cannot record verify:/);
  }
  assert.deepEqual(readState(f).repos, {});
});

test('rstaff:nbgate profile: the expanded command is rewritten and the literal alias is not', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, '**Verify (DoD):** `rstaff:nbgate`\n');
  const expanded = `node ${shellquote(path.join(fs.realpathSync(CORE), 'scripts', 'nbgate.js'))}`;
  assert.equal(rewritten(f, expanded),
    `node ${shellquote(runner)} ${shellquote(sid)} ${shellquote(expanded)}`);
  assertPass(runHook(f, 'rstaff:nbgate'));
  assertPass(runHook(f, 'make verify'));
});
