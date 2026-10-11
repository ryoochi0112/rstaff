// Consult ledger helpers and CLI — no network or live model calls.
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const script = path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'consult-ledger.js');
const L = require(script);
const brief = {
  topic: 'New Project', scope: '_new', date: '2026-09-30', goal: 'Choose a direction.',
  constraints: 'One week.', decided: 'A chosen option.', known: 'Two options exist.',
};
const turn = {
  at: '2026-09-30 12:00', effort: 'high', search: true, continuity: 'new',
  question: 'Which option?', answer: 'Option A.\nhttps://example.com/', reconcile: 'Agree.',
  usage: { input: 10, cached: 2, output: 3, reasoning: 1 },
};
const hash = (topic) => crypto.createHash('sha1').update(topic).digest('hex').slice(0, 6);

test('slugTopic: safe, lossy, empty, Japanese, leading dash and long topics', () => {
  assert.equal(L.slugTopic('New Project'), `new-project-${hash('New Project')}`);
  assert.equal(L.slugTopic('new-project'), 'new-project');
  assert.equal(L.slugTopic('NEW-PROJECT'), 'new-project');
  for (const topic of ['日本語の相談', '', '---']) {
    assert.equal(L.slugTopic(topic), hash(topic));
    assert.match(L.slugTopic(topic), /^[a-f0-9]{6}$/);
  }
  assert.equal(L.slugTopic('--new'), `new-${hash('--new')}`);
  const long = 'a'.repeat(61);
  assert.equal(L.slugTopic(long), `${'a'.repeat(53)}-${hash(long)}`);
  assert.equal(L.slugTopic('a'.repeat(60)), 'a'.repeat(60));
});

test('ledgerPath: absolute path, literal _new, scope slug and traversal inputs', () => {
  const ctrl = path.resolve('test-control');
  assert.equal(L.ledgerPath(ctrl, undefined, 'new-project'), path.join(ctrl, 'var', 'consults', '_new', 'new-project.md'));
  assert.equal(L.ledgerPath(ctrl, 'My Repo', 'new-project'), path.join(ctrl, 'var', 'consults', 'my-repo', 'new-project.md'));
  for (const value of ['../etc', '..', '/etc', '--scope', '日本語']) {
    const file = L.ledgerPath(ctrl, value, value);
    assert.ok(file.startsWith(path.join(ctrl, 'var', 'consults') + path.sep));
    assert.match(path.basename(file), /^[a-z0-9-]+\.md$/);
  }
});

test('ledgerPath: containment guard refuses a resolver returning an outside path', () => {
  // Slugging already blocks traversal; inject a bad resolver to exercise the
  // independent containment check rather than pinning only the slugger.
  const outside = path.resolve(os.tmpdir(), 'outside.md');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
    module,
    require: (name) => name === 'path' ? {
      ...path, resolve: (...parts) => parts.length === 3 && parts[1] === '_new' ? outside : path.resolve(...parts),
    } : require(name),
  });
  assert.throws(() => module.exports.ledgerPath('/ctrl', '_new', 'topic'), /must stay inside/);
});

test('initLedger: exact format, single final newline, split round-trip and header fields', () => {
  const text = L.initLedger(brief);
  assert.equal(text, '# Consult: New Project\n- scope: _new\n- created: 2026-09-30\n- model: gpt-6-astra\n- thread: -\n- status: open\n## Goal\nChoose a direction.\n## Constraints\nOne week.\n## Definition of decided\nA chosen option.\n## Known so far\nTwo options exist.\n## Current conclusions\n-\n## Open questions\n-\n## Decisions\n-\n## Log\n');
  const { header, log } = L.splitLedger(text);
  assert.equal(header + log, text);
  assert.equal(log, '## Log\n');
  assert.equal(L.readField(text, 'thread'), '-');
  assert.equal(L.readField(text, 'missing'), null);
  assert.equal(L.readField(text + '- log-only: hidden\n', 'log-only'), null);
  assert.equal(L.readField(text, 'th.*'), null);
  assert.match(L.initLedger({ ...brief, scope: undefined }), /^- scope: _new$/m);
});

test('splitLedger: first exact marker only, preserving CRLF and all log bytes', () => {
  const text = '## Logging\r\n## Log \r\n## Log\r\nanswer\r\n## Log\n';
  assert.deepEqual(L.splitLedger(text), {
    header: '## Logging\r\n## Log \r\n', log: '## Log\r\nanswer\r\n## Log\n',
  });
});

