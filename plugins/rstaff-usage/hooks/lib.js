// rstaff hook shared library — Node built-ins only, zero dependencies.
// Adapted (clean-room, not copied) from the memory/security hook *patterns* in
// affaan-m/ECC and alirezarezvani/claude-skills. See THIRD_PARTY.md.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Read and parse the JSON event Claude Code sends on stdin. Never throws.
function readEvent() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return {};
    const event = JSON.parse(raw);
    // Context hooks used to crash (exit 1) on `printf 'null'` because valid
    // non-object JSON was handed straight through to object-only callers.
    return event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  } catch (_) {
    return {};
  }
}

// Strict variant for deny-tier hooks, which must distinguish an event-less
// invocation from non-empty input that could not be parsed. Never throws.
function readEventStrict() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return { event: {}, malformed: false };
    const event = JSON.parse(raw);
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { event: {}, malformed: true };
    }
    return { event, malformed: false };
  } catch (_) {
    return { event: {}, malformed: true };
  }
}

// Resolve the rstaff CONTROL repo (where profiles/, LEARNINGS.md, var/ live).
// Marked by an `rstaff.json` file at the repo root.
// Priority: $RSTAFF_HOME -> walk up from cwd for a dir containing rstaff.json -> ~/.rstaff
function resolveHome(cwd) {
  const env = process.env.RSTAFF_HOME;
  if (env && env.trim() && fs.existsSync(path.join(env.trim(), 'rstaff.json'))) return env.trim();
  let dir = cwd || process.cwd();
  for (let i = 0; i < 8 && dir; i++) {
    if (fs.existsSync(path.join(dir, 'rstaff.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(os.homedir(), '.rstaff');
}

// Is `home` a GENUINE rstaff control repo (safe to write memory into)?
// True when RSTAFF_HOME pointed us here, or the dir carries the rstaff.json
// marker (or the plugin's marketplace manifest). Guards against a bare walk-up
// hit on a foreign repo.
function isControlRepo(home) {
  if ((process.env.RSTAFF_HOME || '').trim() === home) return true;
  try {
    return fs.existsSync(path.join(home, 'rstaff.json'))
      || fs.existsSync(path.join(home, '.claude-plugin', 'marketplace.json'));
  } catch (_) { return false; }
}

function slug(s) {
  return String(s || 'project').split(path.sep).filter(Boolean).pop()
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function safeRead(file, max) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (max && t.length > max) t = t.slice(0, max) + '\n…(truncated)';
    return t;
  } catch (_) { return ''; }
}

// One-line stderr diagnostic. Hooks must never block the session, but they must
// not fail silently either (silent memory loss is how v1 ran uninstalled for weeks).
function warn(msg) { try { process.stderr.write(`rstaff: ${msg}\n`); } catch (_) {} }

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { warn(`cannot create ${dir}: ${e.code || e.message}`); }
}

// --- output helpers (Claude Code hook contract) ---
function emitContext(eventName, text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  }));
  process.exit(0);
}
function denyTool(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}
function askTool(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  }));
  process.exit(0);
}
function blockPrompt(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}
function pass() { process.exit(0); }

module.exports = { fs, path, os, readEvent, readEventStrict, resolveHome, isControlRepo, slug, safeRead, ensureDir, warn, emitContext, denyTool, askTool, blockPrompt, pass };
