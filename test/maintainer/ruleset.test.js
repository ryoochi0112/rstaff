'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readWorkflow } = require('../../maintainer/ci-workflow.js');

const ROOT = path.resolve(__dirname, '../..');

function requiredContext(root) {
  const ruleset = JSON.parse(fs.readFileSync(
    path.join(root, '.github/rulesets/main-verify.json'), 'utf8'));
  return ruleset.rules[0].parameters.required_status_checks[0].context;
}

function jobName(root) {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  return readWorkflow(workflow).jobs[0].name;
}

function assertConsistent(root) {
  const context = requiredContext(root);
  const name = jobName(root);
  if (context !== name) {
    throw new Error(`required check context "${context}" does not match CI job name "${name}"`);
  }
  return context;
}

test('main-verify ruleset has the required shape', () => {
  const ruleset = JSON.parse(fs.readFileSync(
    path.join(ROOT, '.github/rulesets/main-verify.json'), 'utf8'));

  assert.strictEqual(ruleset.enforcement, 'active');
  assert.strictEqual(ruleset.target, 'branch');
  assert.deepStrictEqual(ruleset.bypass_actors, []);
  assert.deepStrictEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.strictEqual(ruleset.rules.length, 1);
  assert.strictEqual(ruleset.rules[0].type, 'required_status_checks');
  assert.strictEqual(ruleset.rules[0].parameters.required_status_checks.length, 1);
  assert.strictEqual(ruleset.rules[0].parameters.required_status_checks[0].integration_id, 15368);
});

test('ruleset context equals the CI job name', () => {
  const shared = assertConsistent(ROOT);
  assert.strictEqual(shared, jobName(ROOT));
  assert.strictEqual(typeof shared, 'string');
  assert.ok(shared.length > 0);
});

test('renaming the CI job makes the consistency check fail naming both strings', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruleset-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const rulesetDir = path.join(tmp, '.github/rulesets');
  const workflowsDir = path.join(tmp, '.github/workflows');
  fs.mkdirSync(rulesetDir, { recursive: true });
  fs.mkdirSync(workflowsDir, { recursive: true });

  fs.copyFileSync(path.join(ROOT, '.github/rulesets/main-verify.json'),
    path.join(rulesetDir, 'main-verify.json'));
  const workflowPath = path.join(workflowsDir, 'ci.yml');
  fs.copyFileSync(path.join(ROOT, '.github/workflows/ci.yml'), workflowPath);

  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const renamedWorkflow = workflow.replace(/^    name: make check \(plugin verify\)$/m,
    '    name: make check (renamed)');
  assert.notStrictEqual(renamedWorkflow, workflow, 'expected the CI job name replacement to change the file');
  fs.writeFileSync(workflowPath, renamedWorkflow);

  assert.throws(() => assertConsistent(tmp), error =>
    error.message.includes('make check (plugin verify)')
      && error.message.includes('make check (renamed)'));
});
