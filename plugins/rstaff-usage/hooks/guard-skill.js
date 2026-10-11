#!/usr/bin/env node
// PreToolUse(Skill): keep oversized skill bodies out of the coordinator.
//
// DENY enabled 2026-08-22: a live coordinator probe (claude-desktop entrypoint,
// Skill claude-api) hit the deny-inert branch, which is reachable only when the
// event carries no agent_id — so coordinator events carry none. If any surface
// does emit agent_id in the coordinator, the guard fails open there, never
// wrong-denies. Disabling is this one-line change.
'use strict';
const crypto = require('crypto');
const {
  fs, path, os, readEventStrict, resolveHome, ensureDir, warn, denyTool, askTool, pass,
} = require('./lib');

const DENY_ENABLED = true;
const THRESHOLD_BYTES = 64 * 1024;
const MEASURED_OFFENDERS = Object.freeze(['claude-api']);
const FRONTMATTER_LIMIT = 64 * 1024;
const MAX_PLUGIN_DEPTH = 8;
const PRUNED_PLUGIN_DIRS = new Set(['.git', 'node_modules']);

function parseSkillName(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split(':');
  if (parts.length > 2 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
    return null;
  }
  return parts.length === 2
    ? { namespace: parts[0], name: parts[1] }
    : { namespace: null, name: parts[0] };
}

