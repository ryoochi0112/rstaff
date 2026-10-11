// Install-drift verdict contract — the check that answers "is the plugin copy
// Claude Code actually loads the one in this repo?". Regression cover for the
// week where several merged PRs sat uninstalled behind "already installed +
// enabled" (see install-apply.sh, health.js check 7b).
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const I = require(path.join(__dirname, '..', '..', 'maintainer', 'lib-install.js'));

test('installer validates the add-on but leaves it out of default install commands', t => {
  const root = path.join(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-addon-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  const output = execFileSync('/bin/bash', [path.join(root, 'install/install-apply.sh')], {
    encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
  });
  assert.match(output, /✓ plugins\/rstaff-ai-datadog\/\.claude-plugin\/plugin\.json/);
  const commands = output.split('\n').filter(line => line.trim().startsWith('/plugin install '));
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.deepEqual(commands.map(line => line.trim()).sort(), marketplace.plugins
    .filter(plugin => plugin.name !== 'rstaff-ai-datadog')
    .map(plugin => `/plugin install ${plugin.name}@${marketplace.name}`).sort());
});

test('e2e step C accepts default installs and rejects an installed add-on', () => {
  const root = path.join(__dirname, '..', '..');
  const script = fs.readFileSync(path.join(root, 'maintainer/e2e-install.sh'), 'utf8');
  const step = script.slice(script.indexOf('echo "== step C:'), script.indexOf('echo "== step D:'));
  assert.ok(step.length > 0, 'step C must be present');
  const defaults = 'rstaff rstaff-engineer rstaff-ai rstaff-delegation rstaff-backlog rstaff-usage rstaff-pm superpowers';
  const harness = `
    set -euo pipefail
    root=unused; stub=unused
    fail() { echo "$1: $2" >&2; exit 1; }
    fresh_env() { :; }
    bash() { :; }
    claude() { :; }
    list_installed() { for p in $TEST_PLUGINS; do echo "$p enabled $p@rstaff"; done; }
  `;
  for (const [plugins, expected] of [[defaults, 0], [`${defaults} rstaff-ai-datadog`, 1]]) {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('/bin/bash', ['-c', harness + step], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TEST_PLUGINS: plugins },
    });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (expected === 1) assert.match(result.stderr, /rstaff-ai-datadog is installed without an explicit request/);
  }
});

