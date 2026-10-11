'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function grade(reply, label) {
  return reply === label ? 1 : 0;
}

function readJsonl(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  return contents.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim() === '') return [];
    try {
      return [JSON.parse(line)];
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: invalid JSON: ${error.message}`);
    }
  });
}

function sha256File(filePath) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return `sha256:${digest}`;
}

function sha256Text(value) {
  const digest = crypto.createHash('sha256').update(value).digest('hex');
  return `sha256:${digest}`;
}

function gradeFile({ cases, replies, split, casesPath } = {}) {
  if (!Array.isArray(cases)) throw new TypeError('cases must be an array');
  if (!Array.isArray(replies)) throw new TypeError('replies must be an array');

  const caseById = new Map();
  for (const item of cases) {
    if (!item || typeof item.id !== 'string') throw new TypeError('each case must have a string id');
    if (caseById.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    caseById.set(item.id, item);
  }

  for (const item of replies) {
    if (!item || !caseById.has(item.id)) {
      throw new Error(`reply id not in cases: ${item && item.id !== undefined ? item.id : '(missing)'}`);
    }
    if (item.arm !== 'control' && item.arm !== 'candidate') {
      throw new Error(`reply arm must be control or candidate for ${item.id}`);
    }
  }

  const selectedCases = split === undefined ? cases : cases.filter(item => item.split === split);
  const selectedIds = new Set(selectedCases.map(item => item.id));
  const rows = replies.flatMap(item => {
    if (!selectedIds.has(item.id)) return [];
    const testCase = caseById.get(item.id);
    const score = grade(item.reply, testCase.label);
    return [{
      id: item.id,
      arm: item.arm,
      reply: item.reply,
      label: testCase.label,
      score,
      status: item.reply === null ? 'error' : score === 1 ? 'pass' : 'fail',
    }];
  });

  const summary = {
    control: { passed: 0, total: 0 },
    candidate: { passed: 0, total: 0 },
  };
  for (const row of rows) {
    const armSummary = summary[row.arm];
    armSummary.total += 1;
    armSummary.passed += row.score;
  }

  return {
    rows,
    summary,
    hashes: {
      grader: sha256File(__filename),
      cases: casesPath ? sha256File(casesPath) : sha256Text(JSON.stringify(cases)),
    },
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--cases', '--replies', '--split', '--json'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (options[flag]) throw new Error(`duplicate argument: ${flag}`);
    options[flag] = value;
    index += 1;
  }
  if (!options['--cases']) throw new Error('required argument missing: --cases');
  if (!options['--replies']) throw new Error('required argument missing: --replies');
  return options;
}

function printResult(result) {
  for (const row of result.rows) {
    console.log(`${row.id}  ${row.arm}  ${row.status}`);
  }
  console.log(`control ${result.summary.control.passed}/${result.summary.control.total} · candidate ${result.summary.candidate.passed}/${result.summary.candidate.total}`);
  console.log(`grader ${result.hashes.grader}  cases ${result.hashes.cases}`);
}

function main(argv) {
  try {
    const options = parseArgs(argv);
    const cases = readJsonl(options['--cases']);
    const replies = readJsonl(options['--replies']);
    const result = gradeFile({
      cases,
      replies,
      split: options['--split'],
      casesPath: options['--cases'],
    });
    printResult(result);
    if (options['--json']) {
      fs.writeFileSync(options['--json'], `${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    console.error(`grade: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { grade, readJsonl, sha256File, gradeFile };

if (require.main === module) main(process.argv.slice(2));
