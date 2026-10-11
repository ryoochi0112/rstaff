'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const SAMPLE = path.join(ROOT, 'plugins/rstaff-ai/samples/label-task');
const CASES_PATH = path.join(SAMPLE, 'cases.jsonl');
const GRADE_PATH = path.join(SAMPLE, 'grade.js');
const { grade, readJsonl, sha256File, gradeFile } = require(GRADE_PATH);

test('sample contains three dev cases and twelve balanced confirm cases', () => {
  const cases = readJsonl(CASES_PATH);
  assert.equal(cases.length, 15);
  assert.deepEqual(cases.slice(0, 3).map(item => item.id), ['d01', 'd02', 'd03']);
  assert.deepEqual(cases.slice(3).map(item => item.id), [
    'c01', 'c02', 'c03', 'c04', 'c05', 'c06',
    'c07', 'c08', 'c09', 'c10', 'c11', 'c12',
  ]);
  assert.ok(cases.slice(0, 3).every(item => item.split === 'dev'));
  assert.ok(cases.slice(3).every(item => item.split === 'confirm'));
  for (const item of cases) {
    assert.deepEqual(Object.keys(item), ['id', 'split', 'input', 'label']);
    assert.equal(typeof item.input, 'string');
    assert.equal(item.input.trim(), item.input);
    assert.match(item.input, /^[^.!?]+[.!?]$/);
    assert.ok(['positive', 'negative', 'neutral'].includes(item.label));
  }
  const counts = Object.fromEntries(['positive', 'negative', 'neutral'].map(label => [
    label,
    cases.slice(3).filter(item => item.label === label).length,
  ]));
  assert.deepEqual(counts, { positive: 4, negative: 4, neutral: 4 });
});

test('control and candidate prompts match the loose and strict contracts', () => {
  const control = fs.readFileSync(path.join(SAMPLE, 'prompts/control.md'), 'utf8').trim();
  const candidate = fs.readFileSync(path.join(SAMPLE, 'prompts/candidate.md'), 'utf8').trim();
  assert.equal(control, 'What is the sentiment of this product review?');
  assert.equal(candidate,
    `${control} Reply with exactly one lowercase word: positive, negative, or neutral. No punctuation.`);
});

test('exact match grading rejects a one-character, case, punctuation, or null mismatch', () => {
  assert.equal(grade('negative', 'negative'), 1);
  assert.equal(grade('negativ', 'negative'), 0);
  assert.equal(grade('Negative', 'negative'), 0);
  assert.equal(grade('negative.', 'negative'), 0);
  assert.equal(grade(null, 'negative'), 0);
});

test('JSONL reader, file hash, and gradeFile preserve exact scores and errors', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-grade-'));
  try {
    const casesPath = path.join(tempDir, 'cases.jsonl');
    const repliesPath = path.join(tempDir, 'replies.jsonl');
    const caseRows = [
      { id: 'c01', split: 'confirm', input: 'A sample review is clear.', label: 'positive' },
      { id: 'c02', split: 'confirm', input: 'A sample review is flat.', label: 'neutral' },
    ];
    const replyRows = [
      { id: 'c01', arm: 'control', reply: 'positive' },
      { id: 'c01', arm: 'candidate', reply: 'Positive' },
      { id: 'c02', arm: 'control', reply: null },
      { id: 'c02', arm: 'candidate', reply: 'neutral' },
    ];
    fs.writeFileSync(casesPath, `${caseRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    fs.writeFileSync(repliesPath, `${replyRows.map(row => JSON.stringify(row)).join('\n')}\n`);

    assert.deepEqual(readJsonl(casesPath), caseRows);
    assert.equal(sha256File(casesPath), `sha256:${crypto.createHash('sha256').update(fs.readFileSync(casesPath)).digest('hex')}`);
    const result = gradeFile({
      cases: readJsonl(casesPath),
      replies: readJsonl(repliesPath),
      split: 'confirm',
      casesPath,
    });
    assert.deepEqual(result.rows.map(({ id, arm, score, status }) => ({ id, arm, score, status })), [
      { id: 'c01', arm: 'control', score: 1, status: 'pass' },
      { id: 'c01', arm: 'candidate', score: 0, status: 'fail' },
      { id: 'c02', arm: 'control', score: 0, status: 'error' },
      { id: 'c02', arm: 'candidate', score: 1, status: 'pass' },
    ]);
    assert.deepEqual(result.summary, {
      control: { passed: 1, total: 2 },
      candidate: { passed: 1, total: 2 },
    });
    assert.equal(result.hashes.cases, sha256File(casesPath));
    assert.match(result.hashes.grader, /^sha256:[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI prints rows, summary and hashes, writes JSON, and rejects bad inputs with exit 2', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-grade-cli-'));
  try {
    const casesPath = path.join(tempDir, 'cases.jsonl');
    const repliesPath = path.join(tempDir, 'replies.jsonl');
    const outputPath = path.join(tempDir, 'grades.json');
    const oneCase = { id: 'c01', split: 'confirm', input: 'A sample review is clear.', label: 'positive' };
    const replies = [
      { id: 'c01', arm: 'control', reply: null },
      { id: 'c01', arm: 'candidate', reply: 'positive' },
    ];
    fs.writeFileSync(casesPath, `${JSON.stringify(oneCase)}\n`);
    fs.writeFileSync(repliesPath, `${replies.map(row => JSON.stringify(row)).join('\n')}\n`);

    const run = spawnSync(process.execPath, [
      GRADE_PATH, '--cases', casesPath, '--replies', repliesPath, '--split', 'confirm', '--json', outputPath,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /c01  control  error/);
    assert.match(run.stdout, /c01  candidate  pass/);
    assert.match(run.stdout, /control 0\/1 · candidate 1\/1/);
    assert.match(run.stdout, /grader sha256:[a-f0-9]{64}  cases sha256:[a-f0-9]{64}/);
    const saved = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(saved.rows.length, 2);
    assert.deepEqual(saved.summary, {
      control: { passed: 0, total: 1 },
      candidate: { passed: 1, total: 1 },
    });

    const unknownReplies = path.join(tempDir, 'unknown.jsonl');
    fs.writeFileSync(unknownReplies, `${JSON.stringify({ id: 'x99', arm: 'control', reply: 'positive' })}\n`);
    const unknown = spawnSync(process.execPath, [GRADE_PATH, '--cases', casesPath, '--replies', unknownReplies], { encoding: 'utf8' });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /reply id not in cases: x99/);

    const missing = spawnSync(process.execPath, [GRADE_PATH, '--cases', path.join(tempDir, 'missing.jsonl'), '--replies', repliesPath], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /missing\.jsonl/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
