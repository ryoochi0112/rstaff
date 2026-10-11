// Skill-body guard contract tests use isolated fixture homes.
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const HOOKS = path.join(ROOT, 'plugins', 'rstaff-usage', 'hooks');
const GUARD_PATH = path.join(HOOKS, 'guard-skill.js');
const guard = require(GUARD_PATH);

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-guard-skill-${tag}-`));
}

function controlRepo(tag) {
  const dir = tempDir(`ctrl-${tag}`);
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{"rstaff":"control-repo"}\n');
  return dir;
}

function writeBody(file, size, frontmatter = '---\nname: fixture\n---\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.from(frontmatter);
  assert.ok(header.length <= size, 'fixture frontmatter must fit requested body size');
  fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(size - header.length, 0x78)]));
  return file;
}

function projectBody(project, skill, size, frontmatter) {
  return writeBody(path.join(project, '.claude', 'skills', skill, 'SKILL.md'), size, frontmatter);
}

function cacheBody(home, marketplace, plugin, version, skill, size, frontmatter) {
  return writeBody(path.join(home, '.claude', 'plugins', 'cache', marketplace, plugin, version,
    'skills', skill, 'SKILL.md'), size, frontmatter);
}

function writeInstalledPlugins(home, plugin, marketplace, installPath, projectPath) {
  const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    version: 2,
    plugins: {
      [`${plugin}@${marketplace}`]: [{
        scope: projectPath ? 'local' : 'user',
        ...(projectPath ? { projectPath } : {}),
        installPath,
      }],
    },
  }, null, 2)}\n`);
}

function event(skill, sessionId = `session-${skill}`) {
  return { session_id: sessionId, tool_name: 'Skill', tool_input: { skill } };
}

function options(project, ctrl, extra = {}) {
  return {
    projectDir: project,
    userHome: tempDir('empty-home'),
    controlHome: ctrl,
    denyEnabled: true,
    ...extra,
  };
}

function runScript(script, input, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  let output = {};
  try { output = JSON.parse(result.stdout); } catch (_) {}
  return {
    ...result,
    decision: output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision,
  };
}

test('64 KB boundary denies at equality; the shipped flag is enabled', () => {
  const project = tempDir('threshold-project');
  const ctrl = controlRepo('threshold');
  projectBody(project, 'under', guard.THRESHOLD_BYTES - 1);
  projectBody(project, 'equal', guard.THRESHOLD_BYTES);

  assert.equal(guard.THRESHOLD_BYTES, 64 * 1024);
  assert.equal(guard.DENY_ENABLED, true,
    'deny ships enabled since 2026-08-22 — the coordinator probe showed no agent_id');
  assert.equal(guard.decide(event('under'), options(project, ctrl)).action, 'pass');
  assert.equal(guard.decide(event('equal'), options(project, ctrl)).action, 'deny',
    'positive control: the same harness can deny at the exact boundary');

  const inertCtrl = controlRepo('inert');
  const inert = guard.decide(event('equal', 'inert-session'), options(project, inertCtrl, { denyEnabled: false }));
  assert.equal(inert.action, 'pass');
  assert.equal(inert.reason, 'deny-inert');
  assert.match(inert.warning, /would deny.*DENY_ENABLED=false/);
  assert.equal(fs.existsSync(path.join(inertCtrl, 'var', 'guard-skill')), false,
    'log-only evaluation must not consume the future one-time denial');
});

test('predicate is absence of agent_id; present agent_id warns and passes', () => {
  const project = tempDir('agent-project');
  const ctrl = controlRepo('agent');
  projectBody(project, 'heavy', guard.THRESHOLD_BYTES);
  const present = guard.decide({ ...event('heavy', 'agent-present'), agent_id: 'subagent-123' }, options(project, ctrl));
  assert.equal(present.action, 'pass');
  assert.equal(present.reason, 'agent-id-present');
  assert.match(present.warning, /agent_id is present/);
  assert.equal(guard.decide(event('heavy', 'agent-absent'), options(project, ctrl)).action, 'deny',
    'positive control: removing agent_id reaches the deny in the same harness');
});

test('missing tool_input.skill fails open, with an oversized positive control', () => {
  const project = tempDir('missing-project');
  const ctrl = controlRepo('missing');
  projectBody(project, 'heavy', guard.THRESHOLD_BYTES);
  const opts = options(project, ctrl);
  assert.equal(guard.decide({ session_id: 'missing', tool_input: {} }, opts).action, 'pass');
  assert.equal(guard.decide({ session_id: 'missing-object' }, opts).action, 'pass');
  assert.equal(guard.decide(event('heavy', 'missing-positive'), opts).action, 'deny',
    'positive control: a populated skill field reaches the deny');
});

test('resolution covers project, user, marketplace, and cache locations', () => {
  const project = tempDir('resolve-project');
  const home = tempDir('resolve-home');
  const ctrl = controlRepo('resolve');
  const fixtures = [
    ['project-heavy', projectBody(project, 'project-heavy', guard.THRESHOLD_BYTES)],
    ['user-heavy', writeBody(path.join(home, '.claude', 'skills', 'user-heavy', 'SKILL.md'), guard.THRESHOLD_BYTES)],
    ['market-plugin:market-heavy', writeBody(path.join(home, '.claude', 'plugins', 'marketplaces', 'source',
      'plugins', 'market-plugin', 'skills', 'market-heavy', 'SKILL.md'), guard.THRESHOLD_BYTES)],
    ['cache-plugin:cache-heavy', writeBody(path.join(home, '.claude', 'plugins', 'cache', 'source',
      'cache-plugin', '1.2.3', 'skills', 'cache-heavy', 'SKILL.md'), guard.THRESHOLD_BYTES)],
  ];
  for (const [skill, body] of fixtures) {
    const opts = { projectDir: project, userHome: home, controlHome: ctrl, denyEnabled: true };
    assert.equal(guard.resolveSkillBody(skill, opts), body, `resolved ${skill}`);
    assert.equal(guard.decide(event(skill, `resolve-${skill}`), opts).action, 'deny',
      `positive control: resolved ${skill} is deny-capable`);
  }
});

