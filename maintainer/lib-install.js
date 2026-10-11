// rstaff install-state collector — Node built-ins only, zero dependencies.
// Answers one question: is the INSTALLED plugin copy actually the one in this
// control repo? "Installed + enabled" does not answer it. The plugin cache is
// keyed by version (~/.claude/plugins/cache/<mkt>/<plugin>/<version>), so a
// stale copy is never re-copied and every session keeps running the hooks from
// whenever it was last installed — behind a success message. Measured
// 2026-08-02: several merged PRs sat uninstalled for a week that way.
//
// Shared by install-apply.sh (which acts on the verdict) and health.js (which
// reports it) so the two can never disagree about what "current" means.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require(path.join(__dirname, '..', 'plugins', 'rstaff', 'hooks', 'lib.js'));
const fs = lib.fs;

const PLUGIN_ID = 'rstaff@rstaff';

const VERSION_LOCATIONS = Object.freeze({
  count: 'TWELVE',
  json: Object.freeze([
    'plugins/rstaff/.claude-plugin/plugin.json',
    'plugins/rstaff-pm/.claude-plugin/plugin.json',
    'plugins/rstaff-ds/.claude-plugin/plugin.json',
    'plugins/rstaff-engineer/.claude-plugin/plugin.json',
    'plugins/rstaff-ai/.claude-plugin/plugin.json',
    'plugins/rstaff-ai-datadog/.claude-plugin/plugin.json',
    'plugins/rstaff-usage/.claude-plugin/plugin.json',
    'plugins/rstaff-backlog/.claude-plugin/plugin.json',
    'plugins/rstaff-delegation/.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'rstaff.json',
  ]),
  heading: Object.freeze({
    file: 'docs/ARCHITECTURE.md',
    pattern: '## Status (vX.Y.Z)',
  }),
});
const VERSION_LOCATIONS_TEXT = `all ${VERSION_LOCATIONS.count} declared locations (${VERSION_LOCATIONS.json.join(', ')}, and the "${VERSION_LOCATIONS.heading.pattern}" heading in ${VERSION_LOCATIONS.heading.file})`;

function versionLocations(home, timeoutMs) {
  const tracked = git(home, ['ls-files', '--', 'rstaff.json'], timeoutMs);
  const json = VERSION_LOCATIONS.json.filter(file => file !== 'rstaff.json'
    || (tracked && tracked.status === 0 && tracked.stdout.trim()));
  const count = json.length + 1;
  const text = `all ${count === 12 ? 'TWELVE' : 'ELEVEN'} declared locations (${json.join(', ')}, and the "${VERSION_LOCATIONS.heading.pattern}" heading in ${VERSION_LOCATIONS.heading.file})`;
  return { json, count, text };
}

// The version this control repo declares — the copy an install SHOULD produce.
function readSourceVersion(home, source = 'plugins/rstaff') {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(home, source, '.claude-plugin', 'plugin.json'), 'utf8',
    )).version || null;
  } catch (_) { return null; }
}

