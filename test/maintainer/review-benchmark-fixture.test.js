'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const BENCHMARK = path.join(ROOT, 'maintainer', 'review-benchmark');
const FIXTURE = path.join(BENCHMARK, 'fixture.diff');
const KEY = path.join(BENCHMARK, 'defect-key.md');
const RUNNER = path.join(BENCHMARK, 'run.sh');

function parseUnifiedDiff(text) {
  const lines = text.split('\n');
  const hunks = new Map();
  let filePath = null;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      assert.equal(header[1], header[2], `renames are not expected in fixture: ${line}`);
      filePath = header[1];
      if (!hunks.has(filePath)) hunks.set(filePath, []);
      index += 1;
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) {
      index += 1;
      continue;
    }
    assert.ok(filePath, `hunk has no preceding diff header at fixture line ${index + 1}`);
    const oldStart = Number(hunk[1]);
    const oldCount = Number(hunk[2] || 1);
    const newStart = Number(hunk[3]);
    const newCount = Number(hunk[4] || 1);
    const body = [];
    let oldSeen = 0;
    let newSeen = 0;
    const headerLine = index + 1;
    index += 1;

    while (oldSeen < oldCount || newSeen < newCount) {
      assert.ok(index < lines.length, `hunk at fixture line ${index} is truncated`);
      const bodyLine = lines[index];
      const physicalLine = index + 1;
      if (bodyLine.startsWith(' ')) {
        const oldLine = oldStart + oldSeen;
        const newLine = newStart + newSeen;
        oldSeen += 1;
        newSeen += 1;
        body.push({ physicalLine, oldLine, newLine, touched: false });
      } else if (bodyLine.startsWith('+')) {
        const newLine = newStart + newSeen;
        newSeen += 1;
        body.push({ physicalLine, oldLine: null, newLine, touched: true });
      } else if (bodyLine.startsWith('-')) {
        const oldLine = oldStart + oldSeen;
        oldSeen += 1;
        body.push({ physicalLine, oldLine, newLine: null, touched: true });
      } else {
        assert.fail(`invalid unified-diff body at fixture line ${physicalLine}: ${bodyLine}`);
      }
      assert.ok(oldSeen <= oldCount, `hunk at fixture line ${index} exceeds its old-line count`);
      assert.ok(newSeen <= newCount, `hunk at fixture line ${index} exceeds its new-line count`);
      index += 1;
    }

    while (index < lines.length && /^\\ No newline at end of file$/.test(lines[index])) index += 1;
    if (index === lines.length - 1 && lines[index] === '') index += 1;
    if (index < lines.length) {
      assert.match(
        lines[index],
        /^(?:diff --git |index |--- |\+\+\+ |@@ )/,
        `unexpected line after hunk at fixture line ${index + 1}: ${lines[index]}`,
      );
    }
    hunks.get(filePath).push({ headerLine, oldStart, oldCount, newStart, newCount, body });
  }

  return hunks;
}

function parseKey(text) {
  const entries = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^## (D[1-5]) — (.+)$/);
    if (!heading) continue;
    const file = lines[index + 1] && lines[index + 1].match(/^- file: (.+):([0-9]+)$/);
    const report = lines[index + 2] && lines[index + 2].match(/^- must-report: (.+)$/);
    assert.ok(file, `${heading[1]} must have the exact file line format`);
    assert.ok(report, `${heading[1]} must have the exact must-report line format`);
    entries.push({ id: heading[1], className: heading[2], file: file[1], line: Number(file[2]), mustReport: report[1] });
  }
  return entries;
}

function validateKeyAgainstDiff(keyText = fs.readFileSync(KEY, 'utf8')) {
  const diffText = fs.readFileSync(FIXTURE, 'utf8');
  const hunks = parseUnifiedDiff(diffText);
  const entries = parseKey(keyText);
  assert.deepEqual(entries.map((entry) => entry.id), ['D1', 'D2', 'D3', 'D4', 'D5']);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 5);

  for (const entry of entries) {
    const fileHunks = hunks.get(entry.file);
    assert.ok(fileHunks, `${entry.id} path is not a diff header: ${entry.file}`);
    const newFileLines = fileHunks.flatMap((hunk) => hunk.body
      .filter((line) => line.newLine !== null)
      .map((line) => line.newLine));
    assert.ok(
      newFileLines.includes(entry.line),
      `${entry.id} points at ${entry.file}:${entry.line}, not a new-file line inside a parsed @@ hunk`,
    );
  }
  return { entries, hunks };
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `review-benchmark-${label}-`));
}

