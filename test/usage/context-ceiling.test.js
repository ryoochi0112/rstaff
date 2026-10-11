// Context-ceiling contract — the mechanical half of "end a session at each unit
// of work". That rule shipped as prose on 2026-08-02 and regressed within 48h:
// a 16.4h / 722k-token session, and 577M of 1.41B context tokens (41%)
// attributable purely to running above 200k. Prose holds for a one-shot
// decision; it does not hold for a discipline that must be re-applied every 20
// minutes for 16 hours. So the ceiling is a hook, and these are its teeth.
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'plugins', 'rstaff-usage', 'hooks', 'guard-context.js');

// A genuine control repo so the tier state lands in var/sessions/, not tmpdir.
function mkctrl(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-${tag}-`));
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{"rstaff":"control-repo"}');
  return dir;
}

// A transcript is JSONL; only assistant turns carry usage. `turns` is a list of
// usage objects, oldest first, exactly as Claude Code appends them.
function mkTranscript(dir, turns) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, turns
    .map((usage) => JSON.stringify({ type: 'assistant', message: { usage } }))
    .join('\n') + '\n');
  return file;
}

// Session ids must be unique per RUN, not just per test: the no-control-repo case
// deliberately persists its tier state in the system temp dir, which outlives the
// process. A fixed id there made this suite pass once and fail on re-run.
const RUN = `${process.pid}x`;
let seq = 0;
function run(event, home) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event || {}),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...(home ? { RSTAFF_HOME: home } : {}) },
  });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch (_) {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
}
const ctxOf = (r) => (r.out.hookSpecificOutput || {}).additionalContext || '';
// One event, unique session id per call so tier state never leaks between tests.
function ev(home, file, id) {
  return { cwd: home, transcript_path: file, session_id: id || `${RUN}s${++seq}` };
}

test('below the ceiling the hook stays silent', () => {
  const home = mkctrl('ceiling-quiet');
  const file = mkTranscript(home, [{ input_tokens: 40, cache_read_input_tokens: 100000 }]);
  const r = run(ev(home, file), home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '', 'a session under the ceiling must cost nothing');
});

// The ceiling must account for cache reads, which are ~97% of every turn here, so an
// implementation that summed only input_tokens would read ~0 forever and never
// fire. This fixture can tell that broken version from the correct one — the
// fresh-input count alone (40) is three orders of magnitude below the ceiling.
test('cache_read alone crosses the ceiling', () => {
  const home = mkctrl('ceiling-cacheread');
  const file = mkTranscript(home, [{ input_tokens: 40, cache_read_input_tokens: 250000 }]);
  const r = run(ev(home, file), home);
  assert.equal(r.status, 0);
  const c = ctxOf(r);
  assert.match(c, /context ceiling/i, 'must fire on re-sent context, not just fresh input');
  assert.match(c, /250k/, 'must report the measured size so the number lands');
});

test('cache_creation counts toward the ceiling too', () => {
  const home = mkctrl('ceiling-cachewrite');
  const file = mkTranscript(home, [{ cache_creation_input_tokens: 210000 }]);
  assert.match(ctxOf(run(ev(home, file), home)), /context ceiling/i);
});

test('past the insist threshold the message escalates', () => {
  const home = mkctrl('ceiling-insist');
  const warnFile = mkTranscript(home, [{ cache_read_input_tokens: 250000 }]);
  const warned = ctxOf(run(ev(home, warnFile), home));
  const insistFile = mkTranscript(home, [{ cache_read_input_tokens: 450000 }]);
  const insisted = ctxOf(run(ev(home, insistFile), home));
  assert.match(warned, /context ceiling/i);
  assert.match(insisted, /context ceiling/i);
  assert.notEqual(warned, insisted, 'a 450k session must not read like a 250k one');
  assert.match(insisted, /stop taking new work/i, 'the hard tier must name the action');
});

// A gate that repeats itself every prompt is how a gate becomes noise — the same
// failure as health printing "all green" over a WARN.
test('the same tier never fires twice in one session', () => {
  const home = mkctrl('ceiling-once');
  const file = mkTranscript(home, [{ cache_read_input_tokens: 250000 }]);
  const first = run(ev(home, file, `${RUN}sticky`), home);
  const second = run(ev(home, file, `${RUN}sticky`), home);
  assert.match(ctxOf(first), /context ceiling/i);
  assert.equal(second.stdout.trim(), '', 'second prompt at the same tier must be silent');
});

test('crossing into the next tier fires again', () => {
  const home = mkctrl('ceiling-escalate');
  const warnFile = mkTranscript(home, [{ cache_read_input_tokens: 250000 }]);
  assert.match(ctxOf(run(ev(home, warnFile, `${RUN}climb`), home)), /context ceiling/i);
  const insistFile = mkTranscript(home, [{ cache_read_input_tokens: 450000 }]);
  const r = run({ cwd: home, transcript_path: insistFile, session_id: `${RUN}climb` }, home);
  assert.match(ctxOf(r), /stop taking new work/i, 'escalation must break through the de-dup');
});

// Context is what the NEXT turn re-sends, so the newest turn wins. A compaction
// legitimately lowers it; a max() over the file would keep screaming forever.
test('the newest turn decides, not the largest', () => {
  const home = mkctrl('ceiling-newest');
  const file = mkTranscript(home, [
    { cache_read_input_tokens: 600000 },   // pre-compaction peak
    { cache_read_input_tokens: 30000 },    // post-compaction: genuinely cheap again
  ]);
  const r = run(ev(home, file), home);
  assert.equal(r.stdout.trim(), '', 'a compacted session must not inherit its old peak');
});

test('a missing transcript is silent, never fatal', () => {
  const home = mkctrl('ceiling-notranscript');
  assert.equal(run({ cwd: home }, home).status, 0);
  assert.equal(run({ cwd: home }, home).stdout.trim(), '');
  const r = run(ev(home, path.join(home, 'does-not-exist.jsonl')), home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('a corrupt transcript is silent, never fatal', () => {
  const home = mkctrl('ceiling-corrupt');
  const file = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(file, 'not json\n{"type":"assistant","message":\n\0\n');
  const r = run(ev(home, file), home);
  assert.equal(r.status, 0, 'a hook must never break the session it observes');
  assert.equal(r.stdout.trim(), '');
});

// The ceiling is useful even where memory is off, so it must not depend on a
// control repo — it falls back to the system temp dir for its tier state.
test('the ceiling still fires with no control repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ceiling-nohome-'));
  const file = mkTranscript(dir, [{ cache_read_input_tokens: 250000 }]);
  const r = run({ cwd: dir, transcript_path: file, session_id: `${RUN}nohome${++seq}` });
  assert.equal(r.status, 0);
  assert.match(ctxOf(r), /context ceiling/i);
});

// Reading a 3-5MB transcript on every prompt is the kind of cost this hook
// exists to avoid, so it reads a bounded tail. Pinned: a large file whose
// ceiling-crossing turn is at the END is still detected.
test('a multi-megabyte transcript is read from the tail', () => {
  const home = mkctrl('ceiling-big');
  const file = path.join(home, 'transcript.jsonl');
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4000) } });
  const lines = [];
  for (let i = 0; i < 800; i++) lines.push(filler);          // ~3.2MB of padding
  lines.push(JSON.stringify({ type: 'assistant', message: { usage: { cache_read_input_tokens: 450000 } } }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 3_000_000, 'fixture must actually be large');
  assert.match(ctxOf(run(ev(home, file), home)), /stop taking new work/i);
});
