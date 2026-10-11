'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require(path.join(__dirname, '..', '..', 'plugins', 'rstaff-usage', 'scripts', 'usage.js'));

test('resolveUsageLog defaults to RSTAFF_HOME and honors an override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-usage-home-'));
  const previous = process.env.RSTAFF_HOME;
  try {
    fs.writeFileSync(path.join(dir, 'rstaff.json'), '{}\n');
    process.env.RSTAFF_HOME = dir;
    assert.equal(U.resolveUsageLog('/unrelated'), path.join(dir, 'var', 'usage.jsonl'));
    assert.equal(U.resolveUsageLog('/unrelated', '/tmp/custom-usage.jsonl'), '/tmp/custom-usage.jsonl');
  } finally {
    if (previous === undefined) delete process.env.RSTAFF_HOME;
    else process.env.RSTAFF_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRecords keeps old records and deduplicates stable ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-usage-read-'));
  const file = path.join(dir, 'usage.jsonl');
  const now = Date.parse('2026-07-28T00:00:00Z');
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ id: 'same', timestamp: '2026-07-26T00:00:00Z', usage: { totalTokens: 10 } }),
      JSON.stringify({ id: 'same', timestamp: '2026-07-27T00:00:00Z', measured: true, usage: { totalTokens: 20 } }),
      JSON.stringify({ timestamp: '2026-07-27T00:00:00Z', usage: { totalTokens: 5 } }),
      '{bad json',
      JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', usage: { totalTokens: 99 } }),
    ].join('\n'));
    const records = U.readRecords(file, now, 30);
    assert.equal(records.length, 2);
    assert.equal(records.find((r) => r.id === 'same').usage.totalTokens, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarize distinguishes measured and unmeasured runs', () => {
  const groups = U.summarize([
    { adapter: 'codex', model: 'gpt-a', mode: 'review', measured: false, usage: null },
    { adapter: 'codex', model: 'gpt-a', mode: 'review', measured: true, usage: { inputTokens: 10, cachedInputTokens: 8, cacheWriteInputTokens: 3, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12 } },
    { adapter: 'claude', model: 'sonnet', mode: 'coordinator', usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 } },
  ]);
  const codex = groups.find((g) => g.route.startsWith('codex'));
  assert.equal(codex.runs, 2);
  assert.equal(codex.measuredRuns, 1);
  assert.equal(codex.unmeasuredRuns, 1);
  assert.equal(codex.cacheWriteInputTokens, 3);
  assert.equal(codex.totalTokens, 12);
});

test('render shows em dash for an entirely unmeasured route', () => {
  const groups = U.summarize([
    { adapter: 'codex', model: 'default', mode: 'review', measured: false, usage: null },
  ]);
  const report = U.render(groups, 7);
  assert.match(report, /codex \/ default \/ review/);
  assert.match(report, /\| 1 \| 0 \| 1 \| — \|/);
  assert.match(report, /provider-native/);
  assert.doesNotMatch(report, /\$/);
});