test('resolution order is project, user, cache, then marketplace', () => {
  const project = tempDir('order-project');
  const home = tempDir('order-home');
  const ctrl = controlRepo('order');
  const projectSmall = projectBody(project, 'ordered', 128);
  const user = writeBody(path.join(home, '.claude', 'skills', 'ordered', 'SKILL.md'), guard.THRESHOLD_BYTES);
  const market = writeBody(path.join(home, '.claude', 'plugins', 'marketplaces', 'src', 'plugins', 'plug',
    'skills', 'ordered', 'SKILL.md'), guard.THRESHOLD_BYTES);
  const cache = writeBody(path.join(home, '.claude', 'plugins', 'cache', 'src', 'plug', '1.0.0',
    'skills', 'ordered', 'SKILL.md'), guard.THRESHOLD_BYTES);
  projectBody(project, 'positive', guard.THRESHOLD_BYTES);
  const opts = { projectDir: project, userHome: home, controlHome: ctrl, denyEnabled: true };
  assert.equal(guard.resolveSkillBody('ordered', opts), projectSmall);
  assert.equal(guard.decide(event('ordered'), opts).action, 'pass', 'project body wins over later oversized copies');
  assert.equal(guard.decide(event('positive'), opts).action, 'deny',
    'positive control: project resolution itself is deny-capable');

  // Drop each winner in turn so every later step is asserted.
  fs.rmSync(projectSmall);
  assert.equal(guard.resolveSkillBody('ordered', opts), user, 'without a project copy, the user copy wins');
  fs.rmSync(user);
  assert.equal(guard.resolveSkillBody('ordered', opts), cache, 'without a user copy, the cache copy wins');
  fs.rmSync(cache);
  assert.equal(guard.resolveSkillBody('ordered', opts), market, 'without a cache copy, the marketplace copy wins');
});

test('namespaced calls cannot resolve a colliding bare or different-plugin skill', () => {
  const project = tempDir('namespace-project');
  const home = tempDir('namespace-home');
  const ctrl = controlRepo('namespace');
  projectBody(project, 'sprint', guard.THRESHOLD_BYTES);
  writeBody(path.join(home, '.claude', 'skills', 'sprint', 'SKILL.md'), guard.THRESHOLD_BYTES);
  writeBody(path.join(home, '.claude', 'plugins', 'cache', 'source', 'wrong-plugin', '1.0.0',
    'skills', 'sprint', 'SKILL.md'), guard.THRESHOLD_BYTES);
  const rightSmall = cacheBody(home, 'source', 'pm-execution', '2.1.0', 'sprint', 1024);
  cacheBody(home, 'source', 'pm-execution', '2.1.0', 'heavy', guard.THRESHOLD_BYTES);
  const opts = { projectDir: project, userHome: home, controlHome: ctrl, denyEnabled: true };

  assert.equal(guard.resolveSkillBody('pm-execution:sprint', opts), rightSmall);
  assert.equal(guard.decide(event('pm-execution:sprint'), opts).action, 'pass',
    'a namespace collision must not measure an unrelated oversized body');
  assert.equal(guard.decide(event('pm-execution:heavy'), opts).action, 'deny',
    'positive control: the namespaced plugin path is deny-capable');
});

function assertInstalledVersionCase(tag, staleSize, liveSize, action) {
  const project = tempDir(`version-${tag}-project`);
  const home = tempDir(`version-${tag}-home`);
  const ctrl = controlRepo(`version-${tag}`);
  cacheBody(home, 'source', 'versioned', '0.4.0', 'body', staleSize);
  const live = cacheBody(home, 'source', 'versioned', '0.7.4', 'body', liveSize);
  writeInstalledPlugins(home, 'versioned', 'source', path.dirname(path.dirname(path.dirname(live))), project);
  const opts = { projectDir: project, userHome: home, controlHome: ctrl, denyEnabled: true };

  assert.equal(guard.resolveSkillBody('versioned:body', opts), live,
    `${tag}: the installed path, not lexical path order, is authoritative`);
  assert.equal(guard.decide(event('versioned:body', tag), opts).action, action);
}

test('installed live oversized version wins over a stale small cache version', () => {
  assertInstalledVersionCase('live-heavy', 1024, guard.THRESHOLD_BYTES, 'deny');
});

test('installed live small version wins over a stale oversized cache version', () => {
  assertInstalledVersionCase('stale-heavy', guard.THRESHOLD_BYTES, 1024, 'pass');
});

// The installed copy is what loads, so it is what gets measured,
// even when the marketplace catalog holds a same-named copy of another size.
function assertInstalledOverCatalogCase(tag, catalogSize, installedSize, action) {
  const project = tempDir(`catalog-${tag}-project`);
  const home = tempDir(`catalog-${tag}-home`);
  const ctrl = controlRepo(`catalog-${tag}`);
  writeBody(path.join(home, '.claude', 'plugins', 'marketplaces', 'source', 'plugins', 'shipped',
    'skills', 'body', 'SKILL.md'), catalogSize);
  const installed = cacheBody(home, 'source', 'shipped', '1.0.0', 'body', installedSize);
  writeInstalledPlugins(home, 'shipped', 'source', path.dirname(path.dirname(path.dirname(installed))));
  const opts = { projectDir: project, userHome: home, controlHome: ctrl, denyEnabled: true };

  assert.equal(guard.resolveSkillBody('shipped:body', opts), installed,
    `${tag}: the installed copy, not the marketplace catalog copy, is measured`);
  assert.equal(guard.decide(event('shipped:body', tag), opts).action, action);
}

test('installed oversized copy wins over a small marketplace catalog copy', () => {
  assertInstalledOverCatalogCase('installed-heavy', 1024, guard.THRESHOLD_BYTES, 'deny');
});

