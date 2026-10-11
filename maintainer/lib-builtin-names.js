'use strict';
// Re-extract Claude Code's built-in command / skill names from the installed binary.
// The binary is a single executable with the JS bundle embedded; the registrations are
// plain strings: `type:"local|local-jsx|prompt",name:"x"` for commands, `aliases:[...]`
// inside the same object, and `name:"x"` next to bundled-skill registrations.
const fs = require('node:fs');
const path = require('node:path');

const COMMAND = /type:"(?:local|local-jsx|prompt)",name:"([a-z][a-z0-9-]*)"/g;
const ALIASES = /aliases:\[((?:"[^"]*",?)*)\]/;
// Minified call name varies (`Zo({name:"batch",menuDescription:...`). Tool registrations have the
// same shape but carry an `inputSchema` right after the description; those are not commands.
const NAME_ALIASES = /\bname:"([a-z][a-z0-9-]*)",aliases:\[((?:"[^"]*",?)*)\]/g;
const BUNDLED_SKILL = /[A-Za-z_$][\w$]*\(\{name:"([a-z][a-z0-9-]*)",(?:menuDescription|description):/g;

// Pure: names from the text of the binary (latin1-decoded). Aliases count only when they
// sit in the same registration object as a command (the bundle also holds syntax-highlighter
// alias tables that are not command names).
// Alias list at the top level of the registration object starting at `from` (just after
// `name:"x"`), or []. Skips string literals and nested brackets; stops at the closing brace.
function topLevelAliases(text, from, limit = 1500) {
  let depth = 0, i = from;
  const end = Math.min(text.length, from + limit);
  while (i < end) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < end && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (depth === 0 && text.startsWith('aliases:[', i)) {
      const a = ALIASES.exec(text.slice(i, i + 400));
      return a ? [...a[1].matchAll(/"([^"]*)"/g)].map(x => x[1]) : [];
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { if (depth === 0) break; depth--; }
    i++;
  }
  return [];
}

// Pure: names from the text of the binary (latin1-decoded). Aliases count only at the top level
// of a command registration object (the bundle also holds syntax-highlighter alias tables that
// are not command names).
function extractNames(text) {
  const names = new Set();
  let m;
  COMMAND.lastIndex = 0;
  while ((m = COMMAND.exec(text))) {
    names.add(m[1]);
    for (const alias of topLevelAliases(text, m.index + m[0].length)) if (/^[a-z][a-z0-9-]*$/.test(alias)) names.add(alias);
  }
  // Registrations whose `aliases` directly follows `name` (e.g. rewind, doctor).
  NAME_ALIASES.lastIndex = 0;
  while ((m = NAME_ALIASES.exec(text))) {
    names.add(m[1]);
    for (const alias of m[2].matchAll(/"([^"]*)"/g)) if (/^[a-z][a-z0-9-]*$/.test(alias[1])) names.add(alias[1]);
  }
  BUNDLED_SKILL.lastIndex = 0;
  while ((m = BUNDLED_SKILL.exec(text))) {
    const next = text.slice(m.index + m[0].length, m.index + m[0].length + 600);
    if (!/^"(?:[^"\\]|\\.)*",inputSchema:/.test(next)) names.add(m[1]);
  }
  return [...names].sort();
}

// Resolve `claude` on PATH to the real binary (follow symlinks). null when absent.
function findClaudeBinary(env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function extractFromBinary(file) {
  return extractNames(fs.readFileSync(file).toString('latin1'));
}

module.exports = { extractNames, findClaudeBinary, extractFromBinary };
