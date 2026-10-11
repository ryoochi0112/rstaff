// Structural skill-convention contract tests.
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  EXTERNAL_COMMAND_ALLOWLIST,
  PEER_EXTRA_SKILLS,
  PEER_TABLE_SKILLS,
  PEER_SKILL_ALLOWLIST,
  SKILL_ROSTER,
  lintTree,
  parseFrontmatter,
} = require(path.join(
  __dirname, '..', '..', 'maintainer', 'lib-skill-lint.js',
));

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'rstaff');
const CLI = path.join(ROOT, 'maintainer', 'lib-skill-lint.js');
const HEALTH = path.join(PLUGIN, 'scripts', 'health.js');
const STRUCTURAL_CODES = new Set(['F1', 'F2', 'F3', 'F4', 'F5', 'S1', 'S2']);
const CROSS_REFERENCE_CODES = new Set(['R1', 'R2', 'R3', 'R4', 'R5']);
const health = require(HEALTH);

function tempRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-skill-ci-${tag}-`));
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function skillFile(root, name, text) {
  return writeFile(path.join(root, 'skills', name, 'SKILL.md'), text);
}

function validSkill(name = 'fixture', description = 'fixture description') {
  return `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;
}

function seedSkillRoster(root) {
  for (const name of SKILL_ROSTER) skillFile(root, name, validSkill(name));
}

function fixtureViolations(root) {
  return lintTree(root).violations.filter((item) => item.code !== 'S2');
}

function assertOnlyCode(root, code, offendingFile, includeRoster = false) {
  const violations = includeRoster ? lintTree(root).violations : fixtureViolations(root);
  assert.equal(violations.length, 1, JSON.stringify(violations, null, 2));
  assert.equal(violations[0].code, code);
  assert.equal(path.resolve(violations[0].file), path.resolve(offendingFile));
}

