'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const AGENT = 'plugins/rstaff-ds/agents/analysis-reviewer.md';
const COMMAND = 'plugins/rstaff-ds/commands/review.md';
const SKILL = 'plugins/rstaff-ds/skills/data-science/SKILL.md';

function checklistKeys() {
  const body = read(SKILL).split(/^## Review checklist\s*$/m)[1];
  assert.ok(body, 'SKILL.md has a Review checklist section');
  const section = body.split(/^## /m)[0];
  return [...section.matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
}

test('checklist has five keys', () => {
  assert.equal(checklistKeys().length, 5);
});

test('agent is read-only: tools line is exactly Read, Grep, Glob', () => {
  const front = read(AGENT).split(/^---$/m)[1];
  assert.deepEqual(front.match(/^tools:.*$/gm), ['tools: Read, Grep, Glob']);
  assert.match(front, /^name: analysis-reviewer$/m);
});

test('agent body names every checklist key and the verdict contract', () => {
  const body = read(AGENT).split(/^---$/m).slice(2).join('---');
  for (const key of checklistKeys()) assert.ok(body.includes('`' + key + '`'), `agent names ${key}`);
  assert.ok(body.includes('verdict: pass'));
  assert.ok(body.includes('verdict: fail ('));
  assert.ok(body.includes('cell <n>  <key>: <finding>'));
});

test('command spawns the reviewer fresh, with only the two paths', () => {
  const cmd = read(COMMAND);
  assert.ok(cmd.includes('rstaff-ds:analysis-reviewer'));
  assert.ok(cmd.includes('review did not run'));
  assert.ok(cmd.includes('locate.js" rstaff-ds'));
  const prompt = cmd.match(/^PROMPT: (.*)$/m);
  assert.ok(prompt, 'command has a PROMPT: template line');
  assert.deepEqual(prompt[1].match(/<[a-z-]+>/g), ['<notebook-abs-path>', '<skill-abs-path>']);
  assert.match(cmd, /never pass[^.]*(conversation|reasoning)/i);
});