function assertVersionsAgree(root) {
  const locations = I.versionLocations(root);
  const checkedLocations = new Map([
    ['plugins/rstaff/.claude-plugin/plugin.json', (json) => json.version],
    ['plugins/rstaff-pm/.claude-plugin/plugin.json', (json) => json.version],
    ['plugins/rstaff-ds/.claude-plugin/plugin.json', (json) => json.version],
    ['plugins/rstaff-engineer/.claude-plugin/plugin.json', (json) => json.version],
    ['plugins/rstaff-ai/.claude-plugin/plugin.json', (json) => json.version],
    ['plugins/rstaff-ai-datadog/.claude-plugin/plugin.json', (json) => json.version],
    ['plugins/rstaff-usage/.claude-plugin/plugin.json', (json) => json.version],
    ['plugins/rstaff-backlog/.claude-plugin/plugin.json', (json) => json.version],
    ['plugins/rstaff-delegation/.claude-plugin/plugin.json', (json) => json.version],
    ['rstaff.json', (json) => json.version],
    ['.claude-plugin/marketplace.json', (json) => json.plugins[0].version],
  ]);
  if (!locations.json.includes('rstaff.json')) checkedLocations.delete('rstaff.json');
  // Filesystem deletions are staged after the implementation gate, so the index
  // still lists removed eval suites. Scan only files remaining in the worktree.
  const deletedFiles = new Set(execFileSync('git', ['ls-files', '--deleted', '-z', '*.json'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean));
  const jsonFiles = execFileSync('git', ['ls-files', '-z', '*.json'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)
    .filter((file) => !deletedFiles.has(file))
    // The dispatcher stages the filesystem move after the implementation gate.
    .map((file) => file.replace(/^plugin\//, 'plugins/rstaff/'));
  // New plugin manifests are not staged by the worker; include them directly
  // so version drift is checked before the dispatcher touches the index.
  const pluginManifests = fs.readdirSync(path.join(root, 'plugins'))
    .map(name => `plugins/${name}/.claude-plugin/plugin.json`)
    .filter(file => fs.existsSync(path.join(root, file)));
  const discoveredLocations = [...new Set([...jsonFiles, ...pluginManifests])].filter((file) => {
    const json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    return Object.hasOwn(json, 'version')
      || (Array.isArray(json.plugins) && json.plugins.some((plugin) => Object.hasOwn(plugin, 'version')));
  });
  assert.ok(discoveredLocations.length > 0, 'must discover at least one version location');
  assert.deepEqual(discoveredLocations.sort(), [...checkedLocations.keys()].sort(),
    'discovered version locations must equal checked version locations');
  assert.ok(I.VERSION_LOCATIONS.json.length > 0,
    'exported JSON version locations must be non-empty');
  assert.deepEqual(locations.json.slice().sort(), [...checkedLocations.keys()].sort(),
    'exported JSON version locations must equal checked version locations');
  assert.equal(I.VERSION_LOCATIONS.heading.file, 'docs/ARCHITECTURE.md');
  for (const text of [
    locations.count === 12 ? 'TWELVE' : 'ELEVEN',
    'plugins/rstaff/.claude-plugin/plugin.json',
    'plugins/rstaff-ai/.claude-plugin/plugin.json',
    'plugins/rstaff-ai-datadog/.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    ...locations.json.filter(file => file === 'rstaff.json'),
    'docs/ARCHITECTURE.md',
  ]) {
    assert.ok(locations.text.includes(text), text);
  }

  const versions = [...checkedLocations].map(([file, readVersion]) => {
    const version = readVersion(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
    assert.equal(typeof version, 'string', `${file} must declare a version`);
    assert.ok(version.length > 0, `${file} must declare a non-empty version`);
    return [file, version];
  });
  const expected = versions[0][1];
  assert.ok(versions.every(([, version]) => version === expected),
    `version mismatch: ${versions.map(([file, version]) => `${file}=${version}`).join(', ')}`);

  const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  for (const plugin of marketplace.plugins) {
    assert.equal(plugin.version, expected, `marketplace version mismatch: ${plugin.name}`);
  }

  // The prose status heading in ARCHITECTURE.md is another version location —
  // it once lagged behind while the JSON locations moved to a newer version.
  const architecture = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
  const heading = architecture.match(/^## Status \(v(\d+\.\d+\.\d+)\)$/m);
  assert.ok(heading, 'docs/ARCHITECTURE.md must carry a "## Status (vX.Y.Z)" heading');
  assert.equal(heading[1], expected,
    `docs/ARCHITECTURE.md status heading says v${heading[1]} but the declared version is v${expected}`);
}

test('all declared rstaff version locations agree', () => {
  assertVersionsAgree(path.join(__dirname, '..', '..'));
});

function mkVersionFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-versions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  for (const file of I.VERSION_LOCATIONS.json.filter(file => file !== 'rstaff.json')) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const json = file === '.claude-plugin/marketplace.json'
      ? { name: 'rstaff', plugins: [{ name: 'rstaff', source: './plugins/rstaff', version: '1.2.3' }] } : { version: '1.2.3' };
    fs.writeFileSync(path.join(root, file), JSON.stringify(json));
  }
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, I.VERSION_LOCATIONS.heading.file), '## Status (v1.2.3)\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

function fixtureBumpNote(root) {
  const homedir = path.join(root, 'fake-home');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(cache);
  fs.mkdirSync(path.join(homedir, '.claude/plugins'), { recursive: true });
  const configDir = path.join(homedir, '.claude');
  fs.writeFileSync(path.join(configDir, 'plugins/installed_plugins.json'), JSON.stringify({
    plugins: { 'rstaff@rstaff': [{ version: '1.2.3', installPath: cache }] },
  }));
  const verdict = I.checkInstall(root, homedir, { configDir });
  assert.equal(verdict.action, 'bump');
  return verdict.note;
}

test('version agreement passes without a tracked control manifest and checks eleven locations', t => {
  const root = mkVersionFixture(t);
  assertVersionsAgree(root);
  assert.equal(I.versionLocations(root).count, 11);
  const note = fixtureBumpNote(root);
  assert.match(note, /all ELEVEN declared locations/);
  assert.doesNotMatch(note, /rstaff\.json/);
  assert.doesNotMatch(I.versionLocations(root).text, /rstaff\.json/);
  fs.writeFileSync(path.join(root, 'rstaff.json'), JSON.stringify({ version: '9.9.9' }));
  assertVersionsAgree(root);
  assert.equal(I.versionLocations(root).count, 11);
});

test('version agreement rejects a mismatched tracked control manifest and checks twelve locations', t => {
  const root = mkVersionFixture(t);
  fs.writeFileSync(path.join(root, 'rstaff.json'), JSON.stringify({ version: '9.9.9' }));
  execFileSync('git', ['add', 'rstaff.json'], { cwd: root });
  assert.equal(I.versionLocations(root).count, 12);
  assert.match(I.versionLocations(root).text, /TWELVE.*rstaff\.json/);
  assert.throws(() => assertVersionsAgree(root), /version mismatch:.*rstaff\.json=9\.9\.9/);
  fs.writeFileSync(path.join(root, 'rstaff.json'), JSON.stringify({ version: '1.2.3' }));
  assertVersionsAgree(root);
  assert.match(fixtureBumpNote(root), /all TWELVE declared locations.*rstaff\.json/);
});

test('driftVerdict: differing versions are a FAIL an update can fix', () => {
  const v = I.driftVerdict({ sourceVersion: '0.7.0', installedVersion: '0.6.1', sha: 'ae8b513b7f0', drift: { differs: true, commits: 24 } });
  assert.equal(v.status, 'FAIL');
  assert.equal(v.action, 'update');
  assert.match(v.note, /installed v0\.6\.1, this repo declares v0\.7\.0/);
  assert.match(v.note, /claude plugin update rstaff@rstaff/);
});

test('driftVerdict: same version + moved plugins/rstaff/ is the silent case — WARN to bump', () => {
  // The exact shape of the 2026-08-02 outage: the version key cannot express
  // this, so no update is possible and nothing reaches a session until a bump.
  const v = I.driftVerdict({ sourceVersion: '0.6.1', installedVersion: '0.6.1', sha: 'ae8b513b7f0', drift: { differs: true, commits: 24 } });
  assert.equal(v.status, 'WARN');
  assert.equal(v.action, 'bump');
  assert.match(v.note, /differs from the installed copy \(ae8b513\) across 24 commit\(s\)/);
  assert.match(v.note, /version is bumped/);
  assert.match(v.note, /TWELVE/);
  assert.match(v.note, /docs\/ARCHITECTURE\.md/);
});

test('driftVerdict: matching version with no movement is PASS', () => {
  const v = I.driftVerdict({ sourceVersion: '0.7.0', installedVersion: '0.7.0', sha: '788ca5edeadbeef', drift: { differs: false, commits: 0 } });
  assert.equal(v.status, 'PASS');
  assert.equal(v.action, null);
  assert.match(v.note, /^v0\.7\.0 \(788ca5e\)$/);
});

test('driftVerdict: unknown drift is reported as unknown, never as zero', () => {
  // A sha git cannot resolve must not read as "no drift" — that would restore
  // the false all-clear this check exists to remove.
  const v = I.driftVerdict({ sourceVersion: '0.7.0', installedVersion: '0.7.0', sha: null, drift: null });
  assert.equal(v.status, 'PASS');
  assert.match(v.note, /drift unknown/);
});

test('driftVerdict: a missing side is WARN, not a false PASS', () => {
  for (const args of [
    { sourceVersion: null, installedVersion: '0.7.0' },
    { sourceVersion: '0.7.0', installedVersion: null },
  ]) {
    const v = I.driftVerdict(args);
    assert.equal(v.status, 'WARN');
    assert.equal(v.action, null);
    assert.match(v.note, /could not compare/);
  }
});

test('readSourceVersion / readInstalled parse the real file shapes and tolerate absence', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-inst-'));
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-hd-'));
  assert.equal(I.readSourceVersion(home), null);
  assert.equal(I.readInstalled(homedir), null);

  fs.mkdirSync(path.join(home, 'plugins', 'rstaff', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'rstaff', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'rstaff', version: '0.7.0' }));
  assert.equal(I.readSourceVersion(home), '0.7.0');

  fs.mkdirSync(path.join(homedir, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(homedir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'rstaff@rstaff': [{ version: '0.6.1', gitCommitSha: 'ae8b513b7f0', installPath: '/x/0.6.1' }] },
  }));
  assert.deepEqual(I.readInstalled(homedir), { version: '0.6.1', sha: 'ae8b513b7f0', path: '/x/0.6.1' });
});

test('pluginDrift returns null (unknown) rather than a clean answer for an unresolvable sha', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-nogit-'));
  assert.equal(I.pluginDrift(home, null), null);
  assert.equal(I.pluginDrift(home, '0'.repeat(40)), null);
});

