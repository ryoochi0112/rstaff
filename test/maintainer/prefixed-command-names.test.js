'use strict';
// Command and skill text must name commands the way a user types
// them. A bare `/build` is "unknown command" once rstaff ships as plugins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');

// { commands: Map<name, [plugin]>, qualified: Set<'plugin:name'> } for commands and skills.
function inventory(pluginsDir) {
  const commands = new Map();
  const qualified = new Set();
  for (const plugin of fs.readdirSync(pluginsDir)) {
    const cdir = path.join(pluginsDir, plugin, 'commands');
    if (fs.existsSync(cdir)) {
      for (const f of fs.readdirSync(cdir)) {
        if (!f.endsWith('.md')) continue;
        const name = f.slice(0, -3);
        commands.set(name, [...(commands.get(name) || []), plugin]);
        qualified.add(`${plugin}:${name}`);
      }
    }
    const sdir = path.join(pluginsDir, plugin, 'skills');
    if (fs.existsSync(sdir)) {
      for (const d of fs.readdirSync(sdir, { withFileTypes: true })) if (d.isDirectory()) qualified.add(`${plugin}:${d.name}`);
    }
  }
  return { commands, qualified };
}

function markdownFiles(pluginsDir) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  for (const plugin of fs.readdirSync(pluginsDir)) {
    for (const sub of ['commands', 'skills']) {
      const dir = path.join(pluginsDir, plugin, sub);
      if (fs.existsSync(dir)) walk(dir);
    }
  }
  return out;
}

// Backticked spans that start with a slash command: `/name` or `/plugin:name`.
const SLASH = /`\/([a-z][a-z0-9-]*)(?::([a-z][a-z0-9-]*))?(?=[\s`])/g;

function offenders(pluginsDir) {
  const { commands, qualified } = inventory(pluginsDir);
  const out = [];
  for (const file of markdownFiles(pluginsDir)) {
    const rel = path.relative(pluginsDir, file);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(SLASH)) {
        const [, head, tail] = m;
        if (tail === undefined) {
          if (commands.has(head)) out.push(`${rel}:${i + 1}: bare /${head} — use ${commands.get(head).map(pl => `/${pl}:${head}`).join(' or ')}`);
        } else if (head.startsWith('rstaff') && !qualified.has(`${head}:${tail}`)) {
          out.push(`${rel}:${i + 1}: /${head}:${tail} names no shipped command or skill`);
        }
      }
    });
  }
  return out;
}

test('every backticked slash command in command and skill text is plugin-prefixed and real', () => {
  assert.deepEqual(offenders(path.join(ROOT, 'plugins')), []);
});

test('fixture: bare and dangling names are caught; external names and paths pass', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-prefixed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'rstaff-x', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rstaff-x', 'commands', 'build.md'), [
    'Next step is `/build <slug>`.',
    'Then `/rstaff-x:nope`.',
    'Good: `/rstaff-x:build`, gstack `/browse`, path `/tmp/x`, `/Users/me`.',
  ].join('\n'));
  assert.deepEqual(offenders(dir), [
    'rstaff-x/commands/build.md:1: bare /build — use /rstaff-x:build',
    'rstaff-x/commands/build.md:2: /rstaff-x:nope names no shipped command or skill',
  ]);
});
