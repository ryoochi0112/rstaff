'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const CORE = path.join(ROOT, 'plugins', 'rstaff');
const AI = path.join(ROOT, 'plugins', 'rstaff-ai');
const DATADOG = path.join(ROOT, 'plugins', 'rstaff-ai-datadog');

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}

test('rstaff-ai depends on core', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(AI, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'rstaff-ai');
  assert.equal(manifest.version, '0.13.0');
  assert.deepEqual(manifest.dependencies, ['rstaff', 'superpowers@superpowers-marketplace']);
});

test('Datadog add-on declares its dependency and prerequisites in the marketplace', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DATADOG, '.claude-plugin', 'plugin.json'), 'utf8'));
  const aiManifest = JSON.parse(fs.readFileSync(path.join(AI, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = marketplace.plugins.find(plugin => plugin.name === 'rstaff-ai-datadog');
  assert.equal(manifest.name, 'rstaff-ai-datadog');
  assert.equal(manifest.version, aiManifest.version);
  assert.deepEqual(manifest.dependencies, ['rstaff-ai']);
  assert.match(manifest.description, /Datadog account/);
  assert.match(manifest.description, /Datadog connector/);
  assert.ok(entry, 'marketplace must list the add-on');
  assert.equal(entry.source, './plugins/rstaff-ai-datadog');
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.description, manifest.description);
});

test('Datadog skill and both eval suites live in the add-on', () => {
  assert.deepEqual(fs.globSync('**/*', { cwd: AI }).filter(file => /datadog/i.test(file)), []);
  for (const relative of [
    'skills/datadog-llmobs-analysis/SKILL.md',
    'evals/datadog-llmobs-analysis-trigger',
    'evals/datadog-llmobs-analysis-compliance',
  ]) {
    assert.ok(fs.existsSync(path.join(DATADOG, relative)), `add-on is missing ${relative}`);
  }
});

test('eval conversion routes both Datadog suites to the add-on', () => {
  const { convertSuite } = require('../../maintainer/convert-evals.js');
  const cases = convertSuite('datadog-llmobs-analysis', [{ query: 'Count turns', should_trigger: true }], {
    skill_name: 'datadog-llmobs-analysis',
    evals: [{ id: 'count', prompt: 'Count turns', expected_output: 'Aggregate counts', assertions: ['Uses aggregates'] }],
  });
  assert.deepEqual(cases.map(entry => entry.relPath), [
    'rstaff-ai-datadog/evals/datadog-llmobs-analysis-trigger/01/case.yaml',
    'rstaff-ai-datadog/evals/datadog-llmobs-analysis-compliance/count/case.yaml',
  ]);
});

test('core no longer contains the AI units', () => {
  const moved = [
    'commands/eval.md',
    'commands/experiment.md',
    'skills/agent-evaluation',
    'skills/experiment-design',
    'skills/harness-validation',
    'agents/eval-runner.md',
    'agents/experiment-analyst.md',
    'rules/experiment.md',
    'rules/evaluation.md',
    'templates/experiment-record.md',
  ];
  for (const relative of moved) {
    assert.equal(fs.existsSync(path.join(CORE, relative)), false, `core still has ${relative}`);
    assert.equal(fs.existsSync(path.join(AI, relative)), true, `rstaff-ai is missing ${relative}`);
  }
});

test('rstaff-ai markdown paths resolve inside its plugin or through locate to core', () => {
  let directReferences = 0;
  for (const file of markdownFiles(AI)) {
    const text = fs.readFileSync(file, 'utf8');
    const located = /\$\(node\s+["']?\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/locate\.js["']?\s+([a-z][a-z0-9-]*)\)\/([A-Za-z0-9._/-]+)/g;
    for (const match of text.matchAll(located)) {
      assert.equal(match[1], 'rstaff', `${file} must locate only the core plugin`);
      assert.equal(fs.existsSync(path.join(CORE, match[2])), true, `${file} cites missing core path ${match[2]}`);
    }

    const direct = /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g;
    for (const match of text.matchAll(direct)) {
      directReferences += 1;
      assert.equal(fs.existsSync(path.join(AI, match[1])), true, `${file} cites missing local path ${match[1]}`);
    }
  }
  assert.ok(directReferences > 0, 'the moved markdown must retain checked plugin-root paths');
});

test('rstaff-ai vendors the core locate.js byte-for-byte', () => {
  const coreLocate = fs.readFileSync(path.join(CORE, 'scripts', 'locate.js'));
  const aiLocate = fs.readFileSync(path.join(AI, 'scripts', 'locate.js'));
  assert.deepEqual(aiLocate, coreLocate);
});