function parseRequiredDisciplines(text) {
  const section = text.replace(/\r\n/g, '\n').split('## Required disciplines\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'required disciplines section must be present');
  const skills = new Set([...section.matchAll(/`(superpowers:[a-z][a-z0-9-]*)`/g)].map(match => match[1]));
  assert.ok(skills.size > 0, 'required disciplines must pin at least one skill');
  return skills;
}

function assertSetEquality(left, right) {
  assert.deepEqual([...left].sort(), [...right].sort());
  assert.deepEqual([...right].sort(), [...left].sort());
}

test('F1 rejects duplicate, unterminated, and multiline frontmatter', () => {
  const cases = [
    ['duplicate', '---\nname: fixture\ndescription: one\nname: duplicate\n---\nbody\n'],
    ['unterminated', '---\nname: fixture\ndescription: one\nbody\n'],
    ['multiline', '---\nname: fixture\ndescription: |\n  folded value\n---\nbody\n'],
  ];

  for (const [tag, text] of cases) {
    const root = tempRoot(`f1-${tag}`);
    const file = skillFile(root, 'fixture', text);
    assert.equal(parseFrontmatter(text).ok, false, `${tag} parser case`);
    assertOnlyCode(root, 'F1', file);
  }
});

test('F1 accepts an otherwise valid CRLF frontmatter block', () => {
  const root = tempRoot('f1-crlf');
  const text = validSkill().replace(/\n/g, '\r\n');
  const file = skillFile(root, 'fixture', text);
  const parsed = parseFrontmatter(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { name: 'fixture', description: 'fixture description' });
  assert.deepEqual(fixtureViolations(root), [], file);
});

test('F2 requires non-empty skill name and description', () => {
  const root = tempRoot('f2');
  const file = skillFile(root, 'fixture', '---\nname: fixture\n---\nbody\n');
  assertOnlyCode(root, 'F2', file);
});

test('F2 requires descriptions on commands and agents', () => {
  for (const kind of ['commands', 'agents']) {
    const root = tempRoot(`f2-${kind}`);
    const file = writeFile(path.join(root, kind, 'fixture.md'), '---\nname: fixture\n---\nbody\n');
    assertOnlyCode(root, 'F2', file);
  }
});

test('F3 requires a skill name to match its directory', () => {
  const root = tempRoot('f3');
  const file = skillFile(root, 'fixture', validSkill('other'));
  assertOnlyCode(root, 'F3', file);
});

test('F4 caps descriptions at 1536 characters', () => {
  const root = tempRoot('f4');
  const file = skillFile(root, 'fixture', validSkill('fixture', 'x'.repeat(1537)));
  assertOnlyCode(root, 'F4', file);
});

test('F5 caps every discovered file below 500 lines', () => {
  const root = tempRoot('f5');
  const lines = ['---', 'name: fixture', 'description: fixture description', '---'];
  while (lines.length < 500) lines.push('body');
  const file = skillFile(root, 'fixture', lines.join('\n'));
  assertOnlyCode(root, 'F5', file);
});

test('S1 rejects entries outside the skill layout', () => {
  const root = tempRoot('s1');
  const file = skillFile(root, 'fixture', validSkill());
  const offendingFile = writeFile(path.join(root, 'skills', 'fixture', 'extra.txt'), 'unexpected\n');
  assertOnlyCode(root, 'S1', offendingFile);
  assert.notEqual(file, offendingFile);
});

test('S1 rejects nested entries inside references', () => {
  const root = tempRoot('s1-depth');
  skillFile(root, 'fixture', validSkill());
  const offendingEntry = path.join(root, 'skills', 'fixture', 'references', 'sub');
  fs.mkdirSync(offendingEntry, { recursive: true });
  assertOnlyCode(root, 'S1', offendingEntry);
});

test('S1 requires every skill directory to contain SKILL.md', () => {
  const root = tempRoot('s1-missing-skill');
  const skillDir = path.join(root, 'skills', 'fixture');
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  assertOnlyCode(root, 'S1', skillDir);
});

test('R1 rejects a cited reference file that does not exist', () => {
  const root = tempRoot('r1');
  const file = skillFile(root, 'fixture', `${validSkill()}Read references/missing.md before continuing.\n`);
  assertOnlyCode(root, 'R1', file);
});

test('R1 ignores references nested in a longer cross-skill path', () => {
  const root = tempRoot('r1-cross-skill');
  const file = skillFile(
    root,
    'fixture',
    `${validSkill()}See skills/other/references/x.md for the other skill's guidance.\n`,
  );
  skillFile(
    root,
    'other',
    `${validSkill('other')}Read references/x.md before continuing.\n`,
  );
  writeFile(
    path.join(root, 'skills', 'other', 'references', 'x.md'),
    'cross-skill guidance\n',
  );
  assert.deepEqual(fixtureViolations(root), [], file);
});

test('R2 rejects an uncited file in references', () => {
  const root = tempRoot('r2');
  skillFile(root, 'fixture', `${validSkill()}Read the skill guidance before continuing.\n`);
  const offendingFile = writeFile(
    path.join(root, 'skills', 'fixture', 'references', 'orphan.md'),
    'orphan reference\n',
  );
  assertOnlyCode(root, 'R2', offendingFile);
});

test('R3 rejects a superpowers skill outside the pinned allowlist', () => {
  const root = tempRoot('r3');
  const file = skillFile(
    root,
    'fixture',
    `${validSkill()}Use superpowers:not-allowlisted when reviewing this change.\n`,
  );
  assertOnlyCode(root, 'R3', file);
});

test('R3 scans templates for superpowers peer references', () => {
  const root = tempRoot('r3-templates');
  const file = writeFile(
    path.join(root, 'templates', 'x.md'),
    'Use superpowers:bogus in this template.\n',
  );
  assertOnlyCode(root, 'R3', file);
});

test('S2 rejects an unpinned skill directory and a missing pinned directory', () => {
  const extraRoot = tempRoot('s2-extra');
  seedSkillRoster(extraRoot);
  const extraDir = path.dirname(skillFile(extraRoot, 'ghost', validSkill('ghost')));
  assertOnlyCode(extraRoot, 'S2', extraDir, true);

  const missingRoot = tempRoot('s2-missing');
  seedSkillRoster(missingRoot);
  const missingDir = path.join(missingRoot, 'skills', SKILL_ROSTER[0]);
  fs.rmSync(missingDir, { recursive: true });
  assertOnlyCode(missingRoot, 'S2', missingDir, true);

  const emptyRoot = tempRoot('s2-empty');
  const emptyViolations = lintTree(emptyRoot).violations;
  assert.ok(emptyViolations.some((item) => (
    item.code === 'S2' && /skills directory must not be empty/.test(item.detail)
  )), JSON.stringify(emptyViolations, null, 2));
});

test('R3 accepts a superpowers skill pinned as a conscious extra', () => {
  assert.ok(Array.isArray(PEER_EXTRA_SKILLS), 'extra peer pins must be exported');
  assert.ok(PEER_EXTRA_SKILLS.includes('superpowers:writing-plans'));
  const root = tempRoot('r3-extra');
  skillFile(
    root,
    'fixture',
    `${validSkill()}Use superpowers:writing-plans for this fixture.\n`,
  );
  assert.deepEqual(fixtureViolations(root), []);
});

test('R4 rejects an unresolvable frontmatter description command', () => {
  const root = tempRoot('r4');
  const file = skillFile(
    root,
    'fixture',
    validSkill('fixture', 'Use /missing-command for this fixture.'),
  );
  assertOnlyCode(root, 'R4', file);
});

test('R4 ticket falsifier: missing skill and command references stay red', () => {
  const root = tempRoot('r4-falsifier');
  const file = skillFile(
    root,
    'a',
    validSkill('a', 'This skill names rstaff:missing and /missing, but neither target exists.'),
  );
  const violations = fixtureViolations(root);
  assert.equal(violations.length, 2, JSON.stringify(violations, null, 2));
  assert.deepEqual(violations.map((item) => item.code), ['R4', 'R4']);
  assert.ok(violations.every((item) => path.resolve(item.file) === path.resolve(file)));
});

test('R4 resolves rstaff command, skill, and agent references by plugin namespace', () => {
  const root = tempRoot('r4-plugin-namespaces');
  const core = path.join(root, 'plugins', 'rstaff');
  const ai = path.join(root, 'plugins', 'rstaff-ai');
  writeFile(path.join(core, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'rstaff' }));
  writeFile(path.join(ai, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'rstaff-ai' }));
  writeFile(path.join(core, 'commands', 'review.md'), '---\ndescription: Core review command.\n---\nReview.\n');
  writeFile(
    path.join(ai, 'commands', 'eval.md'),
    '---\ndescription: Use /rstaff-ai:eval and /rstaff:review.\n---\nUse rstaff-ai:agent-evaluation and rstaff-ai:experiment-analyst.\n',
  );
  writeFile(
    path.join(ai, 'skills', 'agent-evaluation', 'SKILL.md'),
    validSkill('agent-evaluation'),
  );
  writeFile(
    path.join(ai, 'agents', 'experiment-analyst.md'),
    '---\ndescription: Fresh experiment adjudicator.\n---\nRead the record.\n',
  );
  assert.deepEqual(fixtureViolations(root), []);

  const command = path.join(ai, 'commands', 'eval.md');
  fs.writeFileSync(command, fs.readFileSync(command, 'utf8').replace(
    'rstaff-ai:agent-evaluation', 'rstaff-ai:missing-skill',
  ));
  const violations = fixtureViolations(root).filter(item => item.code === 'R4');
  assert.equal(violations.length, 1, JSON.stringify(violations, null, 2));
  assert.match(violations[0].detail, /rstaff-ai:missing-skill/);
});