test('installed small copy wins over an oversized marketplace catalog copy', () => {
  assertInstalledOverCatalogCase('catalog-heavy', guard.THRESHOLD_BYTES, 1024, 'pass');
});

test('without install metadata, a cache copy wins over a marketplace catalog copy', () => {
  const project = tempDir('catalog-nometa-project');
  const home = tempDir('catalog-nometa-home');
  const ctrl = controlRepo('catalog-nometa');
  writeBody(path.join(home, '.claude', 'plugins', 'marketplaces', 'source', 'plugins', 'shipped',
    'skills', 'body', 'SKILL.md'), guard.THRESHOLD_BYTES);
  const cached = cacheBody(home, 'source', 'shipped', '1.0.0', 'body', 1024);
  const opts = { projectDir: project, userHome: home, controlHome: ctrl, denyEnabled: true };
  assert.equal(guard.resolveSkillBody('shipped:body', opts), cached);
});

// A stale installPath that holds no matching skill falls through
// to the largest cache copy, the cautious choice for a size guard.
test('an installPath with no matching skill falls back to the largest cache copy', () => {
  const project = tempDir('stale-install-project');
  const home = tempDir('stale-install-home');
  const ctrl = controlRepo('stale-install');
  cacheBody(home, 'source', 'drifted', '0.9.0', 'body', 1024);
  const heavy = cacheBody(home, 'source', 'drifted', '0.4.0', 'body', guard.THRESHOLD_BYTES);
  const other = cacheBody(home, 'source', 'drifted', '1.0.0', 'other', 1024);
  writeInstalledPlugins(home, 'drifted', 'source', path.dirname(path.dirname(path.dirname(other))));
  const opts = { projectDir: project, userHome: home, controlHome: ctrl, denyEnabled: true };

  assert.equal(guard.resolveSkillBody('drifted:body', opts), heavy);
  assert.equal(guard.decide(event('drifted:body'), opts).action, 'deny');
  assert.equal(guard.resolveSkillBody('drifted:other', opts), other,
    'positive control: the installPath itself still resolves its own skill');
});

test('plugin traversal is depth-bounded and prunes repository internals', () => {
  const project = tempDir('walk-project');
  const home = tempDir('walk-home');
  const ctrl = controlRepo('walk');
  const cache = path.join(home, '.claude', 'plugins', 'cache');
  writeBody(path.join(cache, '.git', 'ignored', 'skills', 'pruned', 'SKILL.md'), guard.THRESHOLD_BYTES);
  writeBody(path.join(cache, 'node_modules', 'ignored', 'skills', 'pruned', 'SKILL.md'), guard.THRESHOLD_BYTES);
  const tooDeep = Array.from({ length: guard.MAX_PLUGIN_DEPTH + 1 }, (_, index) => `d${index}`);
  writeBody(path.join(cache, ...tooDeep, 'skills', 'deep', 'SKILL.md'), guard.THRESHOLD_BYTES);
  cacheBody(home, 'source', 'walk-plugin', '1.0.0', 'heavy', guard.THRESHOLD_BYTES);
  const opts = { projectDir: project, userHome: home, controlHome: ctrl, denyEnabled: true };

  assert.equal(guard.decide(event('pruned'), opts).action, 'pass');
  assert.equal(guard.decide(event('deep'), opts).action, 'pass');
  assert.equal(guard.decide(event('walk-plugin:heavy'), opts).action, 'deny',
    'positive control: a normal cache body remains reachable');
});

test('unknown names fail open; the non-empty measured-offender literal fails closed', () => {
  const project = tempDir('offender-project');
  const ctrl = controlRepo('offender');
  const opts = options(project, ctrl);
  assert.ok(guard.MEASURED_OFFENDERS.length > 0, 'offender literal must fail closed on empty');
  assert.deepEqual(guard.MEASURED_OFFENDERS, ['claude-api']);
  assert.equal(guard.decide(event('unknown-built-in'), opts).action, 'pass');
  assert.equal(guard.decide(event('claude-api'), opts).action, 'deny',
    'positive control: the unresolved measured offender reaches the deny');
});

test('oversized context: fork bodies are excluded, with a same-size positive control', () => {
  const project = tempDir('fork-project');
  const ctrl = controlRepo('fork');
  projectBody(project, 'fork-heavy', guard.THRESHOLD_BYTES, '---\nname: fork-heavy\ncontext: fork\n---\n');
  projectBody(project, 'plain-heavy', guard.THRESHOLD_BYTES, '---\nname: plain-heavy\ncontext: inline\n---\n');
  const opts = options(project, ctrl);
  const fork = guard.decide(event('fork-heavy'), opts);
  assert.equal(fork.action, 'pass');
  assert.equal(fork.reason, 'context-fork');
  assert.equal(guard.decide(event('plain-heavy'), opts).action, 'deny',
    'positive control: changing only context makes the same-size body deny-capable');
});

test('deny once is keyed by both session_id and skill', () => {
  const project = tempDir('once-project');
  const ctrl = controlRepo('once');
  projectBody(project, 'heavy-a', guard.THRESHOLD_BYTES);
  projectBody(project, 'heavy-b', guard.THRESHOLD_BYTES);
  const opts = options(project, ctrl);

  assert.equal(guard.decide(event('heavy-a', 'session-a'), opts).action, 'deny');
  assert.equal(guard.decide(event('heavy-a', 'session-a'), opts).reason, 'repeat');
  assert.equal(guard.decide(event('heavy-a', 'session-b'), opts).action, 'deny',
    'different session is a new key');
  assert.equal(guard.decide(event('heavy-b', 'session-a'), opts).action, 'deny',
    'different skill is a new key');
  assert.equal(fs.readdirSync(path.join(ctrl, 'var', 'guard-skill')).length, 3);
});