test('this repo reports a coherent verdict for itself', () => {
  // Real-shape smoke: whatever this machine's install state is, the verdict must
  // be one of the three known shapes — never a crash or a malformed record.
  const v = I.checkInstall(path.join(__dirname, '..', '..'));
  assert.ok(['PASS', 'WARN', 'FAIL'].includes(v.status), `unexpected status ${v.status}`);
  assert.ok([null, 'update', 'bump'].includes(v.action), `unexpected action ${v.action}`);
  assert.equal(typeof v.note, 'string');
  assert.ok(v.note.length > 0);
});

test('commits with no content change are NOT drift', () => {
  // The case that motivated this: a revert-and-re-land (PR #35) moves plugins/rstaff/
  // by four commits and leaves the installed tree byte-identical. Warning there
  // would be a false alarm, and a check that cries wolf gets ignored.
  const v = I.driftVerdict({
    sourceVersion: '0.7.2', installedVersion: '0.7.2',
    sha: 'ddd67a1feed', drift: { differs: false, commits: 4 },
  });
  assert.equal(v.status, 'PASS');
  assert.equal(v.action, null);
  assert.match(v.note, /4 commit\(s\) since, no content change/);
});

test('content that differs is drift even from a single commit', () => {
  const v = I.driftVerdict({
    sourceVersion: '0.7.2', installedVersion: '0.7.2',
    sha: 'ddd67a1feed', drift: { differs: true, commits: 1 },
  });
  assert.equal(v.status, 'WARN');
  assert.equal(v.action, 'bump');
  assert.match(v.note, /differs from the installed copy \(ddd67a1\) across 1 commit\(s\)/);
});

