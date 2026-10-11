#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OWNERS = {
  'agent-evaluation': 'rstaff-ai',
  'datadog-llmobs-analysis': 'rstaff-ai-datadog',
  'experiment-design': 'rstaff-ai',
  grilling: 'rstaff-pm',
  'harness-validation': 'rstaff-ai',
  'parallel-build': 'rstaff-engineer',
  'token-efficient-delegation': 'rstaff-delegation',
};

function convertSuite(skill, triggerJson, complianceJson) {
  const owner = OWNERS[skill];
  if (!owner) throw new Error(`Unknown skill: ${skill}`);
  if (complianceJson.skill_name !== skill) throw new Error(`Mismatched compliance skill: ${skill}`);
  const cases = triggerJson.map((entry, index) => {
    const id = String(index + 1).padStart(2, '0');
    return {
      relPath: `${owner}/evals/${skill}-trigger/${id}/case.yaml`,
      caseObject: {
        schema_version: '1.0',
        name: `${skill}-trigger-${id}`,
        tags: [skill, 'trigger', ...(entry.sibling ? [`sibling:${entry.sibling}`] : [])],
        execution: { prompt: entry.query, model: 'sonnet', max_turns: 4, timeout_seconds: 180 },
        runs: 3,
        graders: [{ name: 'skill-trigger', type: 'tool_used', tool: 'Skill', input_match: skill,
          ...(entry.should_trigger ? {} : { min: 0, max: 0 }) }],
      },
    };
  });
  for (const entry of complianceJson.evals) {
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.id)) throw new Error(`Unsafe eval id: ${entry.id}`);
    cases.push({
      relPath: `${owner}/evals/${skill}-compliance/${entry.id}/case.yaml`,
      caseObject: {
        schema_version: '1.0',
        name: `${skill}-compliance-${entry.id}`,
        description: `Legacy id: ${entry.id}\nExpected output: ${entry.expected_output}`,
        tags: [skill, 'compliance'],
        execution: { prompt: entry.prompt, model: 'haiku', max_turns: 2, timeout_seconds: 120 },
        runs: 5,
        graders: entry.assertions.map((criteria, index) => ({
          name: `assertion-${index + 1}`, type: 'llm', criteria,
        })),
      },
    });
  }
  return cases;
}

function main(argv) {
  let src = 'evals/skills';
  let out = 'plugins';
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i + 1] || !['--src', '--out'].includes(argv[i])) {
      throw new Error('Usage: node maintainer/convert-evals.js [--src evals/skills] [--out plugins]');
    }
    if (argv[i] === '--src') src = argv[i + 1];
    else out = argv[i + 1];
  }
  for (const skill of fs.readdirSync(src).sort()) {
    const read = (file) => JSON.parse(fs.readFileSync(path.join(src, skill, file), 'utf8'));
    for (const { relPath, caseObject } of convertSuite(skill, read('trigger.json'), read('compliance.json'))) {
      const file = path.join(out, relPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(caseObject, null, 2)}\n`);
    }
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { convertSuite };