test('missing or unusable denial state fails open, with a writable positive control', () => {
  const project = tempDir('state-project');
  projectBody(project, 'heavy', guard.THRESHOLD_BYTES);
  const brokenCtrl = controlRepo('state-broken');
  fs.writeFileSync(path.join(brokenCtrl, 'var'), 'not a directory');
  const broken = options(project, brokenCtrl, { ensureDirImpl() {} });
  assert.equal(guard.decide(event('heavy', 'broken-state'), broken).reason, 'state-unavailable');
  assert.equal(guard.decide(event('heavy', 'broken-state'), broken).action, 'pass');

  const goodCtrl = controlRepo('state-good');
  assert.equal(guard.decide(event('heavy', 'good-state'), options(project, goodCtrl)).action, 'deny',
    'positive control: writable state reaches the deny');
});

test('any internal throw fails open, with the normal implementation as positive control', () => {
  const project = tempDir('throw-project');
  const ctrl = controlRepo('throw');
  projectBody(project, 'heavy', guard.THRESHOLD_BYTES);
  const throwingFs = Object.create(fs);
  throwingFs.statSync = () => { throw new Error('synthetic stat failure'); };
  const failed = guard.decide(event('heavy', 'throwing'), options(project, ctrl, { fsImpl: throwingFs }));
  assert.equal(failed.action, 'pass');
  assert.equal(failed.reason, 'error');
  assert.match(failed.warning, /failed open.*synthetic stat failure/);
  assert.equal(guard.decide(event('heavy', 'throw-positive'), options(project, ctrl)).action, 'deny',
    'positive control: the normal filesystem reaches the deny');
});

test('denial names the session-hygiene delegation escape', () => {
  const project = tempDir('message-project');
  const ctrl = controlRepo('message');
  projectBody(project, 'heavy', guard.THRESHOLD_BYTES);
  const result = guard.decide(event('heavy', 'message'), options(project, ctrl));
  assert.equal(result.action, 'deny');
  assert.match(result.reason, /session-hygiene\.md/);
  assert.match(result.reason, /Agent\(general-purpose/);
  assert.match(result.reason, /load heavy/);
  assert.match(result.reason, /only once/);
});

test('live hook denies; a one-line flag flip restores the log-only path', () => {
  const project = tempDir('live-project');
  const ctrl = controlRepo('live');
  const home = tempDir('live-home');
  projectBody(project, 'heavy', guard.THRESHOLD_BYTES);
  const input = { ...event('heavy', 'live-session'), cwd: ctrl };
  const env = { CLAUDE_PROJECT_DIR: project, RSTAFF_HOME: ctrl, HOME: home };

  const first = runScript(GUARD_PATH, input, env);
  assert.equal(first.decision, 'deny');
  assert.match(first.stdout, /Agent\(general-purpose/);
  const repeat = runScript(GUARD_PATH, input, env);
  assert.equal(repeat.status, 0);
  assert.equal(repeat.stdout, '', 'same (session, skill) passes after one denial');

  const mutantHooks = tempDir('inert-hooks');
  fs.copyFileSync(path.join(HOOKS, 'lib.js'), path.join(mutantHooks, 'lib.js'));
  const source = fs.readFileSync(GUARD_PATH, 'utf8');
  const inertSource = source.replace('const DENY_ENABLED = true;', 'const DENY_ENABLED = false;');
  assert.notEqual(inertSource, source, 'disablement must remain one obvious line');
  fs.writeFileSync(path.join(mutantHooks, 'guard-skill.js'), inertSource);
  const inertPath = path.join(mutantHooks, 'guard-skill.js');

  // Fresh session id: the live deny above already consumed live-session's claim.
  const inertInput = { ...event('heavy', 'inert-session'), cwd: ctrl };
  const inert = runScript(inertPath, inertInput, env);
  assert.equal(inert.status, 0);
  assert.equal(inert.stdout, '');
  assert.match(inert.stderr, /would deny.*DENY_ENABLED=false/);
});

// Only roots a Skill call can load from: project and user skills, plus each
// active installPath named by installed_plugins.json. ~/.claude/plugins/cache
// also keeps stale versions and marketplaces/ holds every catalog plugin, and
// neither loads unless an installPath names it. A local-scope install loads
// only in its own projectPath, so other projects' installs are skipped.
function installedSkillRoots(home, projectDir) {
  let installs = [];
  try {
    const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    installs = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).plugins || {})
      .flatMap((entries) => Array.isArray(entries) ? entries : []);
  } catch (_) {}
  const here = projectDir && realOrResolved(projectDir);
  const installPaths = [...new Set(installs
    .filter((install) => install && typeof install.installPath === 'string')
    .filter((install) => !install.projectPath || realOrResolved(install.projectPath) === here)
    .map((install) => path.resolve(install.installPath)))];
  return [
    ['$CLAUDE_PROJECT_DIR/.claude/skills', projectDir && path.join(projectDir, '.claude', 'skills'), 1],
    ['~/.claude/skills', path.join(home, '.claude', 'skills'), 1],
    ...installPaths.map((installPath) => [`installPath ${installPath}`, installPath,
      installWalkDepth(home, installPath)]),
  ];
}

// Compare projects by real path, so a symlinked checkout matches its target.
// A path that does not exist cannot load anything, so resolving it is enough.
function realOrResolved(dir) {
  try { return fs.realpathSync(dir); } catch (_) { return path.resolve(dir); }
}

// The project the real-machine inventory runs for: CLAUDE_PROJECT_DIR when
// Claude Code sets it, else this repo, so its local-scope installs still count.
function inventoryProjectDir(env) {
  return env.CLAUDE_PROJECT_DIR || ROOT;
}

// Bound the walk like findPluginBodies: <dir>/skills/<name>/SKILL.md with <dir>
// at most MAX_PLUGIN_DEPTH below the walk root, never inside a pruned directory.
const MAX_WALK_DEPTH = guard.MAX_PLUGIN_DEPTH + 2;

// findPluginBodies counts depth from plugins/cache and plugins/marketplaces, so
// an installPath inside one of them has already used part of the budget. An
// installPath outside both keeps the full budget: the guard never searches it,
// and over-reporting there is the safe direction.
function installWalkDepth(home, installPath) {
  for (const root of ['cache', 'marketplaces'].map((dir) => path.join(home, '.claude', 'plugins', dir))) {
    const relative = path.relative(path.resolve(root), installPath);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return MAX_WALK_DEPTH - relative.split(path.sep).length;
    }
  }
  return MAX_WALK_DEPTH;
}

