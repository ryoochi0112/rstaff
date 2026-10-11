'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { convertSuite } = require('../../maintainer/convert-evals.js');

const ROOT = path.resolve(__dirname, '../..');
// Frozen legacy trigger entries, compliance evals, and assertion totals.
const COUNTS = {
  'agent-evaluation': [7, 1, 4],
  'data-science': [6, 1, 3],
  'datadog-llmobs-analysis': [7, 2, 6],
  'experiment-design': [7, 1, 6],
  grilling: [7, 1, 3],
  'harness-validation': [7, 1, 6],
  'parallel-build': [9, 1, 8],
  'token-efficient-delegation': [7, 1, 5],
};
const PINNED_SKILL_ROSTER = Object.keys(COUNTS).sort();
// A first-turn file read may happen before the Skill call, so
// this case gets one spare turn; every other compliance case stays at 2.
const COMPLIANCE_MAX_TURNS = { 'resume-ledger-with-review': 3 };
const ALLOWED_SIBLING_TARGETS = new Set([...PINNED_SKILL_ROSTER, 'superpowers:brainstorming']);

function cases() {
  return fs.globSync('plugins/*/evals/**/case.yaml', { cwd: ROOT }).sort().map((file) => ({
    file, value: JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')),
  }));
}

function keys(value, allowed) {
  for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `Unknown schema key: ${key}`);
}

function nonempty(value) {
  assert.equal(typeof value, 'string');
  assert.ok(value.trim());
}

test('case counts and assertion totals equal the frozen seven-skill roster', () => {
  const all = cases();
  const suiteNames = fs.globSync('plugins/*/evals/*', { cwd: ROOT })
    .filter((file) => fs.statSync(path.join(ROOT, file)).isDirectory())
    .map((file) => file.split('/')[3]);
  assert.deepEqual(suiteNames.sort(), PINNED_SKILL_ROSTER.flatMap((skill) => [`${skill}-trigger`, `${skill}-compliance`]).sort());
  const shipped = fs.globSync('plugins/*/skills/*/SKILL.md', { cwd: ROOT }).map((file) => file.split('/')[3]).sort();
  assert.deepEqual(shipped, PINNED_SKILL_ROSTER);
  const { SKILL_ROSTER } = require('../../maintainer/lib-skill-lint.js');
  assert.deepEqual([...SKILL_ROSTER].sort(), PINNED_SKILL_ROSTER);
  assert.deepEqual([...new Set(all.map(({ file }) => file.split('/')[3].replace(/-(trigger|compliance)$/, '')))].sort(), PINNED_SKILL_ROSTER);
  for (const skill of PINNED_SKILL_ROSTER) {
    const trigger = all.filter(({ file }) => file.split('/')[3] === `${skill}-trigger`);
    const compliance = all.filter(({ file }) => file.split('/')[3] === `${skill}-compliance`);
    assert.deepEqual([trigger.length, compliance.length, compliance.reduce((sum, { value }) => sum + value.graders.length, 0)], COUNTS[skill], skill);
    const owners = fs.globSync(`plugins/*/skills/${skill}/SKILL.md`, { cwd: ROOT })
      .map((file) => file.split('/')[1]);
    assert.equal(owners.length, 1, `${skill} must have exactly one plugin owner; found ${owners.join(', ')}`);
    const owner = owners[0];
    for (const entry of [...trigger, ...compliance]) {
      assert.ok(
        entry.file.startsWith(`plugins/${owner}/evals/`),
        `${skill} eval case ${entry.file} must live under plugins/${owner}/evals/`,
      );
    }
  }
});