// --- byte comparison is authoritative over the git-sha heuristic --------------
// 2026-08-09 false positive: `claude plugin update` run from a staged (dirty)
// tree copies the WORKING TREE but records the pre-commit HEAD as gitCommitSha.
// The git heuristic then reports drift over a byte-identical installed copy —
// a WARN at every session start until the next version bump. Bytes settle it.

function mkCopyFixture(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-copy-${tag}-`));
  const home = path.join(dir, 'ctrl');
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(path.join(home, 'plugins', 'rstaff', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(cache, 'hooks'), { recursive: true });
  for (const root of [path.join(home, 'plugins', 'rstaff'), cache]) {
    fs.writeFileSync(path.join(root, 'a.md'), 'alpha');
    fs.writeFileSync(path.join(root, 'hooks', 'b.js'), 'beta');
  }
  fs.writeFileSync(path.join(cache, '.in_use'), ''); // cache-only marker must not count
  return { home, cache };
}

test('installedCopyDrift: a byte-identical installed copy is not drift', () => {
  const { home, cache } = mkCopyFixture('same');
  assert.deepEqual(I.installedCopyDrift(home, cache), { differs: false, changed: [] });
});

test('installedCopyDrift: mutated, missing, and extra files are drift, by name', () => {
  // Mutation-tested per rules/testing.md: each claimed detection must go red.
  const a = mkCopyFixture('mut');
  fs.writeFileSync(path.join(a.cache, 'hooks', 'b.js'), 'BETA');
  assert.deepEqual(I.installedCopyDrift(a.home, a.cache), { differs: true, changed: ['hooks/b.js'] });

  const b = mkCopyFixture('miss');
  fs.rmSync(path.join(b.cache, 'a.md'));
  assert.deepEqual(I.installedCopyDrift(b.home, b.cache), { differs: true, changed: ['a.md'] });

  const c = mkCopyFixture('extra');
  fs.writeFileSync(path.join(c.cache, 'stale.js'), 'left behind');
  assert.deepEqual(I.installedCopyDrift(c.home, c.cache), { differs: true, changed: ['stale.js'] });
});

test('installedCopyDrift: an unreadable install path is unknown, never clean', () => {
  const { home } = mkCopyFixture('gone');
  assert.equal(I.installedCopyDrift(home, null), null);
  assert.equal(I.installedCopyDrift(home, path.join(home, 'no-such-dir')), null);
});

test('driftVerdict: identical bytes beat a moved git sha — the 2026-08-09 false positive', () => {
  const v = I.driftVerdict({
    sourceVersion: '0.8.0', installedVersion: '0.8.0', sha: 'b3d4fdfcafe',
    drift: { differs: true, commits: 1 },       // git says drift…
    copy: { differs: false, changed: [] },       // …but the bytes are identical
  });
  assert.equal(v.status, 'PASS');
  assert.equal(v.action, null);
  assert.match(v.note, /byte-identical/);
});

test('driftVerdict: differing bytes are drift even when git looks clean', () => {
  // Opposite direction: install cut from a dirty tree, tree later reverted —
  // git sees no movement while the cache holds content this repo never had.
  const v = I.driftVerdict({
    sourceVersion: '0.8.0', installedVersion: '0.8.0', sha: 'b3d4fdfcafe',
    drift: { differs: false, commits: 0 },
    copy: { differs: true, changed: ['hooks/guard-bash.js', 'scripts/health.js'] },
  });
  assert.equal(v.status, 'WARN');
  assert.equal(v.action, 'bump');
  assert.match(v.note, /differs from plugins\/rstaff\/ in 2 file\(s\) \(hooks\/guard-bash\.js, scripts\/health\.js\)/);
  assert.match(v.note, /version is bumped/);
});

test('pluginDrift reports real content movement in this repo', () => {
  // Real-shape: HEAD vs HEAD is identical; HEAD vs a commit that changed
  // plugins/rstaff/ is not. Exercises the actual git plumbing, not just the verdict.
  const home = path.join(__dirname, '..', '..');
  const head = require('node:child_process')
    .execFileSync('git', ['-C', home, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.deepEqual(I.pluginDrift(home, head), { differs: false, commits: 0 });
});

// --- the drift verdict must REACH someone ------------------------------------
// The verdict above was correct and reported by /health the whole time 4 commits
// of guard code sat uninstalled. It never reached a session because /health is
// on-demand and the condition is continuous, and because health's own summary
// line called the run "all green" over the WARN. These two tests pin the fix.

const HOOKS = path.join(__dirname, '..', '..', 'plugins', 'rstaff', 'hooks');
const HEALTH = path.join(__dirname, '..', '..', 'plugins', 'rstaff', 'scripts', 'health.js');

// A control repo that declares a version, plus a fake $HOME whose install record
// claims a DIFFERENT one — the FAIL/update case, which needs no git history.
function mkDriftedHome(tag, declared, installed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-${tag}-`));
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.mkdirSync(path.join(dir, 'plugins', 'rstaff', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'rstaff', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'rstaff', version: declared }));
  fs.cpSync(path.join(__dirname, '..', '..', 'maintainer'), path.join(dir, 'maintainer'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins', 'rstaff', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', 'plugins', 'rstaff', 'hooks', 'lib.js'), path.join(dir, 'plugins', 'rstaff', 'hooks', 'lib.js'));
  const fakeHome = path.join(dir, 'fake-home');
  fs.mkdirSync(path.join(fakeHome, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'rstaff@rstaff': [{ version: installed, installPath: '/x' }] } }));
  return { dir, fakeHome };
}