test('appendRecord rotates at the configured threshold and reads archives', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-usage-rotate-'));
  const file = path.join(dir, 'usage.jsonl');
  try {
    fs.writeFileSync(file, JSON.stringify({ timestamp: '2026-07-27T00:00:00Z', usage: { totalTokens: 1 } }) + '\n');
    U.appendRecord(file, {
      id: 'new', timestamp: '2026-07-28T00:00:00Z', adapter: 'codex',
      measured: true, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    }, { maxBytes: 1, now: new Date('2026-07-28T01:02:03.000Z') });
    assert.equal(U.listLogFiles(file).length, 2);
    assert.equal(U.readRecords(file, Date.parse('2026-07-28T02:00:00Z'), 30).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeCached invalidates when the log changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-usage-cache-'));
  const file = path.join(dir, 'usage.jsonl');
  const now = Date.parse('2026-07-28T00:00:00Z');
  try {
    U.appendRecord(file, { id: 'a', timestamp: '2026-07-28T00:00:00Z', measured: false });
    assert.equal(U.summarizeCached(file, now, 30)[0].runs, 1);
    U.appendRecord(file, { id: 'b', timestamp: '2026-07-28T00:00:01Z', measured: false });
    assert.equal(U.summarizeCached(file, now, 30)[0].runs, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendRecord preserves quota telemetry fields and defaults them to null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-usage-quota-append-'));
  const file = path.join(dir, 'usage.jsonl');
  const quota = {
    primary: { start: 10, end: 11, windowMinutes: 300, resetsAt: 123, reset: false },
    secondary: { start: 80, end: 81, windowMinutes: 10080, resetsAt: 456, reset: false },
  };
  const fields = ['effort', 'attempt', 'quota', 'modelCalls', 'peakContext', 'contextWindow'];
  try {
    U.appendRecord(file, {
      id: 'with-telemetry', effort: 'xhigh', attempt: 2, quota,
      modelCalls: 3, peakContext: 80000, contextWindow: 200000,
    });
    U.appendRecord(file, { id: 'without-telemetry' });
    const [withTelemetry, withoutTelemetry] = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    for (const key of fields) assert.deepEqual(withTelemetry[key], ({ effort: 'xhigh', attempt: 2, quota, modelCalls: 3, peakContext: 80000, contextWindow: 200000 })[key]);
    for (const key of fields) assert.equal(withoutTelemetry[key], null, `${key} should default to null`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarize separates effort groups and computes weekly and five-hour deltas per million tokens', () => {
  const usage = { inputTokens: 900000, outputTokens: 100000, totalTokens: 1000000 };
  const window = (start, end, windowMinutes) => ({ start, end, windowMinutes, resetsAt: 900, reset: false });
  const groups = U.summarize([
    { adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', effort: 'xhigh', usage, quota: { primary: window(20, 22, 300), secondary: window(80, 81, 10080) } },
    { adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', effort: 'xhigh', usage, quota: { primary: window(22, 25, 300), secondary: window(81, 83, 10080) } },
    { adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', usage },
  ]);
  const effort = groups.find((g) => g.route === 'codex / gpt-6-sol@xhigh / execute');
  const legacy = groups.find((g) => g.route === 'codex / gpt-6-sol / execute');
  assert.ok(effort);
  assert.ok(legacy);
  assert.equal(effort.quotaRuns, 2);
  assert.equal(effort.quotaTokens, 2000000);
  assert.equal(effort.weeklyDelta, 1.5);
  assert.equal(effort.fiveHourDelta, 2.5);
  assert.equal(legacy.quotaRuns, 0);
});

test('summarize excludes reset quota rows from deltas and quota token totals', () => {
  const window = (start, end, reset = false) => ({ start, end, windowMinutes: 10080, resetsAt: 900, reset });
  const groups = U.summarize([
    { adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', measured: true, usage: { totalTokens: 1000000 }, quota: { primary: window(10, 11), secondary: window(50, 52) } },
    { adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', measured: true, usage: { totalTokens: 500000 }, quota: { primary: window(11, 1, true), secondary: window(52, 2, true) } },
  ]);
  const row = groups[0];
  assert.equal(row.quotaRuns, 1);
  assert.equal(row.quotaTokens, 1000000);
  assert.equal(row.weeklyDelta, 2);
  assert.equal(row.fiveHourDelta, 1);
});

test('summarize excludes unmeasured quota rows from delta runs and totals', () => {
  const window = (start, end) => ({ start, end, windowMinutes: 10080, resetsAt: 900, reset: false });
  const groups = U.summarize([
    {
      adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', measured: true,
      usage: { totalTokens: 1000000 },
      quota: { secondary: window(80, 81) },
    },
    {
      adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', measured: false, usage: null,
      quota: { secondary: window(81, 90) },
    },
  ]);
  const row = groups[0];
  assert.equal(row.quotaRuns, 1);
  assert.equal(row.quotaTokens, 1000000);
  assert.equal(row.weeklyDelta, 1);
});

test('summarize and render count measured non-reset runs per quota window', () => {
  const window = (start, end, reset = false) => ({ start, end, windowMinutes: 300, resetsAt: 900, reset });
  const groups = U.summarize([
    { adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', measured: true, usage: { totalTokens: 1000000 }, quota: { primary: window(10, 11), secondary: window(50, 51) } },
    { adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', measured: true, usage: { totalTokens: 1000000 }, quota: { primary: window(11, 1, true), secondary: window(51, 53) } },
    { adapter: 'codex', model: 'gpt-6-sol', mode: 'execute', measured: false, usage: null, quota: { primary: window(1, 4), secondary: window(53, 60) } },
  ]);
  const row = groups[0];
  assert.equal(row.fiveHourRuns, 1);
  assert.equal(row.weeklyRuns, 2);
  const report = U.render(groups, 30);
  assert.match(report, /\| codex \/ gpt-6-sol \/ execute \| 3 \| 2 \| 1 \|.*\| 1\.00 \| 1 \| 1\.50 \| 2 \|$/m);
});

test('render adds quota columns and known-bias footer for old rows', () => {
  const report = U.render(U.summarize([
    { adapter: 'gemini', model: 'old-model', mode: 'execute', measured: true, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
  ]), 30);
  assert.match(report, /\| route \| runs \| measured \| unmeasured \| prompt input \| cache read \| cache write \| output \| reasoning \| total \| Δ5h%\/1M \| n5h \| Δweekly%\/1M \| nWeekly \|/);
  assert.match(report, /\| gemini \/ old-model \/ execute \| 1 \| 1 \| 0 \| 10 \| 0 \| 0 \| 2 \| 0 \| 12 \| — \| 0 \| — \| 0 \|/);
  assert.match(report, /first call precedes the first reading/);
  assert.match(report, /concurrent runs share quota/);
});

test('render treats cached groups without quota fields as having no quota delta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-usage-old-cache-'));
  const file = path.join(dir, 'usage.jsonl');
  const now = Date.parse('2026-07-28T00:00:00Z');
  try {
    U.appendRecord(file, {
      id: 'old', timestamp: '2026-07-27T00:00:00Z', adapter: 'gemini', model: 'old-model',
      mode: 'execute', measured: true, usage: { totalTokens: 12 },
    });
    U.summarizeCached(file, now, 30);
    const cacheFile = file + '.summary-cache.json';
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    for (const key of ['quotaRuns', 'weeklyDelta', 'fiveHourDelta', 'quotaTokens', 'fiveHourRuns', 'weeklyRuns']) delete cache.groups[0][key];
    fs.writeFileSync(cacheFile, JSON.stringify(cache) + '\n');
    const groups = U.summarizeCached(file, now, 30);
    const report = U.render(groups, 30);
    assert.match(report, /Δ5h%\/1M \| n5h \| Δweekly%\/1M \| nWeekly/);
    assert.match(report, /\| gemini \/ old-model \/ execute \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 12 \| — \| — \| — \| — \|/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Track the review pass rate by writer model and effort.
const vrow = (label, attempt, verdict, timestamp) => ({
  id: `verdict:${label}:${attempt}:${timestamp}`, timestamp, adapter: 'review', mode: 'verdict',
  model: '-', label, attempt, verdict, measured: false, usage: null,
});
const wrow = (label, attempt, model, effort, timestamp, adapter = 'codex') => ({
  id: `${adapter}:${label}:${attempt}:${timestamp}`, timestamp, adapter, mode: 'execute', model,
  effort, label, attempt, measured: true, usage: { totalTokens: 10 },
});

test('U1 summarize never counts verdict rows as runs', () => {
  const groups = U.summarize([
    wrow('r/s/T1/implement', 1, 'gpt-x', 'low', '2026-10-01T00:00:00Z'),
    vrow('r/s/T1', 1, 'pass', '2026-10-01T00:01:00Z'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].runs, 1);
});

test('U2 a verdict joins the writer row with the same attempt', () => {
  const v = U.summarizeVerdicts([
    wrow('r/s/T1/implement', 1, 'gpt-x', 'low', '2026-10-01T00:00:00Z'),
    wrow('r/s/T1/implement', 2, 'gpt-y', 'high', '2026-09-30T00:00:00Z'),
    vrow('r/s/T1', 2, 'pass', '2026-10-01T00:05:00Z'),
  ]);
  assert.deepEqual(v.map((g) => g.writer), ['codex / gpt-y@high']);
});

test('U3 fallback attributes a Claude writer row with no attempt and a trailing dot', () => {
  const v = U.summarizeVerdicts([
    { ...wrow('r/s/T2/implement.', null, 'claude-opus-5-5', null, '2026-10-01T00:00:00Z', 'claude'), mode: 'subagent:rstaff-engineer:implementer' },
    vrow('r/s/T2', 1, 'block', '2026-10-01T00:05:00Z'),
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0].writer, 'claude / claude-opus-5-5');
  assert.equal(v[0].block, 1);
});

test('U4 a writer row written only after the verdict leaves it unattributed', () => {
  const v = U.summarizeVerdicts([
    wrow('r/s/T3/implement', null, 'gpt-x', 'low', '2026-10-01T00:10:00Z'),
    vrow('r/s/T3', 1, 'pass', '2026-10-01T00:05:00Z'),
  ]);
  assert.deepEqual(v.map((g) => g.writer), ['unattributed']);
});

test('U5 counts pass, block, pass rate, and first-attempt pass rate', () => {
  const records = [
    wrow('r/s/A/implement', 1, 'gpt-x', 'low', '2026-10-01T00:00:00Z'),
    vrow('r/s/A', 1, 'block', '2026-10-01T00:01:00Z'),
    wrow('r/s/A/implement', 2, 'gpt-x', 'low', '2026-10-01T00:02:00Z'),
    vrow('r/s/A', 2, 'pass', '2026-10-01T00:03:00Z'),
    wrow('r/s/B/implement', 1, 'gpt-x', 'low', '2026-10-01T00:04:00Z'),
    vrow('r/s/B', 1, 'pass', '2026-10-01T00:05:00Z'),
    wrow('r/s/C/implement', 2, 'gpt-z', 'max', '2026-10-01T00:06:00Z'),
    vrow('r/s/C', 2, 'pass', '2026-10-01T00:07:00Z'),
  ];
  const v = U.summarizeVerdicts(records);
  const x = v.find((g) => g.writer === 'codex / gpt-x@low');
  assert.deepEqual(
    [x.verdicts, x.pass, x.block, x.passRate, x.firstVerdicts, x.firstPass, x.firstPassRate],
    [3, 2, 1, 2 / 3, 2, 1, 0.5],
  );
  const z = v.find((g) => g.writer === 'codex / gpt-z@max');
  assert.equal(z.firstVerdicts, 0);
  assert.equal(z.firstPassRate, null);
  const report = U.render(U.summarize(records), 30, v);
  assert.match(report, /\| codex \/ gpt-x@low \| 3 \| 2 \| 1 \| 67% \| 50% \|/);
  assert.match(report, /\| codex \/ gpt-z@max \| 1 \| 1 \| 0 \| 100% \| — \|/);
});

test('U6 render omits the pass-rate table without verdicts and keeps the token table', () => {
  const groups = U.summarize([wrow('r/s/T1/implement', 1, 'gpt-x', 'low', '2026-10-01T00:00:00Z')]);
  const plain = U.render(groups, 30);
  assert.equal(U.render(groups, 30, []), plain);
  assert.doesNotMatch(plain, /Review pass rate by writer/);
  assert.match(U.render(groups, 30, U.summarizeVerdicts([vrow('r/s/Q', 1, 'pass', '2026-10-01T00:00:00Z')])),
    /Review pass rate by writer[\s\S]*\| unattributed \| 1 \| 1 \| 0 \| 100% \| 100% \|/);
});

test('U7 loadSummary caches verdicts, recomputes an old-shape cache, and summarizeCached stays an array', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-usage-verdict-cache-'));
  const file = path.join(dir, 'usage.jsonl');
  const now = Date.parse('2026-10-02T00:00:00Z');
  try {
    U.appendRecord(file, wrow('r/s/T1/implement', 1, 'gpt-x', 'low', '2026-10-01T00:00:00Z'));
    U.appendRecord(file, vrow('r/s/T1', 1, 'pass', '2026-10-01T00:01:00Z'));
    const cacheFile = file + '.summary-cache.json';
    U.summarizeCached(file, now, 30);
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    delete cache.verdicts;
    fs.writeFileSync(cacheFile, JSON.stringify(cache) + '\n');
    const loaded = U.loadSummary(file, now, 30);
    assert.equal(loaded.verdicts.length, 1);
    assert.equal(loaded.verdicts[0].writer, 'codex / gpt-x@low');
    assert.ok(Array.isArray(U.summarizeCached(file, now, 30)));
    assert.equal(U.summarizeCached(file, now, 30)[0].runs, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U8 only writer modes are join candidates; reviewer/runner rows with an /implement label are skipped', () => {
  const label = 'r/s/T5/implement';
  const v = U.summarizeVerdicts([
    wrow(label, null, 'gpt-6-luna', 'max', '2026-10-01T00:44:00Z'),
    { ...wrow(label, null, 'claude-opus-5-5', null, '2026-10-01T01:00:00Z', 'claude'), mode: 'subagent:rstaff:reviewer' },
    { ...wrow(label, null, 'claude-opus-5-5', null, '2026-10-01T01:00:05Z', 'claude'), mode: 'subagent:rstaff-engineer:feature-runner' },
    { ...wrow(label, null, 'claude-opus-5-5', null, '2026-10-01T01:00:06Z', 'claude'), mode: 'coordinator' },
    vrow('r/s/T5', 1, 'pass', '2026-10-01T01:00:10Z'),
  ]);
  assert.deepEqual(v.map((g) => g.writer), ['codex / gpt-6-luna@max']);
});

test('U9 a same-attempt writer row written after the verdict does not win', () => {
  const v = U.summarizeVerdicts([
    wrow('r/s/T6/implement', 1, 'gpt-x', 'low', '2026-10-01T00:00:00Z'),
    vrow('r/s/T6', 1, 'pass', '2026-10-01T00:05:00Z'),
    wrow('r/s/T6/implement', 1, 'gpt-y', 'high', '2026-10-03T00:00:00Z'),
  ]);
  assert.deepEqual(v.map((g) => g.writer), ['codex / gpt-x@low']);
});