test('R4 ignores inline and fenced code spans before extraction', () => {
  const root = tempRoot('r4-code-spans');
  skillFile(
    root,
    'fixture',
    validSkill(
      'fixture',
      'Run `gstack /missing-in-span` for details; examples may use ```gstack /missing-fenced```.',
    ),
  );
  assert.deepEqual(fixtureViolations(root), []);
});

test('R4 rejects unresolvable rstaff references in skill, command, and agent bodies', () => {
  for (const kind of ['skill', 'command', 'agent']) {
    const root = tempRoot(`r4-body-rstaff-${kind}`);
    const text = kind === 'skill'
      ? `${validSkill()}Use rstaff:missing-body in this body.\n`
      : `---\ndescription: fixture ${kind}\n---\nUse rstaff:missing-body in this body.\n`;
    const file = kind === 'skill'
      ? skillFile(root, 'fixture', text)
      : writeFile(path.join(root, `${kind}s`, 'fixture.md'), text);
    assertOnlyCode(root, 'R4', file);
    assert.match(fixtureViolations(root)[0].detail, /body/);
  }
});

test('R4 rejects an unresolvable bold skill invocation in a body', () => {
  const root = tempRoot('r4-body-invocation');
  const file = skillFile(
    root,
    'fixture',
    `${validSkill()}Invoke the **ghost** skill before continuing.\n`,
  );
  assertOnlyCode(root, 'R4', file);
  assert.match(fixtureViolations(root)[0].detail, /body/);
});

