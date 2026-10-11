#!/usr/bin/env node
// SessionEnd/SubagentStop: aggregate Claude transcript usage without storing
// transcript content. Claude transcripts repeat snapshots, so dedupe by message.
'use strict';
const { fs, path, readEvent, resolveHome, isControlRepo, slug, warn } = require('./lib');
const usageLog = require(path.join(__dirname, '..', 'scripts', 'usage.js'));

function number(u, key) {
  const value = Number(u && u[key]);
  return Number.isFinite(value) ? value : 0;
}

function normalizeClaudeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const uncached = number(u, 'input_tokens');
  const cacheRead = number(u, 'cache_read_input_tokens');
  const cacheWrite = number(u, 'cache_creation_input_tokens');
  const output = number(u, 'output_tokens');
  const usage = {
    inputTokens: uncached + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: uncached + cacheRead + cacheWrite + output,
  };
  return Object.values(usage).every((value) => value === 0) ? null : usage;
}

function addUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
    out[key] = (Number(a[key]) || 0) + (Number(b[key]) || 0);
  }
  out.totalTokens = out.inputTokens + out.outputTokens;
  return out;
}

function parseClaudeTranscript(text) {
  const messages = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    if (!row.message || !row.message.usage) continue;
    const id = row.message.id || row.requestId || row.uuid;
    if (!id) continue;
    messages.set(id, {
      model: row.message.model || 'default',
      timestamp: row.timestamp || null,
      usage: normalizeClaudeUsage(row.message.usage),
    });
  }
  const models = new Map();
  for (const message of messages.values()) {
    if (!message.usage) continue;
    const current = models.get(message.model) || { usage: null, timestamp: null, messages: 0 };
    current.usage = addUsage(current.usage, message.usage);
    current.messages += 1;
    if (!current.timestamp || Date.parse(message.timestamp) > Date.parse(current.timestamp)) {
      current.timestamp = message.timestamp;
    }
    models.set(message.model, current);
  }
  return models;
}

function extractUsageLabel(text) {
  const match = String(text || '').match(
    /rstaff-usage-label:\s*([a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9._-]+)/i,
  );
  return match ? match[1] : null;
}

function recordsForEvent(ev, env = process.env) {
  const subagent = ev.hook_event_name === 'SubagentStop';
  const transcript = subagent ? ev.agent_transcript_path : ev.transcript_path;
  if (!transcript) return [];
  let text = '';
  try { text = fs.readFileSync(transcript, 'utf8'); } catch (_) { return []; }
  const models = parseClaudeTranscript(text);
  const sessionId = ev.session_id || 'unknown';
  const actor = subagent ? (ev.agent_id || 'subagent') : 'main';
  const mode = subagent ? `subagent:${ev.agent_type || 'unknown'}` : 'coordinator';
  const transcriptLabel = extractUsageLabel(text);
  const label = (subagent ? transcriptLabel : env.RSTAFF_USAGE_LABEL)
    || env.RSTAFF_USAGE_LABEL
    || transcriptLabel
    || `${slug(ev.cwd || process.cwd())}/${mode}`;
  const records = [];
  for (const [model, aggregate] of models) {
    records.push({
      id: `claude:${sessionId}:${actor}:${model}`,
      timestamp: aggregate.timestamp || new Date().toISOString(),
      adapter: 'claude',
      mode,
      model,
      label,
      sessionId,
      measured: true,
      usage: aggregate.usage,
    });
  }
  return records;
}

function capture(ev, env = process.env) {
  const home = resolveHome(ev.cwd || process.cwd());
  if (!isControlRepo(home)) return 0;
  const file = path.join(home, 'var', 'usage.jsonl');
  const records = recordsForEvent(ev, env);
  for (const record of records) usageLog.appendRecord(file, record);
  return records.length;
}

if (require.main === module) {
  const ev = readEvent();
  try { capture(ev); }
  catch (e) { warn(`cannot capture Claude usage: ${e.code || e.message}`); }
  process.exit(0);
}

module.exports = {
  normalizeClaudeUsage, addUsage, parseClaudeTranscript, extractUsageLabel,
  recordsForEvent, capture,
};