test('appendTurn: exact block, previous log bytes preserved and turn number auto-derived', () => {
  const initial = L.initLedger(brief);
  const one = L.appendTurn(initial, turn);
  assert.equal(one, initial + '\n### T1 — 2026-09-30 12:00 — effort=high search=on continuity=new\n**Q:** Which option?\n\n**Astra:**\nOption A.\nhttps://example.com/\n\n**Reconcile (Claude):**\nAgree.\n\n**Usage:** in=10 cached=2 out=3 reasoning=1\n');
  const two = L.appendTurn(one, { ...turn, search: false, continuity: 'resumed' });
  const oldLog = Buffer.from(L.splitLedger(one).log);
  assert.deepEqual(Buffer.from(L.splitLedger(two).log).subarray(0, oldLog.length), oldLog);
  assert.match(two, /^### T2 — .*search=off continuity=resumed$/m);
  assert.equal((two.match(/^### T\d+ — /gm) || []).length, 2);
  assert.equal(L.appendTurn(initial + '\n\n', turn), one);
  assert.equal(L.appendTurn(initial.slice(0, -1), turn), one);
});

test('appendTurn: explicit number and delegate usage aliases, preserving zero values', () => {
  const text = L.appendTurn(L.initLedger(brief), {
    ...turn, n: 7, usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 6, reasoningOutputTokens: 4 },
  });
  assert.match(text, /^### T7 — /m);
  assert.match(text, /\*\*Usage:\*\* in=20 cached=5 out=6 reasoning=4\n$/);
  assert.match(L.appendTurn(text, { ...turn, usage: { input: 0, inputTokens: 20 } }), /^### T2 — /m);
  assert.match(L.appendTurn(text, { ...turn, usage: {} }), /in=0 cached=0 out=0 reasoning=0\n$/);
  assert.match(L.appendTurn(text, { ...turn, usage: { input: 0, inputTokens: 20 } }), /in=0 cached=0 out=0 reasoning=0\n$/);
});

test('setHeader: rewrites selected fields and section bodies, keeping log byte-identical', () => {
  const original = L.appendTurn(L.initLedger(brief), {
    ...turn, answer: '- thread: log-thread\n## Current conclusions\nkeep $&\n## Log\r\n',
  });
  const updated = L.setHeader(original, {
    fields: { thread: 'thread-$&', status: 'closed' },
    sections: { 'Current conclusions': 'Option A.\nEvidence $&.', 'Open questions': 'Cost?', Decisions: '2026-09-30: A.' },
  });
  assert.deepEqual(Buffer.from(L.splitLedger(updated).log), Buffer.from(L.splitLedger(original).log));
  assert.equal(L.readField(updated, 'thread'), 'thread-$&');
  assert.equal(L.readField(updated, 'status'), 'closed');
  assert.equal(L.splitLedger(updated).header, L.splitLedger(original).header
    .replace('- thread: -', () => '- thread: thread-$&')
    .replace('- status: open', '- status: closed')
    .replace('## Current conclusions\n-\n', () => '## Current conclusions\nOption A.\nEvidence $&.\n')
    .replace('## Open questions\n-\n', '## Open questions\nCost?\n')
    .replace('## Decisions\n-\n', '## Decisions\n2026-09-30: A.\n'));
  assert.equal(L.setHeader(original, {}), original);
});

test('setHeader: refuses a null, empty, blank or "null" thread and writes nothing', () => {
  const original = L.initLedger(brief);
  for (const thread of [null, undefined, '', '   ', 'null']) {
    assert.throws(() => L.setHeader(original, { fields: { thread, status: 'closed' } }), /refusing empty thread id/, String(thread));
  }
  assert.equal(L.setHeader(original, { fields: { status: 'closed' } }).includes('- thread: -'), true);
});

test('missing exact Log marker: split, readField, append and setHeader all refuse', () => {
  for (const text of ['', '- thread: abc\n## Logging\n', '## Log extra\n']) {
    for (const run of [() => L.splitLedger(text), () => L.readField(text, 'thread'),
      () => L.appendTurn(text, turn), () => L.setHeader(text, { fields: { thread: 'new' } })]) {
      assert.throws(run, /ledger has no "## Log" line/);
    }
  }
});

test('CLI: path, init refusal, header and append with JSON file arguments', (t) => {
  const ctrl = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-ledger-'));
  t.after(() => fs.rmSync(ctrl, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const found = run('path', '--ctrl', ctrl, '--topic', '../etc');
  assert.equal(found.status, 0, found.stderr);
  const file = L.ledgerPath(ctrl, undefined, '../etc');
  assert.equal(found.stdout, file + '\n');
  const json = path.join(ctrl, 'input.json');
  fs.writeFileSync(json, JSON.stringify(brief));
  assert.equal(run('init', '--file', file, '--json', json).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), L.initLedger(brief));
  fs.writeFileSync(json, JSON.stringify({ ...brief, goal: 'Overwrite attempt.' }));
  const refused = run('init', '--file', file, '--json', json);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), L.initLedger(brief));
  fs.writeFileSync(json, JSON.stringify(turn));
  assert.equal(run('append', '--file', file, '--json', json).status, 0);
  const appended = L.appendTurn(L.initLedger(brief), turn);
  assert.equal(fs.readFileSync(file, 'utf8'), appended);
  const patch = { fields: { thread: 'thread-1' }, sections: { 'Current conclusions': 'A.' } };
  fs.writeFileSync(json, JSON.stringify(patch));
  assert.equal(run('header', '--file', file, '--json', json).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), L.setHeader(appended, patch));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  fs.writeFileSync(file, 'malformed');
  for (const command of ['header', 'append']) {
    assert.equal(run(command, '--file', file, '--json', json).status, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'malformed');
  }
});