test('every case is JSON using only measured schema keys', () => {
  for (const { file, value } of cases()) {
    keys(value, ['schema_version', 'name', 'description', 'tags', 'plugins', 'context', 'execution', 'runs', 'graders']);
    assert.equal(value.schema_version, '1.0');
    assert.equal(value.name, `${file.split('/')[3]}-${file.split('/')[4]}`);
    assert.ok(value.tags.every((tag) => typeof tag === 'string'));
    keys(value.execution, ['prompt', 'max_turns', 'timeout_seconds', 'model', 'allowed_tools', 'append_system_prompt', 'env']);
    nonempty(value.execution.prompt);
    if (value.context) keys(value.context, ['scaffold_script', 'history_file', 'add_dirs']);
    assert.ok(value.graders.length >= 1);
    for (const grader of value.graders) {
      const allowed = {
        llm: ['name', 'type', 'criteria'],
        regex: ['name', 'type', 'pattern', 'flags'],
        tool_used: ['name', 'type', 'tool', 'input_match', 'min', 'max'],
      }[grader.type];
      assert.ok(allowed, `Unknown grader type: ${grader.type}`);
      keys(grader, allowed);
      nonempty(grader.name);
    }
  }
});

test('trigger and compliance semantics preserve budgets and sibling negatives', () => {
  const all = cases();
  for (const skill of PINNED_SKILL_ROSTER) {
    const triggers = all.filter(({ file }) => file.split('/')[3] === `${skill}-trigger`);
    let positives = 0;
    let negatives = 0;
    let siblings = 0;
    for (const { value } of triggers) {
      assert.equal(value.runs, 3);
      assert.deepEqual(value.execution, { prompt: value.execution.prompt, model: 'sonnet', max_turns: 4, timeout_seconds: 180 });
      assert.ok(value.tags.includes(skill) && value.tags.includes('trigger'));
      assert.equal(value.graders.length, 1);
      const grader = value.graders[0];
      assert.equal(grader.type, 'tool_used');
      assert.equal(grader.tool, 'Skill');
      assert.equal(grader.input_match, skill);
      if (grader.min === 0) {
        assert.equal(grader.max, 0);
        negatives++;
      } else {
        assert.equal(grader.min ?? 1, 1);
        assert.equal(grader.max, undefined);
        positives++;
      }
      for (const tag of value.tags.filter((tag) => tag.startsWith('sibling:'))) {
        const sibling = tag.slice('sibling:'.length);
        assert.equal(grader.min, 0);
        assert.notEqual(sibling, skill);
        assert.ok(ALLOWED_SIBLING_TARGETS.has(sibling));
        siblings++;
      }
    }
    assert.ok(positives >= 3 && negatives >= 3 && siblings >= 1, skill);
    for (const { file, value } of all.filter(({ file }) => file.split('/')[3] === `${skill}-compliance`)) {
      assert.equal(value.runs, 5);
      const maxTurns = COMPLIANCE_MAX_TURNS[file.split('/')[4]] ?? 2;
      assert.deepEqual(value.execution, { prompt: value.execution.prompt, model: 'haiku', max_turns: maxTurns, timeout_seconds: 120 });
      assert.ok(value.tags.includes(skill) && value.tags.includes('compliance'));
      assert.ok(value.graders.length >= 1);
      nonempty(value.description);
      // Regex graders score literal patterns without an LLM judge;
      // a tool_used grader may require that the skill under test was loaded.
      for (const grader of value.graders) {
        if (grader.type === 'llm') nonempty(grader.criteria);
        else if (grader.type === 'regex') new RegExp(grader.pattern, grader.flags);
        else {
          assert.equal(grader.type, 'tool_used');
          assert.equal(grader.tool, 'Skill');
          assert.equal(grader.input_match, skill);
        }
      }
    }
  }
});

