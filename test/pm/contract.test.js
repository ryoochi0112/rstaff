'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'frontmatter must exist');
  return Object.fromEntries(match[1].split('\n').map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
}

test('critic is a named read-only agent with exactly the contracted tools', () => {
  const critic = frontmatter(read('plugins/rstaff-pm/agents/critic.md'));
  assert.equal(critic.name, 'critic');
  assert.deepEqual(critic.tools.split(',').map(tool => tool.trim()), ['Read', 'Grep', 'Glob']);
});

test('interview reviews rendered tickets before confirmation and fails closed', () => {
  const interview = read('plugins/rstaff-pm/commands/interview.md');
  assert.ok(frontmatter(interview)['allowed-tools'].split(',').map(tool => tool.trim()).includes('Task'));
  const headings = [...interview.matchAll(/^## .*$/gm)];
  const index = word => headings.find(heading => heading[0].includes(word))?.index ?? -1;
  const render = index('Render');
  const critic = index('Critic');
  const confirm = index('Confirm');
  assert.ok(render >= 0 && critic >= 0 && confirm >= 0, 'Render, Critic and Confirm headings must exist');
  assert.ok(render < critic && critic < confirm, 'phase order must be Render < Critic < Confirm');
  const criticPhase = interview.slice(critic, confirm);
  for (const required of ['rstaff-pm:critic', 'Critic (fresh context):', '  pass', '  reject: ']) {
    assert.ok(criticPhase.includes(required), `critic phase missing ${JSON.stringify(required)}`);
  }
  assert.match(criticPhase, /file[s]? nothing/i);
  assert.ok(interview.includes('list --repo'));
  assert.ok(interview.includes('--json'));
  assert.match(interview, /superpowers:brainstorming[^\n]{0,120}installed/);
});

test('spec supports ticket lookup and repo-less PM token resolution', () => {
  const spec = read('plugins/rstaff-pm/commands/spec.md');
  assert.ok(frontmatter(spec)['allowed-tools'].split(',').map(tool => tool.trim()).includes('Task'),
    'spec allowed-tools must include Task');
  assert.ok(spec.includes('^[A-Z]+-\\d+$'));
  assert.ok(spec.includes('list --repo <token> --json'));
  assert.match(spec, /profile token[\s\S]*exactly one `backlog\/\*\.md`[\s\S]*ask the human once/);
  assert.ok(spec.includes('$CTRL/var/specs/<token>/<slug>.md'));
  assert.match(spec, /no product checkout[\s\S]*skip codebase/);
});

test('spec keeps brainstorming and the located precedence citation optional', () => {
  const spec = read('plugins/rstaff-pm/commands/spec.md');
  assert.match(spec, /superpowers:brainstorming[^\n]{0,120}installed/);
  assert.ok(spec.includes('$(node "${CLAUDE_PLUGIN_ROOT}/scripts/locate.js" rstaff-engineer)/rules/superpowers-precedence.md'));
  assert.ok(spec.includes('(when rstaff-engineer is installed)'));
  assert.ok(!spec.includes('${CLAUDE_PLUGIN_ROOT}/rules/'));
});

test('spec reviews only numbered criteria after writing and reports unreviewed failures', () => {
  const spec = read('plugins/rstaff-pm/commands/spec.md');
  const write = spec.indexOf('## Write the spec');
  const critic = spec.indexOf('## Critic');
  assert.ok(write >= 0 && critic > write, 'spec must be written before critic review');
  const criticPhase = spec.slice(critic, spec.indexOf('## Hand off'));
  for (const required of ['rstaff-pm:critic', 'fresh Task', 'only the written spec\'s',
    'numbered acceptance criteria, keyed by criterion number', '<number>  pass',
    '<number>  reject: <reason>', 'Critic (fresh context):',
    'Criteria the critic cannot falsify: <numbers or none>', 'rejected criterion']) {
    assert.ok(criticPhase.includes(required), `spec critic phase missing ${JSON.stringify(required)}`);
  }
  assert.match(criticPhase, /Task fails[\s\S]*spec is written but unreviewed/);
  assert.match(criticPhase, /Never claim it was\s+reviewed/);
});
