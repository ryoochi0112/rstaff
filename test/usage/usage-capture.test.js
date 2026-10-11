'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require(path.join(__dirname, '..', '..', 'plugins', 'rstaff-usage', 'hooks', 'usage-capture.js'));

function row(id, requestId, model, usage, timestamp) {
  return JSON.stringify({
    type: 'assistant', requestId, uuid: `${id}-snapshot`, timestamp,
    message: { id, model, usage, content: [{ type: 'text', text: 'private prompt content' }] },
  });
}

test('parseClaudeTranscript deduplicates repeated snapshots and groups models', () => {
  const usage = { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 7 };
  const models = C.parseClaudeTranscript([
    row('m1', 'r1', 'claude-sonnet', usage, '2026-07-28T00:00:00Z'),
    row('m1', 'r1', 'claude-sonnet', usage, '2026-07-28T00:00:01Z'),
    row('m2', 'r2', 'claude-opus', { input_tokens: 11, output_tokens: 13 }, '2026-07-28T00:00:02Z'),
  ].join('\n'));
  assert.equal(models.size, 2);
  assert.deepEqual(models.get('claude-sonnet').usage, {
    inputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 3,
    outputTokens: 7, reasoningOutputTokens: 0, totalTokens: 17,
  });
});

test('parseClaudeTranscript falls back to requestId when message.id is absent', () => {
  const snapshot = {
    type: 'assistant',
    requestId: 'request-only',
    timestamp: '2026-07-28T00:00:00Z',
    message: {
      model: 'claude-sonnet',
      usage: { input_tokens: 4, output_tokens: 2 },
      content: [{ type: 'text', text: 'private' }],
    },
  };
  const models = C.parseClaudeTranscript([
    JSON.stringify(snapshot),
    JSON.stringify({ ...snapshot, timestamp: '2026-07-28T00:00:01Z' }),
  ].join('\n'));
  assert.equal(models.get('claude-sonnet').messages, 1);
  assert.equal(models.get('claude-sonnet').usage.totalTokens, 6);
});

test('recordsForEvent captures coordinator and subagent metadata without content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-claude-capture-'));
  const transcript = path.join(dir, 'agent.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: 'user',
      message: { content: 'rstaff-usage-label: repo/feature/T1/review\nprivate task brief' },
    }),
    row('m1', 'r1', 'claude-sonnet', { input_tokens: 2, output_tokens: 3 }, '2026-07-28T00:00:00Z'),
  ].join('\n'));
  try {
    const main = C.recordsForEvent({
      hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcript, cwd: '/work/repo',
    }, { RSTAFF_USAGE_LABEL: 'bench/all-claude' });
    const sub = C.recordsForEvent({
      hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1',
      agent_type: 'reviewer', agent_transcript_path: transcript, cwd: '/work/repo',
    }, {});
    assert.equal(main[0].id, 'claude:s1:main:claude-sonnet');
    assert.equal(main[0].label, 'bench/all-claude');
    assert.equal(sub[0].mode, 'subagent:reviewer');
    assert.equal(sub[0].id, 'claude:s1:a1:claude-sonnet');
    assert.equal(sub[0].label, 'repo/feature/T1/review');
    assert.doesNotMatch(JSON.stringify([...main, ...sub]), /private prompt content/);
    assert.doesNotMatch(JSON.stringify([...main, ...sub]), /private task brief/);
    assert.doesNotMatch(JSON.stringify([...main, ...sub]), /agent\.jsonl/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('capture uses stable ids so resumed cumulative snapshots do not double-count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-claude-resume-'));
  const transcript = path.join(dir, 'session.jsonl');
  const previous = process.env.RSTAFF_HOME;
  try {
    fs.writeFileSync(path.join(dir, 'rstaff.json'), '{}\n');
    fs.writeFileSync(transcript, row('m1', 'r1', 'claude-sonnet', { input_tokens: 3, output_tokens: 2 }, '2026-07-28T00:00:00Z'));
    process.env.RSTAFF_HOME = dir;
    const event = {
      hook_event_name: 'SessionEnd', session_id: 'resumed-session',
      transcript_path: transcript, cwd: dir,
    };
    assert.equal(C.capture(event), 1);
    fs.appendFileSync(transcript, '\n' + row('m2', 'r2', 'claude-sonnet', { input_tokens: 5, output_tokens: 1 }, '2026-07-28T00:00:01Z'));
    assert.equal(C.capture(event), 1);
    const records = require(path.join(__dirname, '..', '..', 'plugins', 'rstaff-usage', 'scripts', 'usage.js'))
      .readRecords(path.join(dir, 'var', 'usage.jsonl'), Date.parse('2026-07-28T01:00:00Z'), 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'claude:resumed-session:main:claude-sonnet');
    assert.equal(records[0].usage.totalTokens, 11);
  } finally {
    if (previous === undefined) delete process.env.RSTAFF_HOME;
    else process.env.RSTAFF_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
