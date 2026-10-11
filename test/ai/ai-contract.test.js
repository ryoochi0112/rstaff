'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { hashTerm } = require('../../maintainer/leak-scan.js');
const HASHED_TERMS = require('../../maintainer/leak-terms.json');

const ROOT = path.resolve(__dirname, '../..');
const AI = path.join(ROOT, 'plugins/rstaff-ai');
const read = relative => fs.readFileSync(path.join(AI, relative), 'utf8');

const contracts = {
  'commands/experiment.md': [
    '${CLAUDE_PLUGIN_ROOT}/scripts/adapter.js',
    'Exit 1 stops with `no experiment.adapters entry in <profile>`',
    'Exit 2 stops with',
    'only an explicit\n`--adapter` with no block permits the existing prose-adapter path',
    '| `{slug}` | slug from the ticket |',
    '| `{split}` | `dev` for smoke, `confirm` for confirmation |',
    '| `{cert}` | `$CTRL/var/experiments/<repo>/<slug>/cert.md` |',
    '| `{replies}` | `$CTRL/var/experiments/<repo>/<slug>/replies.jsonl` |',
    '| `{grades}` | `$CTRL/var/experiments/<repo>/<slug>/grades.json` |',
    "Run declared commands from the entry's\n`cwd`",
    'ask no framing questions',
    'copy its\n   fields into the record front-matter',
    'hash the\n   registration, and set `status: frozen` before any arm runs',
    'threshold +15 pts',
    'cases control passes and candidate fails ≥ 1',
    '> 2 errored calls of 24 → INCONCLUSIVE',
    '`N_cases=12`, `N_trials_per_case=1`',
    'Any nonzero\n   exit stops with `INVALID-HARNESS: certificate <path> status invalidated (known-fail caught x/12)`',
    'run `run` with `{split}=dev` and outputs under\n   `<slug>/dev/`; this smoke is non-gating',
    'run `run` then `grade` with `{split}=confirm`',
    'A runner\n   exit 1 still leaves complete replies: grade them and count errors per the ticket',
    'Paste the per-case table for both arms into the record\n   body §2/§3',
    'grader and cases hashes printed by `grade.js`',
    'pass only the record path, certificate path, and\n   `grades.json` path to that fresh analyst context',
    "exposure violates the frozen ticket's\n  `holdout_exposure` declaration",
  ],
  'agents/experiment-analyst.md': [
    '`hashes.grader` and `hashes.cases` equal the certificate\'s `graders[0].impl_hash`\n     and `cases_manifest_hash`, respectively',
    'A mismatch returns `INVALID-HARNESS`\n     naming the certificate path before scoring',
    'Check every planned case in the per-case table; name the missing paired control',
    'control column or any paired control result is absent',
    'Read exposure against\n     the frozen `holdout_exposure` declaration',
    'holdout_exposure: public demonstration sample; the candidate prompt was written before the cases',
    'Undeclared exposure or a violated declaration is invalid',
  ],
  'templates/experiment-record.md': [
    '### Per-case results',
    '| case id | split | control | candidate |',
    'grader hash: `<grades.json hashes.grader>`',
    'cases hash: `<grades.json hashes.cases>`',
    'holdout_exposure: <declared exposure and candidate/cases chronology>',
  ],
};

for (const [file, strings] of Object.entries(contracts)) {
  for (const [index, expected] of strings.entries()) {
    test(`${file} contract ${index + 1}: ${expected.split('\n')[0]}`, () => {
      assert.ok(read(file).includes(expected), `missing contract text: ${expected}`);
    });
  }
}

test('eval reads the adapter and dispatches code grading', () => {
  const command = read('commands/eval.md');
  for (const expected of [
    '${CLAUDE_PLUGIN_ROOT}/scripts/adapter.js',
    'grader: code',
    'run it for the',
    '`candidate` arm. If the run command has',
    'entry\'s `dev` setting; `split=dev` gives `{split}=dev`',
    'If the user supplied a replies file, use that file and skip `run`.',
    'resolved `grade` command, replies path, and `minScore`',
  ]) {
    assert.ok(command.includes(expected), `missing eval contract text: ${expected}`);
  }
});

test('eval-runner grades code adapters without an LLM judge', () => {
  const runner = read('agents/eval-runner.md');
  for (const expected of [
    '## Code-graded adapters',
    'If `minScore` is missing',
    'Run the supplied `grade` command',
    'Report every candidate case id as `PASS` or `FAIL`',
    'no rubric scoring and no LLM judge',
  ]) {
    assert.ok(runner.includes(expected), `missing code-grader contract text: ${expected}`);
  }
});

test('experiment description stays within its existing always-on budget', () => {
  const expected = 'description: Experimenter — run any agent/model/prompt/tool change through a controlled, pre-registered, harness-certified experiment to a causal ship/no-ship verdict. Governs the causal comparison and the decision; the actual measurement is delegated to a per-repo ADAPTER (rubric-judged /rstaff-ai:eval, model-compare, …). Sibling of /rstaff-ai:eval, /rstaff:review — writer≠judge enforced via a fresh adjudicator.';
  assert.equal(read('commands/experiment.md').split('\n')[1], expected);
});

