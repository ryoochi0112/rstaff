#!/usr/bin/env node
// Summarize provider-native token usage captured by delegates and Claude hooks.
// Tokenizers and subscription/API billing differ, so no currency is inferred.
'use strict';
const path = require('path');
const lib = require(path.join(__dirname, '..', 'hooks', 'lib.js'));
const fs = lib.fs;

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const CACHE_SUFFIX = '.summary-cache.json';

function resolveUsageLog(cwd, override) {
  if (override) return override;
  const home = lib.resolveHome(cwd || process.cwd());
  return lib.isControlRepo(home) ? path.join(home, 'var', 'usage.jsonl') : null;
}

function archiveName(file, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const base = path.basename(file).replace(/\.jsonl$/i, '');
  return path.join(path.dirname(file), `${base}.${stamp}.${process.pid}.jsonl`);
}

function rotateIfNeeded(file, maxBytes = MAX_LOG_BYTES, now = new Date()) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) { return null; }
  if (size < maxBytes) return null;
  const archive = archiveName(file, now);
  fs.renameSync(file, archive);
  return archive;
}

function appendRecord(file, record, opts = {}) {
  if (!file || !record) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfNeeded(file, opts.maxBytes || MAX_LOG_BYTES, opts.now || new Date());
  const usage = record.usage && typeof record.usage === 'object' ? record.usage : null;
  const measured = record.measured === undefined ? !!usage : !!record.measured;
  const normalized = {
    id: record.id || null,
    timestamp: record.timestamp || new Date().toISOString(),
    adapter: record.adapter || 'unknown',
    mode: record.mode || 'unknown',
    model: record.model || 'default',
    label: record.label || '',
    sessionId: record.sessionId || null,
    measured,
    usage: measured ? usage : null,
    effort: record.effort ?? null,
    attempt: record.attempt ?? null,
    quota: record.quota ?? null,
    modelCalls: record.modelCalls ?? null,
    peakContext: record.peakContext ?? null,
    contextWindow: record.contextWindow ?? null,
    verdict: record.verdict ?? null,
  };
  fs.appendFileSync(file, JSON.stringify(normalized) + '\n');
  return true;
}

function listLogFiles(file) {
  const dir = path.dirname(file);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const base = path.basename(file);
  const stem = base.replace(/\.jsonl$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const archivePattern = new RegExp(`^${stem}\\.\\d{8}T\\d{6}\\d*Z\\.\\d+\\.jsonl$`);
  const archives = names
    .filter((name) => archivePattern.test(name))
    .sort()
    .map((name) => path.join(dir, name));
  if (names.includes(base)) archives.push(file);
  return archives;
}

function readRecords(file, nowMs = Date.now(), days = 30) {
  const since = nowMs - days * 864e5;
  const byId = new Map();
  let anonymous = 0;
  for (const candidate of listLogFiles(file)) {
    let text = '';
    try { text = fs.readFileSync(candidate, 'utf8'); } catch (_) { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const ts = Date.parse(record.timestamp);
        if (!Number.isFinite(ts) || ts < since) continue;
        const key = record.id ? `id:${record.id}` : `anon:${anonymous++}`;
        byId.set(key, record);
      } catch (_) {}
    }
  }
  return [...byId.values()];
}

