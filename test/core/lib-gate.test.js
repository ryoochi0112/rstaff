'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE = process.env.RSTAFF_CORE_ROOT || path.resolve(__dirname, '../../plugins/rstaff');
const library = path.join(CORE, 'scripts/lib-gate.js');
const hooks = path.join(CORE, 'hooks/lib.js');
const { resolveVerify } = require(library);
const { slug } = require(hooks);
const VALIDATE = `node '${path.join(fs.realpathSync(CORE), 'scripts/lib-backlog.js')}' validate`;
const GIT_CONFIG = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
function isolation(root) {
  const home = path.join(root, 'home');
  const config = path.join(root, 'claude-config');
  fs.mkdirSync(home);
  fs.mkdirSync(config);
  return { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config };
}
// Spawn the actual library with strict JSON stdin, using the hook-test pattern.
const driver = `
  const lib = require(process.argv[1]);
  const hooks = require(process.argv[2]);
  try {
    const { event, malformed } = hooks.readEventStrict();
    if (malformed) throw new Error('malformed input');
    const args = event.args || [];
    if (event.op === 'resolveVerify') args[1] = hooks.resolveHome(process.cwd());
    process.stdout.write(JSON.stringify({ result: lib[event.op](...args), args }));
  } catch (error) {
    process.stderr.write(error.message);
    process.exit(1);
  }
`;
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-lib-gate-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctrl = path.join(root, 'control');
  const top = path.join(root, 'Product Repo');
  fs.mkdirSync(path.join(ctrl, 'profiles'), { recursive: true });
  fs.mkdirSync(top);
  fs.writeFileSync(path.join(ctrl, 'rstaff.json'), '{"rstaff":"control-repo"}');
  const env = { PATH: process.env.PATH, RSTAFF_HOME: ctrl, ...isolation(root), ...GIT_CONFIG };
  const git = spawnSync('git', ['init', top], { encoding: 'utf8', env });
  assert.equal(git.status, 0, git.stderr);
  return { ctrl, top, env, profile: path.join(ctrl, 'profiles', 'product-repo.md') };
}
function runHookRaw(f, input) {
  const r = spawnSync(process.execPath, ['-e', driver, library, hooks], {
    input, encoding: 'utf8', cwd: f.top,
    env: f.env, timeout: 10000,
  });
  let out;
  try { out = JSON.parse(r.stdout); } catch (_) {}
  return { ...r, out };
}
function runHook(f, op, ...args) { return runHookRaw(f, JSON.stringify({ op, args })); }
function result(f, op, ...args) {
  const r = runHook(f, op, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.out.result;
}

test('resolveVerify prefers the first profile span and uses the shared slug', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.top, 'Makefile'), 'verify:\n\tfalse\n');
  fs.writeFileSync(f.profile, '**Other:** `false`\n**Verify (DoD):** `npm test` then `make verify`\n');
  assert.equal(result(f, 'resolveVerify', f.top), 'npm test');
});

test('resolveVerify falls back only to an exact Makefile target', (t) => {
  const f = fixture(t);
  assert.equal(result(f, 'resolveVerify', f.top), null);
  fs.writeFileSync(f.profile, '**Verify (DoD):** no command\n');
  fs.writeFileSync(path.join(f.top, 'Makefile'), 'verify-more:\n\ttrue\n # verify:\n');
  assert.equal(result(f, 'resolveVerify', f.top), null);
  fs.writeFileSync(path.join(f.top, 'Makefile'), 'all:\n\ttrue\nverify:\n\ttrue\n');
  assert.equal(result(f, 'resolveVerify', f.top), 'make verify');
  fs.rmSync(f.profile);
  assert.equal(result(f, 'resolveVerify', f.top), 'make verify');
  fs.mkdirSync(f.profile);
  assert.equal(runHook(f, 'resolveVerify', f.top).status, 1, 'read errors propagate');
});

function fallbackFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-gate-fallback-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ISOLATION = isolation(root);
  // Direct resolveVerify calls inherit these settings for their check-ignore probe.
  for (const [key, value] of Object.entries(GIT_CONFIG)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  function repo(name) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'rstaff.json'), '{"rstaff":"control-repo"}');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'var/\n');
    const r = spawnSync('git', ['init', '-q', dir], {
      encoding: 'utf8', env: { PATH: process.env.PATH, ...ISOLATION, ...GIT_CONFIG },
    });
    assert.equal(r.status, 0, r.stderr);
    return dir;
  }
  const dir = repo('control');
  const env = { PATH: process.env.PATH, RSTAFF_HOME: dir, ...ISOLATION, ...GIT_CONFIG };
  return { root, dir, env, repo, ISOLATION };
}

test('fallback A: marker, same realpath and ignored var resolve backlog validate', (t) => {
  const f = fallbackFixture(t);
  assert.equal(resolveVerify(f.dir, f.dir), VALIDATE);
});

test('fallback B: ignored var and matching top without a marker stay inactive', (t) => {
  const f = fallbackFixture(t);
  fs.rmSync(path.join(f.dir, 'rstaff.json'));
  assert.equal(resolveVerify(f.dir, f.dir), null, 'missing marker must disable fallback');
});

test('fallback C: another marked control repo stays inactive', (t) => {
  const f = fallbackFixture(t);
  assert.equal(resolveVerify(f.dir, f.repo('other-control')), null, 'different realpaths must disable fallback');
});

test('fallback D: a symlink to the control repo resolves backlog validate', (t) => {
  const f = fallbackFixture(t);
  const ctrl = path.join(f.root, 'control-link');
  fs.symlinkSync(f.dir, ctrl, 'dir');
  assert.equal(resolveVerify(f.dir, ctrl), VALIDATE, 'symlinked control repo must resolve fallback');
});

test('fallback E: a nonexistent control repo returns null without throwing', (t) => {
  const f = fallbackFixture(t);
  assert.equal(resolveVerify(f.dir, path.join(f.root, 'nonexistent')), null);
});

test('fallback E: a realpath error on a marked repo returns null without throwing', (t) => {
  const f = fallbackFixture(t);
  t.mock.method(fs, 'realpathSync', () => { throw new Error('realpath failed'); });
  assert.equal(resolveVerify(f.dir, f.dir), null);
});

test('fallback F: a marked matching repo without ignored var stays inactive', (t) => {
  const f = fallbackFixture(t);
  fs.rmSync(path.join(f.dir, '.gitignore'));
  assert.equal(resolveVerify(f.dir, f.dir), null, 'var must be ignored before fallback can run');
});