// The copy Claude Code actually loads, per its own install record.
function readInstalled(homedir, pluginId = PLUGIN_ID, configDir) {
  try {
    const rec = JSON.parse(fs.readFileSync(
      path.join(configDir || process.env.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude'), 'plugins', 'installed_plugins.json'), 'utf8',
    ));
    const entry = ((rec.plugins || {})[pluginId] || [])[0];
    if (!entry) return null;
    return { version: entry.version || null, sha: entry.gitCommitSha || null, path: entry.installPath || null };
  } catch (_) { return null; }
}

// `timeoutMs` exists because this is now called from a SessionStart hook, which
// Claude Code kills at 10s TOTAL. Three git calls at the CLI default (10s each)
// could eat that whole budget and take the memory injection down with them, so
// the hook passes a tight bound. Default unchanged for health/install callers.
function git(home, args, timeoutMs) {
  try { return spawnSync('git', ['-C', home, ...args], { encoding: 'utf8', timeout: timeoutMs || 10000 }); }
  catch (_) { return null; }
}

// Has plugins/<name>/ actually MOVED since the installed copy was cut?
// Commits are the wrong question — CONTENT is. A revert-and-re-land, a rebase,
// or a message-only fix adds commits while leaving the installed tree correct,
// and a check that cries drift over those trains people to ignore it. So diff
// the bytes, and use the commit count only to describe a difference that is
// real. Returns null (unknown) rather than a false all-clear when the sha is
// not resolvable here — "unknown" must never read as "no drift".
function pluginDrift(home, sha, timeoutMs, source = 'plugins/rstaff') {
  if (!sha) return null;
  const known = git(home, ['cat-file', '-e', `${sha}^{commit}`], timeoutMs);
  if (!known || known.status !== 0) return null;
  // `git diff --quiet` exits 1 for "differs", 0 for "identical"; anything else
  // is git failing, which is unknown, not clean.
  const diff = git(home, ['diff', '--quiet', `${sha}..HEAD`, '--', source], timeoutMs);
  if (!diff || diff.status === null || diff.status > 1) return null;
  const count = git(home, ['rev-list', '--count', `${sha}..HEAD`, '--', source], timeoutMs);
  const commits = count && count.status === 0 ? Number(String(count.stdout).trim()) : NaN;
  return { differs: diff.status === 1, commits: Number.isFinite(commits) ? commits : null };
}

// Does the copy Claude Code actually loads MATCH plugins/<name>/ byte-for-byte?
// The git heuristic above cannot answer this when the install was cut from a
// dirty working tree: Claude Code records HEAD at install time, not the tree it
// copied. 2026-08-09: an update run from a staged v0.8.0 tree recorded the
// v0.7.7 HEAD and cried drift over a byte-identical copy — a WARN that would
// have fired every session until the next bump. So when the installed path is
// readable, compare the actual bytes; git commits only DESCRIBE a difference,
// they never define one. Returns null (unknown) when the path is gone or
// unreadable — "unknown" must never read as "no drift".
const CACHE_ONLY = new Set(['.in_use']); // top-level markers Claude Code adds to its cache
function listFiles(root) {
  const out = new Map(); // relative path -> absolute path
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (rel === '' && CACHE_ONLY.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, r);
      else if (entry.isFile()) out.set(r, abs);
    }
  };
  walk(root, '');
  return out;
}
function installedCopyDrift(home, installPath, sourceRoot = path.join(home, 'plugins', 'rstaff')) {
  try {
    if (!installPath || !fs.statSync(installPath).isDirectory()) return null;
    const installed = listFiles(installPath);
    const source = listFiles(sourceRoot);
    const changed = [];
    for (const rel of new Set([...installed.keys(), ...source.keys()])) {
      if (!installed.has(rel) || !source.has(rel)) { changed.push(rel); continue; }
      if (!fs.readFileSync(installed.get(rel)).equals(fs.readFileSync(source.get(rel)))) changed.push(rel);
    }
    changed.sort();
    return { differs: changed.length > 0, changed };
  } catch (_) { return null; }
}