test('session-start surfaces install drift, in any repo', () => {
  const { dir, fakeHome } = mkDriftedHome('drift-hook', '9.9.9', '0.0.1');
  const r = execFileSync(process.execPath, [path.join(HOOKS, 'session-start.js')], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: fakeHome, RSTAFF_HOME: dir },
  });
  const ctx = JSON.parse(r).hookSpecificOutput.additionalContext;
  assert.match(ctx, /install drift/i, 'a stale install must be announced at session start');
  assert.match(ctx, /0\.0\.1/, 'must name the version actually running');
  assert.match(ctx, /9\.9\.9/, 'must name the version this repo declares');
});

test('session-start stays quiet when the install is current', () => {
  const { dir, fakeHome } = mkDriftedHome('drift-clean', '1.2.3', '1.2.3');
  const r = execFileSync(process.execPath, [path.join(HOOKS, 'session-start.js')], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: fakeHome, RSTAFF_HOME: dir },
  });
  // No profile, no learnings, no checkpoints in a bare temp repo — so a matching
  // version must leave nothing at all to say. Anything here would be a false alarm.
  assert.equal(r.trim(), '', `expected silence, got: ${r}`);
});

test('health never reports "all green" while a WARN is present', () => {
  // rstaff.json present but no profiles/ dir → check 4 WARNs in --static mode.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-health-warn-'));
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{"rstaff":"control-repo"}');
  const out = execFileSync(process.execPath, [HEALTH, '--static', '--json'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RSTAFF_HOME: dir, RSTAFF_GEMINI_PROJECT: 'fixture-project' },
  });
  const report = JSON.parse(out);
  const warns = report.results.filter((r) => r.status === 'WARN');
  assert.ok(warns.length > 0, 'fixture must actually produce a WARN, else this proves nothing');
  assert.ok(!report.results.some((r) => r.status === 'FAIL'), 'fixture must have no FAIL to mask the WARN');
  assert.doesNotMatch(report.summary, /all green/i,
    `a WARN must not be summarised as green; got "${report.summary}"`);
  assert.match(report.summary, /WARN/, 'the summary must point at the warning');
});