function isFile(file, fsImpl) {
  try { return fsImpl.statSync(file).isFile(); }
  catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function findPluginBodies(root, namespace, skillName, fsImpl) {
  if (!root || !fsImpl.existsSync(root)) return [];
  const found = [];
  const pending = [{ dir: root, depth: 0 }];
  while (pending.length) {
    const { dir, depth } = pending.pop();
    const candidate = path.join(dir, 'skills', skillName, 'SKILL.md');
    const segments = path.resolve(dir).split(path.sep);
    if ((!namespace || segments.includes(namespace)) && isFile(candidate, fsImpl)) {
      found.push(candidate);
    }
    if (depth >= MAX_PLUGIN_DEPTH) continue;
    const children = fsImpl.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !PRUNED_PLUGIN_DIRS.has(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const child of children) pending.push({ dir: path.join(dir, child.name), depth: depth + 1 });
  }
  return found;
}

function installedPluginPaths(userHome, namespace, projectDir, fsImpl) {
  if (!namespace || !userHome) return [];
  try {
    const file = path.join(userHome, '.claude', 'plugins', 'installed_plugins.json');
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const entries = Object.entries(parsed.plugins || {})
      .filter(([id]) => id.split('@')[0] === namespace)
      .flatMap(([, installs]) => Array.isArray(installs) ? installs : [])
      .filter((install) => install && typeof install.installPath === 'string');
    // Claude may have project-scoped and user-scoped installs for one plugin.
    // Prefer the install scoped to this project, then the user-wide install.
    return entries.sort((a, b) => {
      const rank = (entry) => entry.projectPath === projectDir ? 0 : (entry.projectPath ? 2 : 1);
      return rank(a) - rank(b);
    }).map((install) => path.resolve(install.installPath));
  } catch (_) {
    return [];
  }
}

function isWithin(parent, file) {
  const relative = path.relative(parent, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function findInstalledBody(matches, installedPaths) {
  for (const installPath of installedPaths) {
    const installed = matches.find((candidate) => isWithin(installPath, candidate));
    if (installed) return installed;
  }
  return null;
}

function selectPluginBody(matches, fsImpl) {
  // Without authoritative install metadata, choose the largest body. This is a
  // deliberate conservative fallback for a size guard: stale small versions
  // cannot hide an oversized candidate. Equal sizes use path order for stability.
  return matches.slice().sort((a, b) => {
    const sizeDiff = fsImpl.statSync(b).size - fsImpl.statSync(a).size;
    return sizeDiff || a.localeCompare(b);
  })[0] || null;
}

// Resolution is deliberately independent of event.cwd. T1 measured that the
// hook exposes CLAUDE_PROJECT_DIR for the project root; cwd is only for locating
// the rstaff control repo that owns runtime state.
function resolveSkillBody(skill, options = {}) {
  const parsed = parseSkillName(skill);
  if (!parsed) return null;
  const fsImpl = options.fsImpl || fs;
  const projectDir = options.projectDir;
  const userHome = options.userHome || os.homedir();
  // Namespaced plugin calls must never collide with a bare project/user skill.
  if (!parsed.namespace) {
    const directRoots = [
      projectDir && path.join(projectDir, '.claude', 'skills'),
      userHome && path.join(userHome, '.claude', 'skills'),
    ];
    for (const root of directRoots) {
      if (!root) continue;
      const body = path.join(root, parsed.name, 'SKILL.md');
      if (isFile(body, fsImpl)) return body;
    }
  }

  // The installed copy is what loads, so measure it first: the active
  // installPath (in any root), then cache, then the marketplace catalog only
  // when nothing installed matches.
  const pluginRoots = [
    userHome && path.join(userHome, '.claude', 'plugins', 'cache'),
    userHome && path.join(userHome, '.claude', 'plugins', 'marketplaces'),
  ];
  const installedPaths = installedPluginPaths(userHome, parsed.namespace, projectDir, fsImpl);
  const matchesByRoot = pluginRoots.map((root) => findPluginBodies(root, parsed.namespace, parsed.name, fsImpl));
  const installed = findInstalledBody(matchesByRoot.flat(), installedPaths);
  if (installed) return installed;
  for (const matches of matchesByRoot) {
    if (matches.length) return selectPluginBody(matches, fsImpl);
  }
  return null;
}

function readFrontmatter(body, size, fsImpl) {
  const length = Math.min(size, FRONTMATTER_LIMIT);
  const buffer = Buffer.alloc(length);
  const fd = fsImpl.openSync(body, 'r');
  try {
    const read = fsImpl.readSync(fd, buffer, 0, length, 0);
    const prefix = buffer.subarray(0, read).toString('utf8').replace(/^\uFEFF/, '');
    const opening = /^---\r?\n/.exec(prefix);
    if (!opening) return { contextFork: false, complete: true };
    const rest = prefix.slice(opening[0].length);
    const closing = /\r?\n---(?:\r?\n|$)/.exec(rest);
    if (!closing) return { contextFork: false, complete: false };
    const frontmatter = rest.slice(0, closing.index);
    const contextFork = /^context\s*:\s*(['"]?)fork\1\s*(?:#.*)?$/m.test(frontmatter);
    return { contextFork, complete: true };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function inspectSkill(skill, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const body = resolveSkillBody(skill, options);
  if (!body) {
    return MEASURED_OFFENDERS.includes(skill)
      ? { oversized: true, body: null, size: null, source: 'measured-offender' }
      : { oversized: false, body: null, size: null, source: 'unresolved' };
  }
  const stat = fsImpl.statSync(body);
  if (!stat.isFile() || stat.size < THRESHOLD_BYTES) {
    return { oversized: false, body, size: stat.size, source: 'disk' };
  }
  const frontmatter = readFrontmatter(body, stat.size, fsImpl);
  // A frontmatter block too large to inspect safely is ambiguous, so fail open.
  if (!frontmatter.complete || frontmatter.contextFork) {
    return {
      oversized: false,
      body,
      size: stat.size,
      source: frontmatter.contextFork ? 'context-fork' : 'ambiguous-frontmatter',
    };
  }
  return { oversized: true, body, size: stat.size, source: 'disk' };
}

function claimFirstDenial(controlHome, sessionId, skill, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const stateDir = path.join(controlHome, 'var', 'guard-skill');
  // Use the shared helper, then independently prove the directory is readable
  // and writable. ensureDir intentionally swallows errors for other hooks.
  (options.ensureDirImpl || ensureDir)(stateDir);
  try {
    fsImpl.readdirSync(stateDir);
    fsImpl.accessSync(stateDir, fsImpl.constants.R_OK | fsImpl.constants.W_OK);
  } catch (_) {
    return 'unavailable';
  }

  const key = crypto.createHash('sha256').update(`${sessionId}\0${skill}`).digest('hex');
  const marker = path.join(stateDir, `${key}.json`);
  let fd;
  try {
    fd = fsImpl.openSync(marker, 'wx', 0o600);
    fsImpl.writeFileSync(fd, `${JSON.stringify({ session_id: sessionId, skill })}\n`, 'utf8');
    fsImpl.closeSync(fd);
    return 'claimed';
  } catch (error) {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_) {}
    }
    return error && error.code === 'EEXIST' ? 'repeat' : 'unavailable';
  }
}

function denialMessage(skill, inspection) {
  const measured = inspection.size === null
    ? 'it is a measured oversized built-in whose body is not resolvable on disk'
    : `its ${inspection.size}-byte body meets the ${THRESHOLD_BYTES}-byte limit`;
  return `Blocked oversized skill "${skill}" in the coordinator because ${measured}. `
    + `Use the delegation escape from session-hygiene.md: Agent(general-purpose, `
    + `"load ${skill}, answer the question, return ≤2K of facts") so the body loads outside `
    + 'the coordinator. This denial happens only once for this skill in this session.';
}

function decide(event, options = {}) {
  try {
    const skill = event && event.tool_input && event.tool_input.skill;
    if (typeof skill !== 'string' || !skill) return { action: 'pass', reason: 'missing-skill' };

    const inspection = inspectSkill(skill, options);
    if (!inspection.oversized) return { action: 'pass', reason: inspection.source, inspection };

    // T1 measured agent_id only in subagent calls. A --agent coordinator is the
    // known exception; warn rather than silently pretending the guard covered it.
    if (event.agent_id) {
      return {
        action: 'pass',
        reason: 'agent-id-present',
        inspection,
        warning: `oversized skill "${skill}" passed because agent_id is present; `
          + 'this may be a subagent (intended) or a --agent coordinator (known coverage hole)',
      };
    }

    if (!options.denyEnabled) {
      return {
        action: 'pass',
        reason: 'deny-inert',
        inspection,
        warning: `skill guard would deny coordinator skill "${skill}" (${inspection.source}), `
          + 'but DENY_ENABLED=false (log-only mode)',
      };
    }

    const sessionId = event.session_id;
    const controlHome = options.controlHome;
    if (typeof sessionId !== 'string' || !sessionId || !controlHome) {
      return { action: 'pass', reason: 'state-unavailable', inspection };
    }
    const claimed = claimFirstDenial(controlHome, sessionId, skill, options);
    if (claimed !== 'claimed') {
      return { action: 'pass', reason: claimed === 'repeat' ? 'repeat' : 'state-unavailable', inspection };
    }
    return { action: 'deny', reason: denialMessage(skill, inspection), inspection };
  } catch (error) {
    return {
      action: 'pass',
      reason: 'error',
      warning: `skill guard failed open: ${error && (error.code || error.message) || 'unknown error'}`,
    };
  }
}

function main() {
  const { event, malformed } = readEventStrict();
  if (malformed) askTool('rstaff: malformed event input; confirm the Skill tool request before continuing.');
  try {
    const result = decide(event, {
      denyEnabled: DENY_ENABLED,
      projectDir: process.env.CLAUDE_PROJECT_DIR,
      userHome: os.homedir(),
      controlHome: resolveHome(event.cwd),
    });
    if (result.warning) warn(result.warning);
    if (result.action === 'deny') denyTool(result.reason);
  } catch (error) {
    warn(`skill guard failed open: ${error && (error.code || error.message) || 'unknown error'}`);
  }
  pass();
}

if (require.main === module) main();

module.exports = {
  DENY_ENABLED,
  THRESHOLD_BYTES,
  MEASURED_OFFENDERS,
  MAX_PLUGIN_DEPTH,
  PRUNED_PLUGIN_DIRS,
  parseSkillName,
  installedPluginPaths,
  resolveSkillBody,
  inspectSkill,
  claimFirstDenial,
  denialMessage,
  decide,
  main,
};