test('fallback G: inherited git directory, worktree and index are stripped', (t) => {
  const f = fallbackFixture(t);
  const r = spawnSync(process.execPath, ['-e',
    'process.stdout.write(String(require(process.argv[1]).resolveVerify(process.argv[2], process.argv[2])));',
    library, f.dir], {
    cwd: f.dir, encoding: 'utf8', timeout: 10000,
    env: { ...f.env, GIT_DIR: '/nonexistent/.git', GIT_WORK_TREE: '/nonexistent', GIT_INDEX_FILE: '/nonexistent/index' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, VALIDATE, 'git environment must not redirect the fallback probe');
});

test('fallback H: profile and Makefile verify commands retain precedence', (t) => {
  const f = fallbackFixture(t);
  fs.mkdirSync(path.join(f.dir, 'profiles'));
  const profile = path.join(f.dir, 'profiles', `${slug(f.dir)}.md`);
  fs.writeFileSync(profile, '**Verify (DoD):** `npm test`\n');
  fs.writeFileSync(path.join(f.dir, 'Makefile'), 'verify:\n\ttrue\n');
  assert.equal(resolveVerify(f.dir, f.dir), 'npm test');
  fs.rmSync(profile);
  assert.equal(resolveVerify(f.dir, f.dir), 'make verify');
});

test('fallback I: an unborn HEAD resolves backlog validate', (t) => {
  const f = fallbackFixture(t);
  const head = spawnSync('git', ['-C', f.dir, 'rev-parse', '--verify', 'HEAD'], { env: f.env });
  assert.equal(head.status, 128, 'fixture must have no commit');
  assert.equal(resolveVerify(f.dir, f.dir), VALIDATE);
});

test('fallback J: core paths with an apostrophe and space run through sh', (t) => {
  const f = fallbackFixture(t);
  const parent = path.join(f.root, "co're dir");
  const copy = path.join(parent, 'rstaff');
  fs.mkdirSync(parent);
  const copied = spawnSync('cp', ['-R', CORE, copy], { encoding: 'utf8' });
  assert.equal(copied.status, 0, copied.stderr);
  const command = require(path.join(copy, 'scripts/lib-gate.js')).resolveVerify(f.dir, f.dir);
  assert.ok(command, 'copied core must resolve fallback');
  const r = spawnSync('sh', ['-c', command], {
    cwd: f.dir, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, RSTAFF_HOME: f.dir, ...f.ISOLATION },
  });
  assert.equal(r.status, 0, `quoted fallback must execute: ${r.stderr}`);
  assert.equal(r.stdout, '', 'zero tickets validate successfully');
});

test('fallback: a git spawn error returns null without throwing', (t) => {
  const f = fallbackFixture(t);
  const previous = process.env.PATH;
  process.env.PATH = path.join(f.root, 'no-executables');
  try { assert.equal(resolveVerify(f.dir, f.dir), null); }
  finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test('validSid and statePath enforce type, character and length boundaries', (t) => {
  const f = fixture(t);
  for (const sid of ['a', 'Session-1_2', 'x'.repeat(128)]) {
    assert.equal(result(f, 'validSid', sid), true);
    assert.equal(result(f, 'statePath', f.ctrl, sid), path.join(f.ctrl, 'var', 'gate', `${sid}.json`));
  }
  for (const sid of ['', 'x'.repeat(129), '../escape', 'a/b', 'a b', 'é', 'a\n', null, 123, ['abc']]) {
    assert.equal(result(f, 'validSid', sid), false);
    assert.equal(runHook(f, 'statePath', f.ctrl, sid).status, 1);
  }
});

test('loadState returns a fresh empty state only for a missing file', (t) => {
  const f = fixture(t);
  const file = path.join(f.ctrl, 'missing.json');
  assert.deepEqual(result(f, 'loadState', file), { v: 1, repos: {} });
  fs.mkdirSync(file);
  assert.equal(runHook(f, 'loadState', file).status, 1);
});

test('loadState rejects corrupt JSON and malformed state at every level', (t) => {
  const f = fixture(t);
  const file = path.join(f.ctrl, 'state.json');
  const bad = ['{', '[]', 'null', '{}', '{"v":2,"repos":{}}', '{"v":1,"repos":[]}',
    ...[null, {}, { baseline: 1, greens: [], blocks: {} },
      { baseline: null, greens: {}, blocks: {} }, { baseline: null, greens: [1], blocks: {} },
      { baseline: null, greens: [], blocks: [] }, { baseline: null, greens: [], blocks: { tree: -1 } },
      { baseline: null, greens: [], blocks: { tree: 1.5 } },
      { baseline: null, greens: [], blocks: { tree: '1' } }]
      .map((entry) => JSON.stringify({ v: 1, repos: { repo: entry } }))];
  for (const raw of bad) {
    fs.writeFileSync(file, raw);
    assert.equal(runHook(f, 'loadState', file).status, 1, raw);
  }
});

test('saveState atomically round trips, overwrites, and cleans failed temporary writes', (t) => {
  const f = fixture(t);
  const file = path.join(f.ctrl, 'var', 'gate', 'sid.json');
  const state = { v: 1, repos: { [f.top]: { baseline: null, greens: ['abc'], blocks: { abc: 2 } } } };
  result(f, 'saveState', file, state);
  assert.deepEqual(result(f, 'loadState', file), state);
  const empty = { v: 1, repos: {} };
  result(f, 'saveState', file, empty);
  assert.deepEqual(result(f, 'loadState', file), empty);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['sid.json']);
  const directory = path.join(path.dirname(file), 'directory');
  fs.mkdirSync(directory);
  assert.equal(runHook(f, 'saveState', directory, state).status, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['directory', 'sid.json']);
  assert.equal(runHook(f, 'saveState', file, []).status, 1);
  assert.deepEqual(result(f, 'loadState', file), empty);
});

test('repoEntry creates defaults, retains evidence, and handles inherited keys', (t) => {
  const f = fixture(t);
  const state = { v: 1, repos: {} };
  const r = runHook(f, 'repoEntry', state, f.top);
  assert.equal(r.status, 0, r.stderr);
  const entry = { baseline: null, greens: [], blocks: {} };
  assert.deepEqual(r.out.result, entry);
  assert.deepEqual(r.out.args[0].repos, { [f.top]: entry });
  const existing = { baseline: 'abc', greens: ['abc'], blocks: { def: 1 } };
  assert.deepEqual(result(f, 'repoEntry', { v: 1, repos: { [f.top]: existing } }, f.top), existing);
  assert.deepEqual(result(f, 'repoEntry', state, '__proto__'), entry);
});

test('shellquote preserves empty strings, apostrophes and shell metacharacters', (t) => {
  const f = fixture(t);
  for (const value of ['', "a'b", 'a b\n$HOME; `echo danger`', 'plain']) {
    const quoted = result(f, 'shellquote', value);
    assert.equal(quoted, "'" + value.replace(/'/g, "'\\''") + "'");
    const r = spawnSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, value);
  }
});

test('splitTopLevel preserves separators, quoting, escapes and nested shell text', (t) => {
  const f = fixture(t);
  const command = 'a | b || c && d;e\nf';
  assert.deepEqual(result(f, 'splitTopLevel', command), [
    { text: 'a ', sep: '|' }, { text: ' b ', sep: '||' }, { text: ' c ', sep: '&&' },
    { text: ' d', sep: ';' }, { text: 'e', sep: '\n' }, { text: 'f', sep: '' },
  ]);
  for (const text of ['echo "a|b && c;d"', "echo 'a|b\nc'", 'echo `a | b`',
    'echo a\\|b', 'echo "a\\"|b"', '(make verify | cat)', 'echo $(make verify | cat)',
    'echo ok # make verify | cat']) {
    assert.deepEqual(result(f, 'splitTopLevel', text), [{ text, sep: '' }]);
  }
  assert.deepEqual(result(f, 'splitTopLevel', 'a;'), [{ text: 'a', sep: ';' }, { text: '', sep: '' }]);
});

test('splitTopLevel keeps quoted, tab-stripped and multiple heredoc bodies intact', (t) => {
  const f = fixture(t);
  for (const text of ["cat <<'EOF'\nmake verify | cat && x\nEOF",
    'cat <<-EOF\n\tmake verify\n\tEOF', 'cat <<\\EOF\nmake verify\nEOF',
    'cat <<A <<"B"\nmake verify\nA\nmake verify | tail\nB',
    'cat <<EOF\nmake verify | cat']) {
    assert.deepEqual(result(f, 'splitTopLevel', text), [{ text, sep: '' }]);
    assert.equal(result(f, 'rewriteCommand', text, 'make verify', '/runner', 'sid'), null);
  }
  const body = 'cat <<EOF\nmake verify | cat\nEOF';
  assert.deepEqual(result(f, 'splitTopLevel', `${body}\nmake verify`), [
    { text: body, sep: '\n' }, { text: 'make verify', sep: '' },
  ]);
  const pipeline = 'cat <<EOF | cat\nmake verify\nEOF\nmake verify';
  const parts = result(f, 'splitTopLevel', pipeline);
  assert.equal(parts.map(({ text, sep }) => text + sep).join(''), pipeline);
  assert.equal(parts.at(-1).text, 'make verify');
});

test('rewriteCommand wraps exact verify segments and retains redirections and surrounding commands', (t) => {
  const f = fixture(t);
  const wrapped = "node '/tmp/run'\\''ner.js' 'sid' 'make verify'";
  const rewrite = (cmd, verify = 'make verify') => result(f, 'rewriteCommand', cmd, verify, "/tmp/run'ner.js", 'sid');
  for (const [input, expected] of [
    ['make verify', wrapped], [' make verify ', ` ${wrapped} `],
    ['make verify 2>&1 | tail -n 20', `${wrapped} 2>&1 | tail -n 20`],
    ['make verify >out 2>&1', `${wrapped} >out 2>&1`],
    ['make verify && git commit -m x', `${wrapped} && git commit -m x`],
    ['false || make verify; make verify\ntrue', `false || ${wrapped}; ${wrapped}\ntrue`],
    ['cat <<EOF\nmake verify\nEOF\nmake verify', `cat <<EOF\nmake verify\nEOF\n${wrapped}`],
  ]) assert.equal(rewrite(input), expected, input);
  for (const cmd of ['make verifyx', 'echo "make verify"', 'node --test test/foo.test.js',
    'echo "a; make verify | cat"', "echo 'make verify'", 'echo make verify',
    '(make verify)', 'echo $(make verify)', 'echo ok # make verify']) {
    assert.equal(rewrite(cmd), null, cmd);
  }
  assert.equal(rewrite('npm test', 'npm test'), "node '/tmp/run'\\''ner.js' 'sid' 'npm test'");
});

const NBGATE = `node '${path.join(fs.realpathSync(CORE), 'scripts/nbgate.js')}'`;
test('resolveVerify expands the rstaff:nbgate alias to the shell-quoted core nbgate script', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, '**Verify (DoD):** `rstaff:nbgate`\n');
  const command = result(f, 'resolveVerify', f.top);
  assert.equal(command, NBGATE);
  assert.match(command, /^node '.*\/scripts\/nbgate\.js'$/);
  assert.equal(result(f, 'expandVerify', 'rstaff:nbgate'), NBGATE);
});

test('expandVerify returns non-exact, case-changed and prototype names literally', (t) => {
  const f = fixture(t);
  for (const value of ['rstaff:nbgate --x', ' rstaff:nbgate', 'RSTAFF:NBGATE', 'toString', '__proto__',
    'constructor', 'hasOwnProperty', 'make verify']) {
    assert.equal(result(f, 'expandVerify', value), value, value);
    fs.writeFileSync(f.profile, `**Verify (DoD):** \`${value}\`\n`);
    assert.equal(result(f, 'resolveVerify', f.top), value, value);
  }
});

test('session-start injects the expanded nbgate command, not the alias, and keeps the rest of the profile', (t) => {
  const f = fixture(t);
  const body = '# product\n**Verify (DoD):** `rstaff:nbgate`\n**Run:** `rstaff:nbgate` stays literal here\n';
  fs.writeFileSync(path.join(f.ctrl, 'profiles', `${slug(f.top)}.md`), body);
  const r = spawnSync(process.execPath, [path.join(CORE, 'hooks/session-start.js')], {
    input: JSON.stringify({ cwd: f.top }), encoding: 'utf8', cwd: f.top, env: f.env, timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(context.includes(`**Verify (DoD):** \`${NBGATE}\``), context);
  assert.ok(!context.includes('**Verify (DoD):** `rstaff:nbgate`'), context);
  assert.ok(context.includes('# product\n'), context);
  assert.ok(context.includes('**Run:** `rstaff:nbgate` stays literal here'), context);
});