test('convertSuite maps a small fixture to exact case objects', () => {
  const actual = convertSuite('grilling', [
    { query: 'Clarify', should_trigger: true },
    { query: 'Explore', should_trigger: false, sibling: 'superpowers:brainstorming' },
  ], { skill_name: 'grilling', evals: [{ id: 'example', prompt: 'Ask one question', expected_output: 'One question', assertions: ['judge: one meaningful question', 'predicate: no design'] }] });
  assert.deepEqual(actual, [
    { relPath: 'rstaff-pm/evals/grilling-trigger/01/case.yaml', caseObject: {
      schema_version: '1.0', name: 'grilling-trigger-01', tags: ['grilling', 'trigger'],
      execution: { prompt: 'Clarify', model: 'sonnet', max_turns: 4, timeout_seconds: 180 }, runs: 3,
      graders: [{ name: 'skill-trigger', type: 'tool_used', tool: 'Skill', input_match: 'grilling' }],
    } },
    { relPath: 'rstaff-pm/evals/grilling-trigger/02/case.yaml', caseObject: {
      schema_version: '1.0', name: 'grilling-trigger-02', tags: ['grilling', 'trigger', 'sibling:superpowers:brainstorming'],
      execution: { prompt: 'Explore', model: 'sonnet', max_turns: 4, timeout_seconds: 180 }, runs: 3,
      graders: [{ name: 'skill-trigger', type: 'tool_used', tool: 'Skill', input_match: 'grilling', min: 0, max: 0 }],
    } },
    { relPath: 'rstaff-pm/evals/grilling-compliance/example/case.yaml', caseObject: {
      schema_version: '1.0', name: 'grilling-compliance-example', description: 'Legacy id: example\nExpected output: One question', tags: ['grilling', 'compliance'],
      execution: { prompt: 'Ask one question', model: 'haiku', max_turns: 2, timeout_seconds: 120 }, runs: 5,
      graders: [{ name: 'assertion-1', type: 'llm', criteria: 'judge: one meaningful question' }, { name: 'assertion-2', type: 'llm', criteria: 'predicate: no design' }],
    } },
  ]);
});

