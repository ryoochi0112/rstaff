#!/usr/bin/env node
// UserPromptSubmit: a MECHANICAL context ceiling.
//
// "End a session at each unit of work" (CLAUDE.md) was the one non-negotiable
// with no mechanism behind it, and it is the only Aug-2 finding that regressed:
// within 48h a 16.4h / 509-turn session peaked at 722k, and across 3 days 577M
// of 1.41B context tokens (41%) were attributable purely to running above 200k.
// The other findings that day got a hook and an exit-1 assertion, and both held.
// So this rule gets teeth too.
//
// Why UserPromptSubmit and not a PreCompact/SessionEnd hook: PreCompact/SessionEnd fire when the
// session is already over or already too big to continue. A ceiling has to fire
// while there is still a decision to make — and the moment a human adds work to a
// long session is exactly that moment.
//
// Advisory by design. It never blocks a prompt: the human stays sovereign, and a
// gate that stops you mid-thought gets uninstalled. It fires at most ONCE per
// tier per session, because a warning repeated every prompt is how a gate turns
// into noise (see health.js printing "all green" over a WARN).
'use strict';
const { path, os, readEvent, resolveHome, isControlRepo, ensureDir, warn, emitContext, fs, pass } = require('./lib');

const WARN_AT = 200000;      // context above here was 41% of a measured 3-day spend
const INSIST_AT = 400000;    // 1,115 turns ran above this in the same window
const TAIL_BYTES = 512 * 1024;

// Read the last `bytes` of a file without loading the whole thing — transcripts
// reach 5MB, and re-reading that on every prompt would be its own waste.
function tailRead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // A tail read lands mid-line; that leading fragment is not valid JSON. Drop
    // it rather than letting it fail a parse that then looks like "no usage".
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// What a turn actually re-sends = fresh input + cache write + cache READ.
// cache_read is the whole point: it is ~97% of every turn in this repo's own
// telemetry, so a ceiling that summed only input_tokens would read ~0 forever
// and never fire. Pinned by test/context-ceiling.test.js.
function contextTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

// The NEWEST assistant turn decides, so scan backwards and stop at the first
// one. Not max(): a compaction legitimately lowers what the next turn re-sends,
// and a high-water mark would keep firing over a session that already recovered.
function latestContext(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let d;
    try { d = JSON.parse(line); } catch (_) { continue; }
    if (d.type !== 'assistant') continue;
    const n = contextTokens(d.message && d.message.usage);
    if (n > 0) return n;
  }
  return 0;
}

const ev = readEvent();
const transcript = ev.transcript_path;
if (!transcript) pass();

const ctx = latestContext(tailRead(transcript, TAIL_BYTES));
const tier = ctx >= INSIST_AT ? 2 : ctx >= WARN_AT ? 1 : 0;
if (!tier) pass();

// Tier state, so each threshold is announced once. Falls back to the system temp
// dir when there is no control repo — the ceiling is useful even with memory OFF,
// and without somewhere to remember the tier it would nag on every prompt.
const home = resolveHome(ev.cwd || process.cwd());
const stateDir = isControlRepo(home) ? path.join(home, 'var', 'sessions') : os.tmpdir();
const id = String(ev.session_id || path.basename(String(transcript)))
  .replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'session';
const stateFile = path.join(stateDir, `.ceiling-${id}.json`);

let prior = 0;
try { prior = Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).tier) || 0; } catch (_) {}
if (tier <= prior) pass();

try {
  ensureDir(stateDir);
  fs.writeFileSync(stateFile, JSON.stringify({ tier, ctx, ts: new Date().toISOString() }) + '\n');
} catch (e) {
  // Fail OPEN and still warn: a lost tier file means this may repeat, which is
  // a smaller cost than silently dropping the one signal about a 700k session.
  warn(`cannot write ${stateFile}: ${e.code || e.message}`);
}

const k = `${Math.round(ctx / 1000)}k`;
const msg = tier === 2
  ? [
    `## ⛔ rstaff context ceiling EXCEEDED — ${k} tokens`,
    '',
    `Every turn from here re-sends ~${k}. **Stop taking new work in this session.**`,
    'Checkpoint what is in flight (commit it, or write the next step down), then write a',
    'handoff note for the next session (what is done, what is next, what is open) and start',
    'a fresh session. Tell the human that is what you are doing',
    'and why — do not silently continue.',
    '',
    'Measured 2026-08-04 over 3 days: 1,115 turns ran above 400k; the worst session',
    'was 16.4h / 722k. This ceiling exists to stop that from being normal.',
  ].join('\n')
  : [
    `## ⚠ rstaff context ceiling — ${k} tokens`,
    '',
    `Every turn from here re-sends ~${k}. Finish the unit of work in flight, then`,
    'write a handoff note and restart. Do NOT accept a new, unrelated task in this context —',
    'start it in a fresh session instead.',
    '',
    'Measured 2026-08-04 over 3 days: context above 200k accounted for 577M of',
    '1.41B tokens (41%) — the single largest line item in the loop.',
  ].join('\n');

emitContext('UserPromptSubmit', msg);