test('R4 requires bold skill invocations to resolve to a skill directory', () => {
  const root = tempRoot('r4-body-invocation-command-only');
  const file = skillFile(
    root,
    'fixture',
    `${validSkill()}Invoke the **ghost** skill before continuing.\n`,
  );
  writeFile(path.join(root, 'commands', 'ghost.md'), '---\ndescription: ghost command\n---\nbody\n');
  assertOnlyCode(root, 'R4', file);
});

test('R4 rejects an unresolvable backticked bare-name skill invocation in a body', () => {
  const root = tempRoot('r4-body-backticked-invocation');
  const file = skillFile(
    root,
    'fixture',
    `${validSkill()}Load the \`ghost\` skill before continuing.\n`,
  );
  assertOnlyCode(root, 'R4', file);
  assert.match(fixtureViolations(root)[0].detail, /body/);
});

test('R4 ignores body invocations inside fenced blocks and inline code spans', () => {
  const root = tempRoot('r4-body-code-spans');
  skillFile(
    root,
    'fixture',
    `${validSkill()}
\`\`\`md
Invoke the **ghost** skill and use rstaff:ghost.
Load the \`ghost\` skill.
\`\`\`

Use \`rstaff:ghost\` and \`**ghost** skill\` as examples.
`,
  );
  assert.deepEqual(fixtureViolations(root), []);
});

test('R5 rejects a concrete plugin path that does not exist', () => {
  const root = tempRoot('r5');
  const file = skillFile(
    root,
    'fixture',
    `${validSkill()}See rules/missing-rule.md for the required procedure.\n`,
  );
  assertOnlyCode(root, 'R5', file);
});

test('R5 rejects a dead skills path citation', () => {
  const root = tempRoot('r5-skills');
  const file = skillFile(
    root,
    'fixture',
    `${validSkill()}See skills/ghost/SKILL.md for the required procedure.\n`,
  );
  assertOnlyCode(root, 'R5', file);
});

test('S2 live-tree falsifier: deleting every real skill stays red', () => {
  const root = tempRoot('s2-live-falsifier');
  const pluginsRoot = path.join(ROOT, 'plugins');
  const pluginDirs = fs.readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginsRoot, entry.name))
    .filter((plugin) => fs.existsSync(path.join(plugin, '.claude-plugin', 'plugin.json')));
  for (const source of pluginDirs) {
    fs.cpSync(source, path.join(root, 'plugins', path.basename(source)), { recursive: true });
  }
  // Core (plugins/rstaff) ships no skills and has no tracked skills/ dir, so a
  // fresh clone reads it as zero skills instead of failing with ENOENT.
  const skillDirEntries = (base) => {
    const dir = path.join(base, 'skills');
    return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  };
  const liveSkillNames = pluginDirs.flatMap(skillDirEntries)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(liveSkillNames, [...SKILL_ROSTER].sort());

  for (const name of liveSkillNames) {
    const source = pluginDirs.find(base => (
      fs.existsSync(path.join(base, 'skills', name))
    ));
    const owner = path.join(root, 'plugins', path.basename(source));
    fs.rmSync(path.join(owner, 'skills', name), { recursive: true, force: true });
    const violations = lintTree(path.join(root, 'plugins')).violations;
    assert.ok(violations.length > 0, `deleting skills/${name} must produce a violation`);
    assert.ok(
      violations.some((item) => (
        item.code === 'S2' && item.detail === `pinned skill directory is missing: ${name}`
      )),
      JSON.stringify(violations, null, 2),
    );

    if (name === 'grilling') {
      assert.ok(
        violations.some((item) => (
          item.code === 'R4' && /body/.test(item.detail)
            && item.file.endsWith(path.join('commands', 'spec.md'))
        )),
        JSON.stringify(violations, null, 2),
      );
    }
    if (name === 'parallel-build') {
      assert.ok(
        violations.some((item) => (
          item.code === 'R5' && item.file.endsWith(path.join('commands', 'build.md'))
        )),
        JSON.stringify(violations, null, 2),
      );
    }

    fs.cpSync(path.join(source, 'skills', name), path.join(owner, 'skills', name), {
      recursive: true,
    });
  }
});