function summarize(records) {
  const groups = new Map();
  for (const r of records) {
    if (r.mode === 'verdict') continue;
    const model = r.model || 'default';
    const modelWithEffort = r.effort ? `${model}@${r.effort}` : model;
    const key = `${r.adapter || 'unknown'} / ${modelWithEffort} / ${r.mode || 'unknown'}`;
    const measured = r.measured === undefined ? !!r.usage : !!r.measured;
    const g = groups.get(key) || {
      route: key, runs: 0, measuredRuns: 0, unmeasuredRuns: 0,
      inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
      quotaRuns: 0, weeklyDelta: null, fiveHourDelta: null, quotaTokens: 0, fiveHourRuns: 0, weeklyRuns: 0,
      _weeklyDeltaSum: 0, _weeklyTokens: 0, _fiveHourDeltaSum: 0, _fiveHourTokens: 0,
    };
    g.runs += 1;
    const runTokens = measured && r.usage
      ? (Number(r.usage.totalTokens) || ((Number(r.usage.inputTokens) || 0) + (Number(r.usage.outputTokens) || 0)))
      : 0;
    const quota = r.quota && typeof r.quota === 'object' ? r.quota : null;
    const primary = quota && quota.primary;
    const secondary = quota && quota.secondary;
    const usableWindow = (window) => window && window.reset !== true
      && Number.isFinite(Number(window.start)) && Number.isFinite(Number(window.end));
    const usablePrimary = usableWindow(primary);
    const usableSecondary = usableWindow(secondary);
    const hasQuotaTokens = runTokens > 0;
    if (hasQuotaTokens && (usablePrimary || usableSecondary)) {
      g.quotaRuns += 1;
      g.quotaTokens += runTokens;
    }
    if (hasQuotaTokens && usablePrimary) {
      g.fiveHourRuns += 1;
      g._fiveHourDeltaSum += Number(primary.end) - Number(primary.start);
      g._fiveHourTokens += runTokens;
    }
    if (hasQuotaTokens && usableSecondary) {
      g.weeklyRuns += 1;
      g._weeklyDeltaSum += Number(secondary.end) - Number(secondary.start);
      g._weeklyTokens += runTokens;
    }
    if (!measured || !r.usage) {
      g.unmeasuredRuns += 1;
      groups.set(key, g);
      continue;
    }
    g.measuredRuns += 1;
    for (const k of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
      g[k] += Number(r.usage[k]) || 0;
    }
    g.totalTokens += Number(r.usage.totalTokens)
      || ((Number(r.usage.inputTokens) || 0) + (Number(r.usage.outputTokens) || 0));
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.weeklyDelta = g._weeklyTokens ? (g._weeklyDeltaSum / g._weeklyTokens) * 1e6 : null;
    g.fiveHourDelta = g._fiveHourTokens ? (g._fiveHourDeltaSum / g._fiveHourTokens) * 1e6 : null;
    delete g._weeklyDeltaSum;
    delete g._weeklyTokens;
    delete g._fiveHourDeltaSum;
    delete g._fiveHourTokens;
  }
  return [...groups.values()].sort((a, b) =>
    b.totalTokens - a.totalTokens || b.runs - a.runs || a.route.localeCompare(b.route));
}

// Claude SubagentStop labels can end in punctuation (`…/implement.`).
function normalizeLabel(label) {
  return String(label || '').trim().replace(/[.\s]+$/, '').replace(/\/+$/, '');
}

function writerKey(r) {
  const model = r.model || 'default';
  return `${r.adapter || 'unknown'} / ${r.effort ? `${model}@${r.effort}` : model}`;
}

// Only real writer runs are join candidates: reviewer, runner, and coordinator
// rows can carry an `/implement` label because usage-capture takes the first
// label in the transcript.
const WRITER_MODES = new Set(['execute', 'subagent:rstaff:implementer', 'subagent:rstaff-engineer:implementer']);

// Join each review verdict to the writer row `<label>/implement` written at or
// before it: same attempt first, else the newest. No match stays visible as
// `unattributed` rather than being dropped.
function summarizeVerdicts(records) {
  const writers = new Map();
  for (const r of records) {
    if (!WRITER_MODES.has(r.mode)) continue;
    const label = normalizeLabel(r.label);
    if (!label.endsWith('/implement')) continue;
    const list = writers.get(label) || [];
    list.push({ r, ts: Date.parse(r.timestamp) });
    writers.set(label, list);
  }
  const newest = (list) => list.reduce((a, b) => (b.ts > a.ts ? b : a));
  const groups = new Map();
  for (const v of records) {
    if (v.mode !== 'verdict') continue;
    const candidates = writers.get(`${normalizeLabel(v.label)}/implement`) || [];
    const vts = Date.parse(v.timestamp);
    const before = candidates.filter((c) => Number.isFinite(c.ts) && c.ts <= vts);
    const sameAttempt = before.filter((c) => v.attempt != null && c.r.attempt === v.attempt);
    const match = sameAttempt.length ? newest(sameAttempt) : before.length ? newest(before) : null;
    const writer = match ? writerKey(match.r) : 'unattributed';
    const g = groups.get(writer) || {
      writer, verdicts: 0, pass: 0, block: 0, passRate: null,
      firstVerdicts: 0, firstPass: 0, firstPassRate: null,
    };
    const pass = v.verdict === 'pass';
    g.verdicts += 1;
    if (pass) g.pass += 1; else g.block += 1;
    if (v.attempt === 1) {
      g.firstVerdicts += 1;
      if (pass) g.firstPass += 1;
    }
    groups.set(writer, g);
  }
  for (const g of groups.values()) {
    g.passRate = g.verdicts ? g.pass / g.verdicts : null;
    g.firstPassRate = g.firstVerdicts ? g.firstPass / g.firstVerdicts : null;
  }
  return [...groups.values()].sort((a, b) => b.verdicts - a.verdicts || a.writer.localeCompare(b.writer));
}

function fingerprint(file, nowMs, days) {
  const parts = [`day:${Math.floor(nowMs / 864e5)}`, `days:${days}`];
  for (const candidate of listLogFiles(file)) {
    try {
      const s = fs.statSync(candidate);
      parts.push(`${path.basename(candidate)}:${s.size}:${s.mtimeMs}`);
    } catch (_) {}
  }
  return parts.join('|');
}