test('health still says all green when everything passes', () => {
  // Same shape, WITH profiles/ — the check that WARNed above now passes, so the
  // honest summary must go back to "all green". Guards against a fix that simply
  // never prints green again.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-health-green-'));
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.mkdirSync(path.join(dir, 'profiles'));
  const out = execFileSync(process.execPath, [HEALTH, '--static', '--json'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RSTAFF_HOME: dir, RSTAFF_GEMINI_PROJECT: 'fixture-project' },
  });
  const report = JSON.parse(out);
  assert.deepEqual(report.results.filter((r) => r.status !== 'PASS'), [], 'fixture must be all-PASS');
  assert.match(report.summary, /all green/i);
});

// The plugin tree is plugins/<name>/, not plugin/.
// A bare `plugin/` in the drift text points the human at a directory that no
// longer exists. Pin it for every note that names a directory, and require the
// per-plugin notes to name WHICH plugin drifted.
const BARE_PLUGIN_DIR = /(^|[^s-])plugin\//; // `-` excluded: ".claude-plugin/" is a real directory

test('drift notes name plugins/<id>/, never the bare plugin/ directory', () => {
  const pluginId = 'rstaff-ai@rstaff';
  const base = { sourceVersion: '0.9.0', installedVersion: '0.9.0', sha: 'b3d4fdfcafe', pluginId };
  const notes = {
    'byte-identical': I.driftVerdict({ ...base, copy: { differs: false, changed: [] } }).note,
    'copy differs': I.driftVerdict({ ...base, copy: { differs: true, changed: ['hooks/a.js'] } }).note,
    'git drift': I.driftVerdict({ ...base, drift: { differs: true, commits: 2 } }).note,
    'drift unknown': I.driftVerdict({ ...base, drift: null }).note,
  };
  for (const [label, note] of Object.entries(notes)) {
    assert.doesNotMatch(note, BARE_PLUGIN_DIR, `${label}: bare plugin/ in: ${note}`);
    assert.match(note, /plugins\/rstaff-ai/, `${label}: must name the plugin dir in: ${note}`);
  }
});

test('session-start drift message says edits to plugins/, not plugin/', () => {
  const { dir, fakeHome } = mkDriftedHome('drift-dir', '9.9.9', '0.0.1');
  const r = execFileSync(process.execPath, [path.join(HOOKS, 'session-start.js')], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: fakeHome, RSTAFF_HOME: dir },
  });
  const ctx = JSON.parse(r).hookSpecificOutput.additionalContext;
  assert.match(ctx, /edits to plugins\//, 'must point at plugins/');
  assert.doesNotMatch(ctx, BARE_PLUGIN_DIR);
});