test('R5 skips placeholder paths in fenced examples', () => {
  const root = tempRoot('r5-placeholder');
  skillFile(
    root,
    'fixture',
    `${validSkill()}\n\`\`\`sh\nnode plugins/rstaff/scripts/<slug>/<repo>.js\n\`\`\`\n`,
  );
  assert.deepEqual(fixtureViolations(root), []);
});

test('R5 still checks concrete paths beside placeholders in fenced examples', () => {
  const root = tempRoot('r5-placeholder-mixed');
  const file = skillFile(
    root,
    'fixture',
    `${validSkill()}\n\`\`\`sh\nnode templates/<slug>.md\ncat rules/definitely-dead.md\n\`\`\`\n`,
  );
  assertOnlyCode(root, 'R5', file);
});

test('R5 skips placeholder paths by token in prose', () => {
  const root = tempRoot('r5-placeholder-prose');
  skillFile(
    root,
    'fixture',
    `${validSkill()}See templates/<slug>.md for the generated template.\n`,
  );
  assert.deepEqual(fixtureViolations(root), []);
});

test('the peer skill pins equal engineer required disciplines in both directions', () => {
  assert.ok(Array.isArray(PEER_TABLE_SKILLS), 'peer table pins must be exported');
  assert.ok(PEER_TABLE_SKILLS.length > 0, 'peer table pins must be non-empty');
  assert.equal(
    new Set(PEER_TABLE_SKILLS).size,
    PEER_TABLE_SKILLS.length,
    'peer table pins must not contain duplicate pins',
  );
  const table = parseRequiredDisciplines(
    fs.readFileSync(path.join(ROOT, 'plugins', 'rstaff-engineer', 'rules', 'superpowers-precedence.md'), 'utf8'),
  );
  assertSetEquality(new Set(PEER_TABLE_SKILLS), table);
  assertSetEquality(new Set(PEER_SKILL_ALLOWLIST), table);
});

test('external command pins are explicit and hand-editable', () => {
  assert.ok(EXTERNAL_COMMAND_ALLOWLIST.includes('/browse'));
});

test('the live plugin tree is clean for structural convention codes', () => {
  const result = lintTree(path.join(ROOT, 'plugins'));
  assert.ok(result.counts.skills > 0, 'live tree must discover skills');
  assert.ok(result.counts.commands > 0, 'live tree must discover commands');
  assert.ok(result.counts.agents > 0, 'live tree must discover agents');
  const violations = result.violations
    .filter((item) => STRUCTURAL_CODES.has(item.code));
  assert.deepEqual(violations, []);
});

test('the live plugin tree is clean for every cross-reference convention code', () => {
  const result = lintTree(path.join(ROOT, 'plugins'));
  const violations = result.violations
    .filter((item) => CROSS_REFERENCE_CODES.has(item.code));
  assert.deepEqual(violations, []);
});