function loadSummary(file, nowMs = Date.now(), days = 30) {
  const cacheFile = file + CACHE_SUFFIX;
  const key = fingerprint(file, nowMs, days);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.fingerprint === key && Array.isArray(cached.groups) && Array.isArray(cached.verdicts)) {
      return { groups: cached.groups, verdicts: cached.verdicts };
    }
  } catch (_) {}
  const records = readRecords(file, nowMs, days);
  const groups = summarize(records);
  const verdicts = summarizeVerdicts(records);
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ fingerprint: key, groups, verdicts }) + '\n');
  } catch (_) {}
  return { groups, verdicts };
}

function summarizeCached(file, nowMs = Date.now(), days = 30) {
  return loadSummary(file, nowMs, days).groups;
}

function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

function display(g, key) {
  return g.measuredRuns ? formatNumber(g[key]) : '—';
}

function quotaDeltaDisplay(g, key) {
  return g.quotaRuns > 0 && Number.isFinite(g[key]) ? g[key].toFixed(2) : '—';
}

function quotaRunsDisplay(g, key) {
  return Number.isInteger(g[key]) ? String(g[key]) : '—';
}

function percentDisplay(rate) {
  return Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—';
}

function render(groups, days, verdicts = []) {
  const lines = [
    `# rstaff token usage — last ${days}d`,
    '',
    '| route | runs | measured | unmeasured | prompt input | cache read | cache write | output | reasoning | total | Δ5h%/1M | n5h | Δweekly%/1M | nWeekly |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  if (!groups.length) lines.push('| no captured runs | 0 | 0 | 0 | — | — | — | — | — | — | — | — | — | — |');
  for (const g of groups) {
    lines.push(`| ${g.route} | ${g.runs} | ${g.measuredRuns} | ${g.unmeasuredRuns} | ${display(g, 'inputTokens')} | ${display(g, 'cachedInputTokens')} | ${display(g, 'cacheWriteInputTokens')} | ${display(g, 'outputTokens')} | ${display(g, 'reasoningOutputTokens')} | ${display(g, 'totalTokens')} | ${quotaDeltaDisplay(g, 'fiveHourDelta')} | ${quotaRunsDisplay(g, 'fiveHourRuns')} | ${quotaDeltaDisplay(g, 'weeklyDelta')} | ${quotaRunsDisplay(g, 'weeklyRuns')} |`);
  }
  const measuredRuns = groups.reduce((n, g) => n + g.measuredRuns, 0);
  const runs = groups.reduce((n, g) => n + g.runs, 0);
  const total = groups.reduce((n, g) => n + g.totalTokens, 0);
  lines.push('', `Measured total: ${formatNumber(total)} provider-native tokens across ${measuredRuns}/${runs} captured runs.`);
  lines.push('Provider tokenizers and subscription/API billing differ; counts are directional and no currency is inferred.');
  lines.push('Quota deltas are biased: first call precedes the first reading; concurrent runs share quota.');
  if (verdicts && verdicts.length) {
    lines.push('', '## Review pass rate by writer', '',
      '| writer | verdicts | pass | block | pass% | first-attempt pass% |',
      '|---|---:|---:|---:|---:|---:|');
    for (const v of verdicts) {
      lines.push(`| ${v.writer} | ${v.verdicts} | ${v.pass} | ${v.block} | ${percentDisplay(v.passRate)} | ${percentDisplay(v.firstPassRate)} |`);
    }
    lines.push('', 'Task-mode reviewer verdicts joined to the `<label>/implement` writer row (same attempt, else newest before the verdict).');
  }
  return lines.join('\n') + '\n';
}

function parseDays(argv) {
  const i = argv.indexOf('--days');
  if (i < 0) return 30;
  const days = Number(argv[i + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('--days must be an integer from 1 to 3650');
  return days;
}

if (require.main === module) {
  try {
    const days = parseDays(process.argv.slice(2));
    const home = lib.resolveHome(process.cwd());
    const file = path.join(home, 'var', 'usage.jsonl');
    const { groups, verdicts } = loadSummary(file, Date.now(), days);
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ home, file, days, groups, verdicts }, null, 2) + '\n');
    } else {
      process.stdout.write(render(groups, days, verdicts));
    }
  } catch (e) {
    process.stderr.write(`usage: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  MAX_LOG_BYTES, resolveUsageLog, rotateIfNeeded, appendRecord, listLogFiles,
  readRecords, summarize, summarizeVerdicts, loadSummary, summarizeCached, render, parseDays,
};