// The verdict. Pure — every input is passed in, so it is testable without a
// machine to install onto.
//   FAIL/update : versions differ; `claude plugin update` will fix it.
//   WARN/bump   : versions AGREE but the content moved. This is the silent case
//                 the version key cannot express: no update is possible until
//                 someone bumps, so the change can never reach a session.
// `copy` (byte comparison) is authoritative when present; the git-sha `drift`
// is the fallback for machines where the installed path is unreadable.
// The repair, in one place so the two drift branches can never drift apart.
// The applicable version locations are checked by `test/maintainer/install-drift.test.js`:
// the gate — a partial bump reds `make verify` — 2026-08-17, a bump of the first two did exactly
// that. And `make install` only VALIDATES; applying takes the --install flag.
function driftVerdict({ sourceVersion, installedVersion, sha, drift, copy, pluginId = PLUGIN_ID, versionLocationsText = VERSION_LOCATIONS_TEXT }) {
  const bumpInstruction = ` — nothing can pick the change up until the version is bumped in ${versionLocationsText}, then re-run: bash install/install-apply.sh --install`;
  if (!sourceVersion || !installedVersion) {
    return { status: 'WARN', action: null, note: 'could not compare the installed copy with this repo\'s manifest' };
  }
  if (sourceVersion !== installedVersion) {
    return {
      status: 'FAIL',
      action: 'update',
      note: `installed v${installedVersion}, this repo declares v${sourceVersion} — run: claude plugin update ${pluginId}`,
    };
  }
  const at = sha ? ` (${sha.slice(0, 7)})` : '';
  const dir = `plugins/${pluginId.split('@')[0]}/`; // name WHICH plugin the note is about
  if (copy) {
    if (!copy.differs) {
      return { status: 'PASS', action: null, note: `v${sourceVersion}${at} — installed copy byte-identical to ${dir}` };
    }
    const names = copy.changed.slice(0, 3).join(', ');
    return {
      status: 'WARN',
      action: 'bump',
      note: `v${sourceVersion} matches, but the installed copy differs from ${dir} in ${copy.changed.length} file(s)`
        + (names ? ` (${names}${copy.changed.length > 3 ? ', …' : ''})` : '')
        + bumpInstruction,
    };
  }
  if (drift && drift.differs) {
    return {
      status: 'WARN',
      action: 'bump',
      note: `v${sourceVersion} matches, but ${dir} differs from the installed copy${at}`
        + `${drift.commits ? ` across ${drift.commits} commit(s)` : ''}`
        + bumpInstruction,
    };
  }
  return {
    status: 'PASS',
    action: null,
    note: `v${sourceVersion}${at}`
      + (!drift ? ` — ${dir} drift unknown (no git history for the installed sha)`
        : drift.commits ? ` — ${drift.commits} commit(s) since, no content change` : ''),
  };
}

// One call for callers that just want the answer for this machine. The byte
// comparison is tried first (authoritative, no subprocess — safe inside the
// SessionStart time budget); the git heuristic only runs as its fallback.
function checkInstall(home, homedir, opts) {
  const options = opts || {};
  const versionLocationsText = versionLocations(home, options.timeoutMs).text;
  let marketplace;
  try {
    marketplace = JSON.parse(fs.readFileSync(path.join(home, '.claude-plugin', 'marketplace.json'), 'utf8'));
  } catch (_) {
    marketplace = { name: 'rstaff', plugins: [{ name: 'rstaff', source: './plugins/rstaff' }] };
  }
  const plugins = marketplace.plugins.map(({ name, source }) => {
    const pluginId = `${name}@${marketplace.name}`;
    const sourceVersion = readSourceVersion(home, source);
    const installed = readInstalled(homedir || require('os').homedir(), pluginId, options.configDir);
    const sha = installed && installed.sha;
    const copy = installed ? installedCopyDrift(home, installed.path, path.resolve(home, source)) : null;
    const drift = installed && !copy ? pluginDrift(home, sha, options.timeoutMs, source) : null;
    return {
      name, sourceVersion, installedVersion: installed && installed.version,
      version: sourceVersion, sha, drift, copy,
      ...driftVerdict({ sourceVersion, installedVersion: installed && installed.version, sha, drift, copy, pluginId, versionLocationsText }),
    };
  });
  const core = plugins.find(plugin => plugin.name === 'rstaff') || plugins[0];
  const severity = { PASS: 0, WARN: 1, FAIL: 2 };
  const worst = plugins.reduce((a, b) => severity[b.status] > severity[a.status] ? b : a, core);
  return {
    ...core,
    status: worst.status,
    action: plugins.some(plugin => plugin.action === 'update') ? 'update'
      : plugins.some(plugin => plugin.action === 'bump') ? 'bump' : null,
    note: plugins.length === 1 ? worst.note : plugins.map(plugin => `${plugin.name}: ${plugin.note}`).join('; '),
    plugins,
  };
}

if (require.main === module) {
  const i = process.argv.indexOf('--home');
  const home = i >= 0 ? process.argv[i + 1] : lib.resolveHome(process.cwd());
  process.stdout.write(JSON.stringify(checkInstall(home), null, 2) + '\n');
}

module.exports = {
  PLUGIN_ID,
  VERSION_LOCATIONS,
  VERSION_LOCATIONS_TEXT,
  versionLocations,
  readSourceVersion,
  readInstalled,
  pluginDrift,
  installedCopyDrift,
  driftVerdict,
  checkInstall,
};