function writeExecutable(file, text) {
  fs.writeFileSync(file, text, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

test('every defect-key line is a real new-file line in its parsed file hunk', () => {
  const { entries } = validateKeyAgainstDiff();
  for (const entry of entries) assert.match(entry.mustReport, /\S+/, `${entry.id} must have a report sentence`);

  const mutated = fs.readFileSync(KEY, 'utf8').replace(
    /(- file: plugin\/scripts\/delegate\.js:)\d+/,
    (_, prefix) => `${prefix}1`,
  );
  assert.throws(() => validateKeyAgainstDiff(mutated), /D1 points at/,
    'moving a key line outside the parsed fixture must turn the structural check red');
});

test('parseUnifiedDiff rejects body lines left over after declared hunk counts', () => {
  const malformed = [
    'diff --git a/example.js b/example.js',
    '--- a/example.js',
    '+++ b/example.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '+leftover body line',
  ].join('\n');
  assert.throws(() => parseUnifiedDiff(malformed), /unexpected line after hunk/);
});

test('run.sh runs offline with a stub, resumes, scores FPs, and computes majorityFound', () => {
  const temp = makeTempDir('e2e');
  const prompt = path.join(temp, 'reviewer.md');
  const stub = path.join(temp, 'claude-stub.sh');
  const logDir = path.join(temp, 'calls');
  const counter = path.join(temp, 'counter');
  const output = path.join(temp, 'output');
  fs.mkdirSync(logDir);
  fs.writeFileSync(prompt, '---\nname: fixture-reviewer\ndescription: test\n---\nDO_NOT_FORWARD_REVIEWER_PROMPT\nReview the supplied benchmark inputs.\n');
  writeExecutable(stub, `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f "$STUB_COUNTER" ]]; then count=$(<"$STUB_COUNTER"); fi
count=$((count + 1))
printf '%s' "$count" > "$STUB_COUNTER"
input="$(cat)"
printf '%s' "$input" > "$STUB_LOG_DIR/call-$count.txt"
if grep -q 'STRICT JSON only' <<<"$input"; then
  if grep -q 'RUN-1' <<<"$input"; then
    printf '%s\\n' '{"found":["D1"],"fps":1}'
  elif grep -q 'RUN-2' <<<"$input"; then
    printf '%s\\n' '{"found":["D1"],"fps":0}'
  else
    printf '%s\\n' '{"found":["D3"],"fps":0}'
  fi
else
  case "$count" in
    1) printf '%s\\n' 'RUN-1 reviewer output: P1 D1 and P1 unrelated finding' ;;
    2) printf '%s\\n' 'RUN-2 reviewer output: P1 D1' ;;
    3) printf '%s\\n' 'RUN-3 reviewer output: P1 D3' ;;
    *) printf '%s\\n' 'unexpected extra reviewer call' ;;
  esac
fi
`);

  const env = {
    ...process.env,
    CLAUDE_BIN: stub,
    STUB_COUNTER: counter,
    STUB_LOG_DIR: logDir,
  };
  run('bash', [RUNNER, '--prompt', prompt, '--out', output], env);
  const reviewerInput = fs.readFileSync(path.join(logDir, 'call-1.txt'), 'utf8');
  assert.doesNotMatch(reviewerInput, /^name: fixture-reviewer$/m, 'YAML frontmatter must not reach the reviewer');
  assert.match(reviewerInput, /DO_NOT_FORWARD_REVIEWER_PROMPT/, 'the prompt body must remain');
  for (const index of [1, 2, 3]) {
    assert.equal(fs.readFileSync(path.join(output, `run-${index}.md`), 'utf8').trim(), `RUN-${index} reviewer output: P1 ${index === 1 ? 'D1 and P1 unrelated finding' : index === 2 ? 'D1' : 'D3'}`);
  }
  const firstPassCalls = Number(fs.readFileSync(counter, 'utf8'));
  assert.equal(firstPassCalls, 3);

  // Non-empty run files are resumable: a second collection pass makes no calls.
  run('bash', [RUNNER, '--prompt', prompt, '--out', output, '--runs', '3'], env);
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), firstPassCalls);

  run('bash', [RUNNER, '--score', '--out', output], env);
  const score = JSON.parse(fs.readFileSync(path.join(output, 'score.json'), 'utf8'));
  assert.deepEqual(score, {
    runs: [
      { found: ['D1'], fps: 1 },
      { found: ['D1'], fps: 0 },
      { found: ['D3'], fps: 0 },
    ],
    majorityFound: ['D1'],
    fpMax: 1,
  });
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 6, 'score uses one fresh judge call per run');

  const judgeInputs = [4, 5, 6].map((index) => fs.readFileSync(path.join(logDir, `call-${index}.txt`), 'utf8'));
  for (const input of judgeInputs) {
    assert.match(input, /defect-key\.md:/);
    assert.doesNotMatch(input, /DO_NOT_FORWARD_REVIEWER_PROMPT/);
  }
});

test('run.sh does not treat output from a failed claude call as resumable', () => {
  const temp = makeTempDir('failed-run');
  const prompt = path.join(temp, 'reviewer.md');
  const stub = path.join(temp, 'claude-stub.sh');
  const counter = path.join(temp, 'counter');
  const output = path.join(temp, 'output');
  fs.writeFileSync(prompt, 'Review the supplied benchmark inputs.\n');
  writeExecutable(stub, `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f "$STUB_COUNTER" ]]; then count=$(<"$STUB_COUNTER"); fi
count=$((count + 1))
printf '%s' "$count" > "$STUB_COUNTER"
cat >/dev/null
if ((count == 1)); then
  printf '%s\\n' 'partial output must not be resumed'
  exit 7
fi
printf '%s\\n' 'RECOVERED'
`);

  const env = { ...process.env, CLAUDE_BIN: stub, STUB_COUNTER: counter };
  const first = spawnSync('bash', [RUNNER, '--prompt', prompt, '--out', output, '--runs', '1'], {
    cwd: ROOT, env, encoding: 'utf8',
  });
  assert.notEqual(first.status, 0, 'a failed claude call must fail the harness');
  assert.match(first.stderr, /command failed.*claude-stub\.sh.*-p/);
  const runFile = path.join(output, 'run-1.md');
  assert.ok(!fs.existsSync(runFile) || fs.statSync(runFile).size === 0, 'failed output must not become a resumable run file');

  const second = spawnSync('bash', [RUNNER, '--prompt', prompt, '--out', output, '--runs', '1'], {
    cwd: ROOT, env, encoding: 'utf8',
  });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(fs.readFileSync(runFile, 'utf8').trim(), 'RECOVERED');
});