// Count only the shapes the guard resolves: <root>/<name>/SKILL.md for user and
// project skills (walked at depth 1), and <dir>/skills/<name>/SKILL.md under an
// installPath. Both put a directory named skills two levels above the body.
// The guard's statSync follows symlinks only at skills/<name>/SKILL.md, so a
// link is followed there and nowhere else, and never walked below: hops is how
// many more levels the walk may descend (one below a linked skills directory,
// none below a linked skill directory). A link is stat'ed only where the walk
// would use it, so a broken link the guard never touches cannot throw. A cyclic
// link stops at a realpath already on the current path; a global visited set
// would let a deep visit with no depth budget left hide the same directory
// reached shallowly. A pruned name directly under skills/ is still a skill the
// guard stats, so its SKILL.md counts, but the walk never descends below it.
function walkSkillBodies(root, maxDepth = MAX_WALK_DEPTH, found = [], depth = 0, ancestors = new Set(),
  hops = Infinity) {
  if (!root || !fs.existsSync(root)) return found;
  const real = fs.realpathSync(root);
  if (ancestors.has(real)) return found;
  const onPath = new Set(ancestors).add(real);
  const canDescend = depth < maxDepth && hops > 0;
  const shaped = depth >= 1 && path.basename(path.dirname(root)) === 'skills';
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const followed = entry.isSymbolicLink() && ((entry.name === 'SKILL.md' && shaped)
      || (canDescend && (entry.name === 'skills' || path.basename(root) === 'skills'))) ? statOrNull(file) : null;
    if (entry.isDirectory() || (followed && followed.isDirectory())) {
      const pruned = guard.PRUNED_PLUGIN_DIRS.has(entry.name);
      if (canDescend && (!pruned || path.basename(root) === 'skills')) {
        const childHops = pruned ? 0
          : Math.min(hops, followed ? (entry.name === 'skills' ? 2 : 1) : Infinity) - 1;
        walkSkillBodies(file, maxDepth, found, depth + 1, onPath, childHops);
      }
    } else if ((entry.isFile() || (followed && followed.isFile())) && entry.name === 'SKILL.md' && shaped) {
      found.push(file);
    }
  }
  return found;
}