test('experiment includes the golden summary verbatim', () => {
  const golden = `Experiment: sample-label-prompt  (ticket a3f9…, frozen 14:02)
Harness:    certified 14:01 — grader exact-match, known-fail 0/12, known-pass 12/12
Arms:       control 7/12 · candidate 11/12   (paired, same batch, N_cases=12, N_trials=1)
Analyst (fresh context): ACCEPT
  primary: exact-match +33 pts ≥ threshold +15 pts · guardrail: no case regressed
Record: ~/rstaff-home/var/experiments/sample/sample-label-prompt.md`;
  assert.ok(read('commands/experiment.md').includes(golden));
});

function files(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    return entry.isDirectory()
      ? files(path.join(directory, entry.name), relative + '/')
      : [relative];
  });
}

test('AI plugin no longer names the retired eval harness', () => {
  const retired = /src\/run\.mjs|RUN_LLM_JUDGE|rejudge\.mjs|offline && python3/;
  const hits = files(AI).flatMap(relative => read(relative).split('\n')
    .flatMap((line, index) => retired.test(line) ? [`${relative}:${index + 1}: ${line}`] : []));
  assert.deepEqual(hits, [], hits.join('\n'));
});

function violations(relative, source, hashedTerms = HASHED_TERMS) {
  const forbidden = /member|\/Users\/|(^|[^A-Za-z_])\.env\b|API_KEY|--env-file|dotenv|fetch\(|require\(['"]https?['"]\)|openai|gemini|datadog/i;
  const hashes = new Map(hashedTerms.sha256.map((digest, index) => [digest, index]));
  const wordBounded = new Set(hashedTerms.wordBounded || []);
  return source.split('\n').flatMap((line, index) => {
    const lower = line.toLowerCase();
    for (const length of hashedTerms.lengths) {
      for (let start = 0; start + length <= lower.length; start++) {
        const digest = hashTerm(lower.slice(start, start + length)).sha256;
        if (wordBounded.has(digest)
          && (/(?<=[\p{L}\p{N}_])$/u.test(lower.slice(0, start))
            || /^[\p{L}\p{N}_]/u.test(lower.slice(start + length)))) continue;
        if (hashes.has(digest)) return [`${relative}:${index + 1}: private-term#${hashes.get(digest)}`];
      }
    }
    const hit = forbidden.test(line)
      || (!relative.startsWith('.claude-plugin/') && /https?:\/\//i.test(line));
    return hit ? [`${relative}:${index + 1}: forbidden-pattern`] : [];
  });
}

test('Q4 static grep: AI plugin has no private wording, keys, or network access', () => {
  const scanned = files(AI);
  assert.ok(scanned.length > 0);
  const hits = scanned.flatMap(relative => violations(relative, read(relative)));
  // The claude argv in run.js is allowed; it matches none of the forbidden patterns.
  assert.deepEqual(hits, [], hits.join('\n'));
});

for (const forbidden of [
  'member', 'remember', '/Users/example', '.env',
  'load .env', 'API_KEY', '--env-file', 'dotenv', 'fetch(', "require('https')",
  'require("http")', 'openai', 'gemini', 'datadog', 'https://example', 'http://example',
]) {
  test(`static scanner rejects ${forbidden}`, () => {
    assert.equal(violations('scripts/probe.js', forbidden).length, 1);
  });
}

for (const allowed of ['process.env', 'process.env.MODEL', 'claude -p', '.environment']) {
  test(`static scanner permits ${allowed}`, () => {
    assert.deepEqual(violations('samples/label-task/run.js', allowed), []);
  });
}

test('static scanner permits only metadata URLs', () => {
  assert.deepEqual(violations('.claude-plugin/plugin.json', 'https://example'), []);
  assert.equal(violations('commands/probe.md', 'https://example').length, 1);
  assert.equal(violations('.claude-plugin/plugin.json', 'API_KEY').length, 1);
});

for (const [kind, source] of [
  ['exact', 'zqxfoo'], ['case variant', 'ZQXFOO'], ['embedded', 'prefixZqXfOosuffix'],
]) {
  test(`static hashed-term scanner rejects ${kind} private wording without quoting it`, () => {
    const entry = hashTerm('zqxfoo');
    const hashedTerms = { lengths: [entry.length], sha256: [entry.sha256] };
    const hits = violations('scripts/probe.js', source, hashedTerms);
    assert.deepEqual(hits, ['scripts/probe.js:1: private-term#0']);
    assert.ok(!hits.join('\n').includes(source));
  });
}

test('static hashed-term scanner honors Unicode word boundaries and preserves labels', () => {
  const entries = ['zqxfoo', 'zqxv'].map(hashTerm);
  const hashedTerms = {
    lengths: entries.map(entry => entry.length),
    sha256: entries.map(entry => entry.sha256),
    wordBounded: [entries[1].sha256],
  };
  for (const source of ['zqxv', '(ZQXV)', '🙂zqxv🙂']) {
    assert.deepEqual(violations('scripts/probe.js', source, hashedTerms), ['scripts/probe.js:1: private-term#1']);
  }
  for (const character of ['a', '0', '_', 'é', '中', '٣', '𐐀', '𝟙']) {
    assert.deepEqual(violations('scripts/probe.js', `${character}zqxv`, hashedTerms), []);
    assert.deepEqual(violations('scripts/probe.js', `zqxv${character}`, hashedTerms), []);
  }
});