test('CLI exits 0 for a clean root and 1 while naming a violation', () => {
  const clean = tempRoot('cli-clean');
  seedSkillRoster(clean);
  writeFile(path.join(clean, 'commands', 'fixture.md'), '---\ndescription: fixture command\n---\nbody\n');
  writeFile(path.join(clean, 'agents', 'fixture.md'), '---\ndescription: fixture agent\n---\nbody\n');
  const cleanResult = spawnSync(process.execPath, [CLI, clean], { encoding: 'utf8' });
  assert.equal(cleanResult.status, 0, cleanResult.stderr);

  const seeded = tempRoot('cli-seeded');
  skillFile(seeded, 'fixture', validSkill());
  const offendingFile = writeFile(path.join(seeded, 'skills', 'fixture', 'extra.txt'), 'unexpected\n');
  const badResult = spawnSync(process.execPath, [CLI, seeded], { encoding: 'utf8' });
  assert.equal(badResult.status, 1, `${badResult.stdout}\n${badResult.stderr}`);
  const output = `${badResult.stdout}\n${badResult.stderr}`;
  assert.match(output, /S1/);
  assert.ok(output.includes(offendingFile), output);
});

test('CLI rejects missing and empty roots with an error', () => {
  const missingParent = tempRoot('cli-missing');
  const missing = path.join(missingParent, 'does-not-exist');
  const empty = tempRoot('cli-empty');

  for (const root of [missing, empty]) {
    const result = spawnSync(process.execPath, [CLI, root], { encoding: 'utf8' });
    assert.ok(result.status >= 1, `${root}: expected failure, got ${result.status}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /lib-skill-lint:.*(does not exist|no plugin files discovered)/i, output);
    assert.ok(output.includes(root), output);
  }
});

test('health --static leaves skill lint to maintainer verify', () => {
  const result = spawnSync(process.execPath, [HEALTH, '--static'], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, RSTAFF_HOME: ROOT },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /skill-lint/);
  assert.equal(health.checkSkillLint, undefined);
});

test('AC8 rejects nonexistent namespaced slash commands in bodies and descriptions', () => {
  for (const position of ['body', 'description']) {
    const root = tempRoot('ac8-command');
    const core = path.join(root, 'plugins', 'rstaff');
    const engineer = path.join(root, 'plugins', 'rstaff-engineer');
    writeFile(path.join(core, '.claude-plugin', 'plugin.json'), '{"name":"rstaff"}');
    writeFile(path.join(engineer, '.claude-plugin', 'plugin.json'), '{"name":"rstaff-engineer"}');
    const reference = 'Use /rstaff-engineer:nonexistent.';
    const file = writeFile(path.join(core, 'commands', 'fixture.md'),
      `---\ndescription: ${position === 'description' ? reference : 'Fixture'}\n---\n${position === 'body' ? reference : 'Fixture'}\n`);
    const violations = fixtureViolations(root).filter(item => item.code === 'R4');
    assert.ok(violations.length > 0, position);
    assert.ok(violations.every(item => item.file === file && item.detail.includes('rstaff-engineer:nonexistent')), JSON.stringify(violations));
  }
});

test('AC8 resolves real skills and agents and rejects nonexistent units in both positions', () => {
  for (const kind of ['skills', 'agents']) {
    for (const position of ['body', 'description']) {
      const root = tempRoot('ac8-unit');
      const core = path.join(root, 'plugins', 'rstaff');
      const ai = path.join(root, 'plugins', 'rstaff-ai');
      writeFile(path.join(core, '.claude-plugin', 'plugin.json'), '{"name":"rstaff"}');
      writeFile(path.join(ai, '.claude-plugin', 'plugin.json'), '{"name":"rstaff-ai"}');
      const target = kind === 'skills' ? path.join(ai, kind, 'existing', 'SKILL.md') : path.join(ai, kind, 'existing.md');
      writeFile(target, validSkill('existing'));
      const file = writeFile(path.join(core, 'commands', 'fixture.md'),
        `---\ndescription: ${position === 'description' ? 'Use rstaff-ai:existing.' : 'Fixture'}\n---\n${position === 'body' ? 'Use rstaff-ai:existing.' : 'Fixture'}\n`);
      assert.deepEqual(fixtureViolations(root), [], `${kind} ${position}`);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('rstaff-ai:existing', 'rstaff-ai:nonexistent'));
      assertOnlyCode(root, 'R4', file);
    }
  }
});

test('plugins contain no obsolete health or spend command references', () => {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  walk(path.join(ROOT, 'plugins'));
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\/rstaff:(?:doctor|usage)\b|(?<![\w/])\/(?:doctor|usage)(?![\w/-]|\.[a-zA-Z0-9])/, file);
  }
});
