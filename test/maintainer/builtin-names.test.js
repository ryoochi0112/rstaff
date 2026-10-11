'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { extractNames, findClaudeBinary, extractFromBinary } = require('../../maintainer/lib-builtin-names.js');
const ROOT = path.resolve(__dirname, '../..');
const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'maintainer/builtin-names.json'), 'utf8'));

// Bare names a plugins dir ships: commands/<n>.md basenames and skills/<dir> names.
function shippedNames(pluginsDir) {
  const out = [];
  for (const plugin of fs.readdirSync(pluginsDir)) {
    const commands = path.join(pluginsDir, plugin, 'commands');
    if (fs.existsSync(commands)) {
      for (const f of fs.readdirSync(commands)) if (f.endsWith('.md')) out.push({ plugin, kind: 'command', name: f.slice(0, -3) });
    }
    const skills = path.join(pluginsDir, plugin, 'skills');
    if (fs.existsSync(skills)) {
      for (const d of fs.readdirSync(skills, { withFileTypes: true })) if (d.isDirectory()) out.push({ plugin, kind: 'skill', name: d.name });
    }
  }
  return out;
}
const collisions = (pluginsDir, names) => {
  const set = new Set(names);
  return shippedNames(pluginsDir).filter(s => set.has(s.name));
};

test('frozen list records version, source and the full spec 7(b) set', () => {
  assert.equal(frozen.claudeVersion, '2.1.282');
  assert.ok(frozen.source.length > 20);
  for (const n of ['doctor', 'plan', 'batch', 'usage', 'checkup', 'checkpoint', 'undo', 'cost', 'stats', 'verify', 'simplify', 'security-review'])
    assert.ok(frozen.names.includes(n), `${n} missing from frozen names`);
  for (const n of ['health', 'design', 'sweep', 'spend', 'setup']) assert.ok(!frozen.names.includes(n), `${n} must stay free`);
});

test('no shipped command or skill bare name is a frozen built-in name', () => {
  assert.deepEqual(collisions(path.join(ROOT, 'plugins'), frozen.names), []);
});

test('fixture: a plugin shipping `doctor` (command) or `batch` (skill) is caught', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-builtin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'p', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'p', 'commands', 'doctor.md'), 'x');
  fs.mkdirSync(path.join(dir, 'p', 'skills', 'batch'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'p', 'skills', 'batch', 'SKILL.md'), 'x');
  assert.deepEqual(collisions(dir, frozen.names).map(c => `${c.kind}:${c.name}`).sort(), ['command:doctor', 'skill:batch']);
});

test('extractor reads command registrations, bundled skills and same-object aliases only', () => {
  const text = 'x{type:"local",name:"alpha",d:1,aliases:["a1","a2"]}y{type:"local-jsx",name:"beta",z:{aliases:["nested"]},y:"aliases:[\\"quoted\\"]"}'
    + 'f=>Zo({name:"gamma",menuDescription:"d"})' + 'hl={aliases:["noise"]}' + 'q{type:"prompt",name:"delta"}'
    + 'g({name:"epsilon",aliases:["eps","e2"],argumentHint:""})'
    + 'v({name:"write",description:"Write a file.",inputSchema:{type:"object"}})';
  assert.deepEqual(extractNames(text), ['a1', 'a2', 'alpha', 'beta', 'delta', 'e2', 'eps', 'epsilon', 'gamma']);
});

test('installed claude binary: no built-in name equals a shipped name (skips without claude)', t => {
  const bin = findClaudeBinary();
  if (!bin) return t.skip('claude not on PATH');
  const found = extractFromBinary(bin);
  assert.ok(found.length >= 50, `extractor rot: only ${found.length} names from ${bin}`);
  assert.deepEqual(collisions(path.join(ROOT, 'plugins'), found), []);
});