const FLAGS = ['--ablation', 'none', '--no-publish', '--trust-plugin', '--threshold', '0.6'];
const STUB = '#!/bin/sh\nnode -e \'require("fs").appendFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(1))+"\\n")\' -- "$@"\nexit "${STUB_EXIT:-0}"\n';
function sandbox(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-eval-'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'claude'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'bin', 'make'), STUB, { mode: 0o755 });
  const log = path.join(root, 'argv');
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, ARGV_LOG: log };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  try { body({ root, env, calls, log }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function suite(root, owner, skill) {
  fs.mkdirSync(path.join(root, 'plugins', owner, 'skills', skill), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', owner, 'evals', `${skill}-trigger`), { recursive: true });
}

// Real make (not -n): GNU Make 3.81 expands command-line variables while exporting
// them to the recipe env, which -n never builds. Stub claude logs argv per call.
function evalSuite(root, owner, skill) {
  suite(root, owner, skill);
  fs.mkdirSync(path.join(root, 'plugins', owner, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', owner, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: owner, dependencies: ['rstaff'] }));
}
function realMake(root, env, args, extra = {}) {
  const tmp = path.join(root, 'evals-tmp');
  const res = spawnSync('/usr/bin/make', ['-f', path.join(ROOT, 'Makefile'), 'evals', ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...env, RSTAFF_EVALS_TMP: tmp, RSTAFF_EVALS_OUT: path.join(root, 'evals-out'), ...extra },
  });
  const residue = fs.existsSync(tmp) ? fs.readdirSync(tmp) : [];
  return { ...res, tmp, residue };
}

test('Makefile preserves both injection stages, scoped owners, all plugins and failure exits', () => {
  for (const payload of ['grilling', 'x; echo INJECTED', "x'; echo INJECTED; :'", "grilling' --threshold 0 #", '$(shell touch __SENTINEL__)']) {
    sandbox(({ root, env, calls }) => {
      const sentinel = path.join(root, 'INJECTED');
      const skill = payload.replace('__SENTINEL__', sentinel);
      // A legal skill directory containing shell metacharacters lets the stub observe
      // the complete value, rather than merely proving unknown names are rejected.
      evalSuite(root, 'rstaff-engineer', skill);
      const run = realMake(root, env, [`SKILL=${skill}`]);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(fs.existsSync(sentinel), false, 'make/shell injection');
      assert.doesNotMatch(run.stdout, /INJECTED/);
      const [call, ...rest] = calls();
      assert.deepEqual(rest, []);
      assert.deepEqual(call.slice(0, 2), ['plugin', 'eval']);
      assert.ok(call[2].startsWith(`${run.tmp}/`), call[2]);
      assert.equal(path.basename(call[2]), 'rstaff-engineer');
      assert.deepEqual(call.slice(3, 3 + FLAGS.length), FLAGS);
      assert.deepEqual(call.slice(3 + FLAGS.length, 5 + FLAGS.length), ['--case', `${skill}-*`]);
      assert.deepEqual(run.residue, [], 'copy root residue');
    });
  }
  sandbox(({ root, env, calls, log }) => {
    evalSuite(root, 'rstaff-engineer', 'grilling');
    evalSuite(root, 'rstaff-ai', 'agent-evaluation');
    evalSuite(root, 'rstaff-delegation', 'token-efficient-delegation');
    fs.mkdirSync(path.join(root, 'plugins', 'rstaff'));
    const all = realMake(root, env, []);
    assert.equal(all.status, 0, all.stderr);
    assert.deepEqual(calls().map((c) => path.basename(c[2])), ['rstaff-ai', 'rstaff-delegation', 'rstaff-engineer']);
    assert.ok(calls().every((c) => !c.includes('--case')));
    fs.unlinkSync(log);
    // GNU Make reports 2 for any recipe failure; the exact code is the runner's (run-evals.test.js).
    assert.equal(realMake(root, env, [], { STUB_EXIT: '7' }).status, 2);
    assert.equal(calls().length, 1);
    // AC 7: no eval copy left behind on pass or fail.
    for (const code of ['0', '1']) {
      const one = realMake(root, env, ['SKILL=grilling'], { STUB_EXIT: code });
      assert.equal(one.status, code === '0' ? 0 : 2, one.stderr);
      assert.match(one.stdout, new RegExp(`eval copy root: ${one.tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.deepEqual(one.residue, [], `residue after stub exit ${code}`);
    }
    fs.unlinkSync(log);
    const unknown = realMake(root, env, ['SKILL=missing']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /No eval owner for skill: missing/);
    assert.deepEqual(calls(), []);
  });
});

test('ship gate evaluates every changed skill and keeps deletion, gap and failure branches', () => {
  const ship = fs.readFileSync(path.join(ROOT, 'plugins/rstaff/commands/ship.md'), 'utf8');
  const block = ship.match(/```bash\n(\s*\[ -n "\$\{changed_paths\+x\}"[\s\S]*?)\n\s*```/)[1];
  const runGate = (fixture, paths, extraEnv = {}) => spawnSync('bash', ['-c', block.replace('$(git rev-parse --show-toplevel)', '"$TEST_ROOT"')], {
    cwd: fixture.root, env: { ...fixture.env, TEST_ROOT: fixture.root, changed_paths: paths, ...extraEnv }, encoding: 'utf8',
  });
  sandbox((fixture) => {
    const { root, calls, log } = fixture;
    fs.writeFileSync(path.join(root, 'rstaff.json'), '{}');
    suite(root, 'rstaff-engineer', 'grilling');
    suite(root, 'rstaff-ai', 'agent-evaluation');
    fs.renameSync(path.join(root, 'plugins/rstaff-ai/evals/agent-evaluation-trigger'),
      path.join(root, 'plugins/rstaff-ai/evals/agent-evaluation-compliance'));
    const changed = 'plugins/rstaff-engineer/skills/grilling/SKILL.md\nplugins/rstaff-ai/skills/agent-evaluation/SKILL.md\nplugins/rstaff-engineer/skills/grilling/reference.md\nplugins/rstaff-ai/skills/deleted/SKILL.md';
    assert.equal(runGate(fixture, changed).status, 0);
    assert.deepEqual(calls(), [['evals', 'SKILL=agent-evaluation'], ['evals', 'SKILL=grilling']]);
    fs.unlinkSync(log);
    fs.mkdirSync(path.join(root, 'plugins', 'rstaff-engineer', 'skills', 'new-skill'));
    const gap = runGate(fixture, 'plugins/rstaff-engineer/skills/new-skill/SKILL.md');
    assert.equal(gap.status, 1);
    assert.match(gap.stdout, /coverage gap.*STOP/);
    assert.deepEqual(calls(), []);
    assert.equal(runGate(fixture, changed, { STUB_EXIT: '9' }).status, 9);
    assert.equal(calls().length, 1);
    fs.unlinkSync(log);
    assert.equal(runGate(fixture, 'README.md').status, 0);
    assert.deepEqual(calls(), []);
    fs.unlinkSync(path.join(root, 'rstaff.json'));
    assert.equal(runGate(fixture, changed).status, 0);
    assert.deepEqual(calls(), []);
  });
});