// Like the guard's isFile: only a missing target means "not there".
function statOrNull(file) {
  try { return fs.statSync(file); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// Only active installPaths load, wherever they live; a stale
// cached version or a catalog-only copy never does.
test('installed-skill inventory walks active installPaths plus user and project skills', () => {
  const home = tempDir('inventory-home');
  const project = tempDir('inventory-project');
  const catalogOnly = writeBody(path.join(home, '.claude', 'plugins', 'marketplaces', 'm', 'plugins', 'p',
    'skills', 'uninstalled', 'SKILL.md'), guard.THRESHOLD_BYTES);
  const stale = cacheBody(home, 'm', 'p', '0.9.0', 'installed', guard.THRESHOLD_BYTES);
  const inCache = cacheBody(home, 'm', 'p', '1.0.0', 'installed', 100);
  const outsideRoot = tempDir('inventory-local-plugin');
  const outside = writeBody(path.join(outsideRoot, 'skills', 'local-plugin-skill', 'SKILL.md'), 100);
  const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.writeFileSync(file, `${JSON.stringify({
    version: 2,
    plugins: {
      'p@m': [{ scope: 'user', installPath: path.join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0') }],
      'local@dir': [{ scope: 'user', installPath: outsideRoot }],
    },
  })}\n`);
  const user = writeBody(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 100);
  const local = projectBody(project, 'local', 100);

  const found = installedSkillRoots(home, project).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  assert.deepEqual(found.sort(), [inCache, outside, user, local].sort());
  assert.ok(!found.includes(stale), 'a stale cached version never loads, so it must not fail the inventory');
  assert.ok(!found.includes(catalogOnly), 'a catalog-only SKILL.md never loads, so it must not fail the inventory');
});

function writeInstalls(home, plugins) {
  const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 2, plugins })}\n`);
}

function pluginRoot(tag, skill) {
  const root = tempDir(tag);
  return [root, writeBody(path.join(root, 'skills', skill, 'SKILL.md'), 100)];
}

// A local-scope install loads only in its own project.
test('installed-skill inventory skips local-scope installs of other projects', () => {
  const home = tempDir('scope-home');
  const project = tempDir('scope-project');
  const other = tempDir('scope-other');
  const [userRoot, userSkill] = pluginRoot('scope-user', 'user-scoped');
  const [hereRoot, hereSkill] = pluginRoot('scope-here', 'here-scoped');
  const [elsewhereRoot, elsewhereSkill] = pluginRoot('scope-elsewhere', 'elsewhere-scoped');
  writeInstalls(home, {
    'p@m': [
      { scope: 'user', installPath: userRoot },
      { scope: 'local', projectPath: project, installPath: hereRoot },
      { scope: 'local', projectPath: other, installPath: elsewhereRoot },
    ],
  });

  const found = installedSkillRoots(home, project).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  assert.deepEqual(found.sort(), [userSkill, hereSkill].sort());
  assert.ok(!found.includes(elsewhereSkill), 'another project\'s local install never loads here');
});

// Make verify from a plain terminal leaves CLAUDE_PROJECT_DIR
// unset; this repo is still the project whose local installs load.
test('installed-skill inventory falls back to the repo root when CLAUDE_PROJECT_DIR is unset', () => {
  const home = tempDir('fallback-home');
  const [hereRoot, hereSkill] = pluginRoot('fallback-here', 'here-scoped');
  const [elsewhereRoot, elsewhereSkill] = pluginRoot('fallback-elsewhere', 'elsewhere-scoped');
  writeInstalls(home, {
    'p@m': [
      { scope: 'local', projectPath: ROOT, installPath: hereRoot },
      { scope: 'local', projectPath: tempDir('fallback-other'), installPath: elsewhereRoot },
    ],
  });

  assert.equal(inventoryProjectDir({}), ROOT);
  assert.equal(inventoryProjectDir({ CLAUDE_PROJECT_DIR: '/set' }), '/set');
  const found = installedSkillRoots(home, inventoryProjectDir({}))
    .flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  assert.ok(found.includes(hereSkill), 'this repo\'s local install loads here, so it must be counted');
  assert.ok(!found.includes(elsewhereSkill), 'another project\'s local install never loads here');
});

// A project reached through a symlink is still the same project.
test('installed-skill inventory matches local-install projectPath through symlinks', () => {
  const home = tempDir('realpath-home');
  const real = fs.realpathSync(tempDir('realpath-project'));
  const link = path.join(tempDir('realpath-links'), 'project');
  fs.symlinkSync(real, link, 'dir');
  const [realRoot, realSkill] = pluginRoot('realpath-real', 'recorded-real');
  const [linkRoot, linkSkill] = pluginRoot('realpath-link', 'recorded-link');
  const [elsewhereRoot, elsewhereSkill] = pluginRoot('realpath-elsewhere', 'elsewhere-scoped');
  writeInstalls(home, {
    'p@m': [
      { scope: 'local', projectPath: real, installPath: realRoot },
      { scope: 'local', projectPath: link, installPath: linkRoot },
      { scope: 'local', projectPath: tempDir('realpath-other'), installPath: elsewhereRoot },
    ],
  });

  for (const projectDir of [link, real]) {
    const found = installedSkillRoots(home, projectDir).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
    assert.ok(found.includes(realSkill), `projectPath recorded as the real path loads in ${projectDir}`);
    assert.ok(found.includes(linkSkill), `projectPath recorded as the link loads in ${projectDir}`);
    assert.ok(!found.includes(elsewhereSkill), 'another project\'s local install never loads here');
  }
});

// The inventory walk is bounded and pruned like findPluginBodies.
test('installed-skill inventory walk is depth-bounded and prunes repository internals', () => {
  const home = tempDir('walkinv-home');
  const root = tempDir('walkinv-repo');
  writeInstalls(home, { 'p@m': [{ scope: 'user', installPath: root }] });
  const normal = writeBody(path.join(root, 'skills', 'normal', 'SKILL.md'), 100);
  const atLimit = Array.from({ length: guard.MAX_PLUGIN_DEPTH }, (_, index) => `d${index}`);
  const deepest = writeBody(path.join(root, ...atLimit, 'skills', 'deepest', 'SKILL.md'), 100);
  writeBody(path.join(root, 'node_modules', 'dep', 'skills', 'pruned', 'SKILL.md'), 100);
  writeBody(path.join(root, '.git', 'x', 'skills', 'pruned', 'SKILL.md'), 100);
  const tooDeep = Array.from({ length: guard.MAX_PLUGIN_DEPTH + 1 }, (_, index) => `d${index}`);
  writeBody(path.join(root, ...tooDeep, 'skills', 'deep', 'SKILL.md'), 100);

  const found = installedSkillRoots(home, null).flatMap(([, dir, maxDepth]) => walkSkillBodies(dir, maxDepth));
  assert.deepEqual(found.sort(), [deepest, normal].sort());
});

// The guard stats skills/<name>/SKILL.md directly, so a skill
// named like a pruned directory still loads; only the walk below it is pruned.
test('installed-skill inventory counts skills named like pruned directories', () => {
  const home = tempDir('prunedname-home');
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0');
  writeInstalls(home, { 'p@m': [{ scope: 'user', installPath }] });
  const pluginSkill = writeBody(path.join(installPath, 'skills', 'node_modules', 'SKILL.md'), guard.THRESHOLD_BYTES);
  const userSkill = writeBody(path.join(home, '.claude', 'skills', 'node_modules', 'SKILL.md'), guard.THRESHOLD_BYTES);
  const below = writeBody(path.join(installPath, 'skills', 'node_modules', 'dep', 'skills', 'x', 'SKILL.md'),
    guard.THRESHOLD_BYTES);

  const found = installedSkillRoots(home, null).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  for (const [skill, body] of [['p:node_modules', pluginSkill], ['node_modules', userSkill]]) {
    assert.equal(guard.resolveSkillBody(skill, { userHome: home }), body, `guard resolves ${skill}`);
    assert.ok(found.includes(body), `inventory must count the oversized ${skill}`);
  }
  assert.equal(guard.resolveSkillBody('p:x', { userHome: home }), null, 'guard never walks below node_modules');
  assert.ok(!found.includes(below), 'inventory must not walk below a pruned-name skill directory');
});

// Plugin ids differ only by marketplace; both installPaths load.
test('installed-skill inventory walks same-name plugins from two marketplaces', () => {
  const home = tempDir('twomkt-home');
  const [firstRoot, firstSkill] = pluginRoot('twomkt-m1', 'from-m1');
  const [secondRoot, secondSkill] = pluginRoot('twomkt-m2', 'from-m2');
  writeInstalls(home, {
    'p@m1': [{ scope: 'user', installPath: firstRoot }],
    'p@m2': [{ scope: 'user', installPath: secondRoot }],
  });

  const found = installedSkillRoots(home, null).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  assert.deepEqual(found.sort(), [firstSkill, secondSkill].sort());
});

// The guard counts depth from plugins/cache, not from the
// installPath, so the inventory must reach exactly what the guard resolves.
test('installed-skill inventory depth for a cache installPath matches the guard', () => {
  const home = tempDir('cachedepth-home');
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0');
  writeInstalls(home, { 'p@m': [{ scope: 'user', installPath }] });
  const offset = 3; // m/p/1.0.0 below plugins/cache
  const dirs = (count) => Array.from({ length: count }, (_, index) => `d${index}`);
  const edge = writeBody(path.join(installPath, ...dirs(guard.MAX_PLUGIN_DEPTH - offset), 'skills', 'edge', 'SKILL.md'), 100);
  const deep = writeBody(path.join(installPath, ...dirs(guard.MAX_PLUGIN_DEPTH - offset + 1), 'skills', 'deep', 'SKILL.md'), 100);

  const found = installedSkillRoots(home, null).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  for (const [name, body] of [['edge', edge], ['deep', deep]]) {
    const resolved = guard.resolveSkillBody(`p:${name}`, { userHome: home }) === body;
    assert.equal(found.includes(body), resolved, `inventory and guard disagree on ${name}`);
  }
  assert.ok(found.includes(edge), 'positive control: the guard-reachable edge body is counted');
});

// The same depth offset applies to an installPath under plugins/marketplaces.
test('installed-skill inventory depth for a marketplaces installPath matches the guard', () => {
  const home = tempDir('mktdepth-home');
  const installPath = path.join(home, '.claude', 'plugins', 'marketplaces', 'm', 'plugins', 'p');
  writeInstalls(home, { 'p@m': [{ scope: 'user', installPath }] });
  const offset = 3; // m/plugins/p below plugins/marketplaces
  const dirs = (count) => Array.from({ length: count }, (_, index) => `d${index}`);
  const edge = writeBody(path.join(installPath, ...dirs(guard.MAX_PLUGIN_DEPTH - offset), 'skills', 'edge', 'SKILL.md'), 100);
  const deep = writeBody(path.join(installPath, ...dirs(guard.MAX_PLUGIN_DEPTH - offset + 1), 'skills', 'deep', 'SKILL.md'), 100);

  const found = installedSkillRoots(home, null).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  for (const [name, body] of [['edge', edge], ['deep', deep]]) {
    const resolved = guard.resolveSkillBody(`p:${name}`, { userHome: home }) === body;
    assert.equal(found.includes(body), resolved, `inventory and guard disagree on ${name}`);
  }
  assert.ok(found.includes(edge), 'positive control: the guard-reachable edge body is counted');
});

// Count only the shapes the guard resolves, never any SKILL.md.
test('installed-skill inventory counts only loadable SKILL.md shapes', () => {
  const home = tempDir('shape-home');
  const project = tempDir('shape-project');
  const [installPath, pluginSkill] = pluginRoot('shape-plugin', 'loadable');
  writeInstalls(home, { 'p@m': [{ scope: 'user', installPath }] });
  const userSkill = writeBody(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 100);
  const projectSkill = projectBody(project, 'ours', 100);
  const unloadable = [
    path.join(home, '.claude', 'skills', '_archived', 'x', 'SKILL.md'),
    path.join(home, '.claude', 'skills', 'SKILL.md'),
    path.join(home, '.claude', 'skills', 'mine', 'skills', 'nested', 'SKILL.md'),
    path.join(project, '.claude', 'skills', '_archived', 'y', 'SKILL.md'),
    path.join(installPath, 'skills', 'loadable', 'ref', 'SKILL.md'),
    path.join(installPath, 'skills', 'SKILL.md'),
    path.join(installPath, 'docs', 'SKILL.md'),
  ].map((file) => writeBody(file, 100));

  const found = installedSkillRoots(home, project).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  assert.deepEqual(found.sort(), [pluginSkill, userSkill, projectSkill].sort());
  for (const body of unloadable) assert.ok(!found.includes(body), `never loads, must not be counted: ${body}`);
});

// The guard's statSync follows symlinks at skills/<name>/SKILL.md,
// so the inventory must too, without looping on a cyclic link.
test('installed-skill inventory follows symlinked skill directories like the guard', () => {
  const home = tempDir('symlink-home');
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0');
  fs.mkdirSync(installPath, { recursive: true });
  writeInstalls(home, { 'p@m': [{ scope: 'user', installPath }] });
  const userTarget = writeBody(path.join(tempDir('symlink-user-target'), 'SKILL.md'), guard.THRESHOLD_BYTES);
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.dirname(userTarget), path.join(home, '.claude', 'skills', 'linked'), 'dir');
  const pluginTarget = tempDir('symlink-plugin-skills');
  writeBody(path.join(pluginTarget, 'viaskills', 'SKILL.md'), guard.THRESHOLD_BYTES);
  fs.symlinkSync(pluginTarget, path.join(installPath, 'skills'), 'dir');
  fs.symlinkSync(installPath, path.join(pluginTarget, 'loop'), 'dir');
  const fileTarget = writeBody(path.join(tempDir('symlink-file-target'), 'body.md'), guard.THRESHOLD_BYTES);
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'filelink'), { recursive: true });
  fs.symlinkSync(fileTarget, path.join(home, '.claude', 'skills', 'filelink', 'SKILL.md'), 'file');

  const found = installedSkillRoots(home, null).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  const expected = [
    ['linked', path.join(home, '.claude', 'skills', 'linked', 'SKILL.md')],
    ['filelink', path.join(home, '.claude', 'skills', 'filelink', 'SKILL.md')],
    ['p:viaskills', path.join(installPath, 'skills', 'viaskills', 'SKILL.md')],
  ];
  for (const [skill, body] of expected) {
    assert.equal(guard.resolveSkillBody(skill, { userHome: home }), body, `guard resolves ${skill}`);
    assert.ok(found.includes(body), `inventory must count the oversized symlinked ${skill}`);
  }
  assert.equal(found.length, new Set(found.map((file) => fs.realpathSync(file))).size,
    'a cyclic link must not count one body twice');
});

// A directory first reached deep, with no depth budget left, must not hide the
// same directory reached shallowly through another link.
test('installed-skill inventory cycle guard does not hide a shallow link to a deep-visited dir', () => {
  const home = tempDir('symlink-deep-home');
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0');
  writeInstalls(home, { 'p@m': [{ scope: 'user', installPath }] });
  const target = tempDir('symlink-deep-target');
  writeBody(path.join(target, 'big', 'SKILL.md'), guard.THRESHOLD_BYTES);
  const deep = path.join(installPath, 'a1', 'a2', 'a3', 'a4', 'a5', 'a6');
  fs.mkdirSync(deep, { recursive: true });
  fs.symlinkSync(target, path.join(deep, 'skills'), 'dir');
  fs.symlinkSync(target, path.join(installPath, 'skills'), 'dir');

  const found = installedSkillRoots(home, null).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  const body = path.join(installPath, 'skills', 'big', 'SKILL.md');
  assert.equal(guard.resolveSkillBody('p:big', { userHome: home }), body);
  assert.ok(found.includes(body), 'the shallow loadable body must be counted');
});

// The guard never descends into a linked directory; it only stats
// skills/<name>/SKILL.md through one. A body nested below the link never loads.
test('installed-skill inventory does not count bodies nested beneath a followed link', () => {
  const home = tempDir('symlink-nested-home');
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0');
  writeInstalls(home, { 'p@m': [{ scope: 'user', installPath }] });
  const target = tempDir('symlink-nested-target');
  writeBody(path.join(target, 'SKILL.md'), 100);
  writeBody(path.join(target, 'skills', 'x', 'SKILL.md'), guard.THRESHOLD_BYTES);
  fs.mkdirSync(path.join(installPath, 'skills'), { recursive: true });
  fs.symlinkSync(target, path.join(installPath, 'skills', 'link'), 'dir');
  const skillsTarget = tempDir('symlink-nested-skills');
  writeBody(path.join(skillsTarget, 'y', 'skills', 'z', 'SKILL.md'), guard.THRESHOLD_BYTES);
  fs.mkdirSync(path.join(installPath, 'nested'));
  fs.symlinkSync(skillsTarget, path.join(installPath, 'nested', 'skills'), 'dir');

  const found = installedSkillRoots(home, null).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  const linked = path.join(installPath, 'skills', 'link', 'SKILL.md');
  assert.equal(guard.resolveSkillBody('p:link', { userHome: home }), linked);
  assert.ok(found.includes(linked), 'positive control: the body directly behind the link is counted');
  for (const [skill, body] of [
    ['p:x', path.join(installPath, 'skills', 'link', 'skills', 'x', 'SKILL.md')],
    ['p:z', path.join(installPath, 'nested', 'skills', 'y', 'skills', 'z', 'SKILL.md')],
  ]) {
    assert.equal(guard.resolveSkillBody(skill, { userHome: home }), null, `guard never resolves ${skill}`);
    assert.ok(!found.includes(body), `inventory must not count ${skill} below a followed link`);
  }
});

// The guard's isFile swallows only ENOENT, so a looping link
// throws there; the inventory must surface it, not skip it silently.
test('installed-skill inventory throws on a looping SKILL.md link like the guard', () => {
  const home = tempDir('symlink-loop-home');
  const dir = path.join(home, '.claude', 'skills', 'looped');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(dir, 'SKILL.md'), path.join(dir, 'SKILL.md'), 'file');
  const dangling = path.join(home, '.claude', 'skills', 'dangling');
  fs.mkdirSync(dangling);
  fs.symlinkSync(path.join(dangling, 'missing.md'), path.join(dangling, 'SKILL.md'), 'file');

  assert.throws(() => guard.resolveSkillBody('looped', { userHome: home }), { code: 'ELOOP' });
  assert.equal(guard.resolveSkillBody('dangling', { userHome: home }), null);
  const walk = () => installedSkillRoots(home, null).flatMap(([, root, maxDepth]) => walkSkillBodies(root, maxDepth));
  assert.throws(walk, { code: 'ELOOP' });
  fs.unlinkSync(path.join(dir, 'SKILL.md'));
  assert.deepEqual(walk(), [], 'positive control: a dangling link (ENOENT) is skipped like the guard');
});

test('hooks.json registers exactly one Skill PreToolUse command', () => {
  const config = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  const entries = config.hooks.PreToolUse.filter((entry) => entry.matcher === 'Skill');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].hooks, [{
    type: 'command',
    command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard-skill.js"',
    timeout: 5,
  }]);
});

test('installer and health syntax-check deny-capable hooks in both plugins', () => {
  const fixture = tempDir('syntax-check');
  fs.cpSync(path.join(ROOT, 'plugins'), path.join(fixture, 'plugins'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'install'), path.join(fixture, 'install'), { recursive: true });
  fs.cpSync(path.join(ROOT, '.claude-plugin'), path.join(fixture, '.claude-plugin'), { recursive: true });
  const env = { ...process.env, HOME: tempDir('health-home'), RSTAFF_HOME: ROOT, CLAUDE_CONFIG_DIR: tempDir('config') };
  const health = () => spawnSync(process.execPath, [path.join(fixture, 'plugins', 'rstaff', 'scripts', 'health.js'), '--static'], { encoding: 'utf8', env });
  const installer = () => spawnSync('bash', [path.join(fixture, 'install', 'install-apply.sh')], { encoding: 'utf8', env });
  try {
    const healthy = health();
    assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
    assert.match(healthy.stdout, /manifests \+ hook syntax\s+PASS\s+5 manifests, 10 hooks OK/);
    const installed = installer();
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    for (const [plugin, hook] of [['rstaff-usage', 'guard-skill'], ['rstaff', 'guard-bash'], ['rstaff', 'secret-scan']]) {
      const file = path.join(fixture, 'plugins', plugin, 'hooks', `${hook}.js`);
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, 'function { syntax error');
      const broken = health();
      assert.equal(broken.status, 1, `${plugin}/${hook}: health must fail`);
      assert.match(broken.stdout, /manifests \+ hook syntax\s+FAIL/);
      assert.ok(broken.stdout.includes(file), 'health must name the broken hook');
      const rejected = installer();
      assert.equal(rejected.status, 1, `${plugin}/${hook}: installer must fail`);
      assert.ok(rejected.stderr.includes(`${file} has a syntax error`));
      fs.writeFileSync(file, original);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
