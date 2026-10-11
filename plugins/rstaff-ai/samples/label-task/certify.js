'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--check') return null;
  if (argv.length === 2 && argv[0] === '--out' && argv[1] && !argv[1].startsWith('--')) return argv[1];
  throw new Error('usage: node certify.js --out <cert.md> | --check');
}

function main(argv) {
  try {
    const output = parseArgs(argv);
    const { readJsonl, sha256File, gradeFile } = require(path.join(__dirname, 'grade.js'));
    const casesPath = path.join(__dirname, 'cases.jsonl');
    const cases = readJsonl(casesPath);
    const confirm = cases.filter(row => row.split === 'confirm');
    if (confirm.length !== 12 || new Set(confirm.map(row => row.id)).size !== 12) {
      throw new Error('cases must contain twelve distinct confirm cases');
    }
    const results = ['known-pass', 'known-fail'].map(name => {
      const replies = readJsonl(path.join(__dirname, 'fixtures', `${name}.jsonl`));
      if (replies.length !== 12 || new Set(replies.map(row => row.id)).size !== 12 ||
          !replies.every(row => confirm.some(item => item.id === row.id) && typeof row.reply === 'string')) {
        throw new Error(`${name} must contain one string reply per confirm case`);
      }
      return gradeFile({ cases, replies, split: 'confirm', casesPath });
    });
    const [pass, fail] = results;
    const passed = pass.rows.filter(row => row.score === 1).length;
    const caught = fail.rows.filter(row => row.score === 0).length;
    const status = passed === 12 && caught === 12 ? 'valid' : 'invalidated';
    const graderHash = sha256File(path.join(__dirname, 'grade.js'));
    const casesHash = sha256File(casesPath);
    const runtimePath = path.join(__dirname, 'run.js');
    const runtimeHash = fs.existsSync(runtimePath) ? sha256File(runtimePath) : 'missing';
    const summary = `certify: grader exact-match  known-pass ${passed}/12  known-fail caught ${caught}/12  → ${status}`;
    const fixtureLines = (rows, good, bad, expected) => rows.map(row =>
      `  - id: ${row.id}\n    result: ${row.score === expected ? good : bad}`).join('\n');
    const certificate = `# Harness certificate: label-task/label-exact-match/1
status: ${status}
certified_at: ${new Date().toISOString()}
certified_by: certify.js

## 1. Bound hashes
cases_manifest_hash: ${casesHash}
graders:
  - name: exact-match
    impl_hash: ${graderHash}
judge: none (code grader)
tool_env_or_mirror_sha: not applicable (local code grader)
runtime_hash: ${runtimeHash}

## 2. Fixtures that passed
known_pass_fixtures:
${fixtureLines(pass.rows, 'pass', 'fail', 1)}
known_fail_fixtures:
${fixtureLines(fail.rows, 'caught', 'missed', 0)}
mutation_metamorphic_tests:
${fail.rows.map(row => `  - case: ${row.id}\n    mutation: ${JSON.stringify(row.reply)}\n    expected: fail\n    observed: ${row.score === 0 ? 'fail' : 'pass'}`).join('\n')}

## 3. Judge calibration + bias audit
gold_set_agreement_rate: not applicable (code grader)
judge_error_direction: not applicable (code grader)
position_bias_check: not applicable (code grader)
verbosity_bias_check: not applicable (code grader)
label_blinding: not applicable (code grader)
repeated_judgment_N: not applicable (code grader)
repeated_judgment_agreement: not applicable (code grader)

## 4. Environment reset / isolation
reset_check: not applicable (local fixture grading only)

## 5. Invalidation triggers
invalidates_on_change_of:
  - cases_manifest_hash
  - any graders[].impl_hash
  - runtime_hash
  - fixtures/known-pass.jsonl
  - fixtures/known-fail.jsonl

## 6. Scope
applies_to: label-task/label-exact-match

${summary}
`;
    if (output !== null) fs.writeFileSync(output, certificate);
    console.log(summary);
    console.log(`  grader ${graderHash}  cases ${casesHash}  runtime ${runtimeHash}`);
    process.exitCode = status === 'valid' ? 0 : 1;
  } catch (error) {
    console.error(`certify: ${error.message}`);
    process.exitCode = 2;
  }
}

main(process.argv.slice(2));
