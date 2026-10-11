'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { slug } = require('../hooks/lib.js');

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function resolveVerify(top, ctrl) {
  const profile = readOptional(path.join(ctrl, 'profiles', `${slug(top)}.md`));
  const line = profile.split('\n').find((text) => /^\s*\*\*Verify \(DoD\):\*\*/.test(text));
  const match = line && line.match(/`([^`]+)`/);
  if (match) return expandVerify(match[1]);
  if (/^verify:/m.test(readOptional(path.join(top, 'Makefile')))) return 'make verify';
  try {
    if (!fs.existsSync(path.join(ctrl, 'rstaff.json'))) return null;
    if (fs.realpathSync(top) !== fs.realpathSync(ctrl)) return null;
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    const ignored = spawnSync('git', ['-C', top, 'check-ignore', '-q', 'var/gate/probe'], { env });
    if (ignored.error || ignored.status !== 0) return null;
    return `node ${shellquote(path.join(path.resolve(__dirname, '..'), 'scripts', 'lib-backlog.js'))} validate`;
  } catch (_) {
    return null;
  }
}

function validSid(sid) {
  return typeof sid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sid);
}
function statePath(ctrl, sid) {
  if (!validSid(sid)) throw new Error('invalid session id');
  return path.join(ctrl, 'var', 'gate', `${sid}.json`);
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateState(state) {
  if (!object(state) || state.v !== 1 || !object(state.repos)
    || Object.values(state.repos).some((entry) => !object(entry)
      || !(entry.baseline === null || typeof entry.baseline === 'string')
      || !Array.isArray(entry.greens) || entry.greens.some((green) => typeof green !== 'string')
      || !object(entry.blocks) || Object.values(entry.blocks).some((n) => !Number.isSafeInteger(n) || n < 0))) {
    throw new Error('invalid gate state');
  }
}
function loadState(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { v: 1, repos: {} };
    throw error;
  }
  const state = JSON.parse(raw);
  validateState(state);
  return state;
}
function saveState(file, state) {
  validateState(state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function repoEntry(state, top) {
  if (!Object.hasOwn(state.repos, top)) {
    Object.defineProperty(state.repos, top, {
      value: { baseline: null, greens: [], blocks: {} }, enumerable: true, writable: true, configurable: true,
    });
  }
  return state.repos[top];
}
function shellquote(s) {
  let escaped = String(s);
  escaped = escaped.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}
// Profile aliases for core-owned verify scripts; only an exact whole value expands.
const VERIFY_ALIASES = {
  'rstaff:nbgate': `node ${shellquote(path.join(path.resolve(__dirname, '..'), 'scripts', 'nbgate.js'))}`,
};
function expandVerify(cmd) {
  return Object.hasOwn(VERIFY_ALIASES, cmd) ? VERIFY_ALIASES[cmd] : cmd;
}

// Preserve source text verbatim; heredoc data is consumed before scanning resumes.
function splitTopLevel(cmd) {
  const parts = [];
  const heredocs = [];
  let start = 0;
  let quote = null;
  let depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (c === '#' && (i === 0 || /\s/.test(cmd[i - 1]))) {
      const end = cmd.indexOf('\n', i);
      if (end === -1) break;
      i = end - 1;
      continue;
    }
    if (cmd.startsWith('<<', i) && cmd[i + 2] !== '<' && cmd[i - 1] !== '<') {
      const match = cmd.slice(i).match(/^<<(-)?[ \t]*((?:[^\s|&;<>"'\\]+|'[^']*'|"[^"]*"|\\.)+)/);
      if (match) {
        const delimiter = match[2].replace(/['"]/g, '').replace(/\\(.)/g, '$1');
        heredocs.push({ delimiter, tabs: !!match[1] });
        i += match[0].length - 1;
        continue;
      }
    }
    if (c === '\n' && heredocs.length) {
      let cursor = i + 1;
      for (const doc of heredocs.splice(0)) {
        let found = false;
        while (cursor < cmd.length) {
          let end = cmd.indexOf('\n', cursor);
          if (end === -1) end = cmd.length;
          const line = cmd.slice(cursor, end);
          cursor = end < cmd.length ? end + 1 : end;
          if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
            found = true;
            break;
          }
        }
        if (!found) return [...parts, { text: cmd.slice(start), sep: '' }];
      }
      i = cursor - 1;
      if (cmd[i] !== '\n') break;
    }
    const sep = cmd.slice(i, i + 2) === '||' || cmd.slice(i, i + 2) === '&&'
      ? cmd.slice(i, i + 2) : /[|;\n]/.test(cmd[i]) ? cmd[i] : '';
    if (sep) {
      parts.push({ text: cmd.slice(start, i), sep });
      i += sep.length - 1;
      start = i + 1;
    }
  }
  parts.push({ text: cmd.slice(start), sep: '' });
  return parts;
}
function rewriteCommand(cmd, verifyCmd, runnerPath, sid) {
  let changed = false;
  const rewritten = splitTopLevel(cmd).map(({ text, sep }) => {
    const trimmed = text.trim();
    const redirect = trimmed.match(/(\s+\d?>&?\d?\s*\S*)+$/);
    const suffix = redirect ? redirect[0] : '';
    const base = suffix ? trimmed.slice(0, -suffix.length).trim() : trimmed;
    if (base !== verifyCmd) return text + sep;
    changed = true;
    const leading = text.match(/^\s*/)[0];
    const trailing = text.match(/\s*$/)[0];
    return `${leading}node ${shellquote(runnerPath)} ${shellquote(sid)} ${shellquote(verifyCmd)}${suffix}${trailing}${sep}`;
  }).join('');
  return changed ? rewritten : null;
}
module.exports = { resolveVerify, expandVerify, validSid, statePath, loadState, saveState, repoEntry, shellquote, splitTopLevel, rewriteCommand };
