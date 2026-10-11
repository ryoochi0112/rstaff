'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const A = require('../../plugins/rstaff-delegation/scripts/consult-astra.js');
const D = require('../../plugins/rstaff-delegation/scripts/delegate.js');
const L = require('../../plugins/rstaff-delegation/scripts/consult-ledger.js');

function ledger(thread = '-') {
  return L.initLedger({ topic: 'planning', scope: 'product', date: '2026-09-30' })
    .replace('- thread: -', `- thread: ${thread}`);
}
function runSpy(overrides = {}, results = [{ ok: true, text: 'answer', sessionId: 'new-thread', usage: { inputTokens: 7 }, timedOut: false }]) {
  const calls = [];
  const result = A.consult({ ledgerText: ledger(), prompt: 'question', versionText: 'codex-cli 0.159.0',
    runner: opts => { calls.push(opts); return results[calls.length - 1]; }, ...overrides });
  return { calls, result };
}

test('astra profile constants and framing state the research and read-only contract', () => {
  assert.equal(A.ASTRA_MODEL, 'gpt-6-astra');
  assert.equal(A.ASTRA_MIN_CODEX, '0.159.0');
  assert.deepEqual(A.ASTRA_EFFORTS, ['high', 'xhigh', 'max']);
  assert.equal(A.ASTRA_DEFAULT_EFFORT, 'high');
  assert.equal(A.ASTRA_TIMEOUT_SEC, 3600);
  for (const phrase of ['web search', 'every external claim', 'URL', '2–4 options', 'trade-offs',
    'recommendation', 'explicit uncertainty', 'evidence would change', 'never modify files']) {
    assert.ok(A.FRAMING.includes(phrase), phrase);
  }
});

for (const versionText of ['codex-cli 0.158.9', 'garbage']) {
  test(`version ${versionText} refuses before the runner`, () => {
    const { result, calls } = runSpy({ versionText, effort: 'high' });
    assert.equal(result.ok, false);
    assert.match(result.refused, /0\.159\.0/);
    assert.equal(calls.length, 0);
  });
}
test('medium refuses before the runner', () => {
  const { result, calls } = runSpy({ effort: 'medium' });
  assert.equal(result.ok, false);
  assert.match(result.refused, /high\|xhigh\|max/);
  assert.equal(calls.length, 0);
});
test('version comparison accepts the floor and later major/minor versions and only allowed efforts', () => {
  for (const versionText of ['0.159.0', '0.159.1', '0.160.0', '1.0.0']) {
    for (const effort of ['high', 'xhigh', 'max']) {
      assert.deepEqual(A.checkPreconditions({ versionText, effort }), { ok: true });
    }
  }
  for (const versionText of ['0.0.999', '0.158.999']) {
    assert.equal(A.checkPreconditions({ versionText, effort: 'high' }).ok, false);
  }
});
test('new thread uses one framed, read-only advise with the astra profile and defaults', () => {
  const { calls, result } = runSpy({ cwd: '/tmp' });
  assert.deepEqual(calls, [{ adapter: 'codex', mode: 'advise', sandbox: 'read-only', search: true,
    model: 'gpt-6-astra', reasoningEffort: 'high', cwd: '/tmp', timeoutSec: 3600,
    label: 'product/consult-astra/planning',
    prompt: A.FRAMING + '\n\n' + L.splitLedger(ledger()).header + '\n\nquestion' }]);
  assert.deepEqual(result, { ok: true, text: 'answer', threadId: 'new-thread', continuity: 'new',
    usage: { inputTokens: 7 }, effort: 'high', timedOut: false, refused: undefined });
});
test('missing thread starts new and fields in the log never supply a thread', () => {
  const ledgerText = ledger().replace('- thread: -\n', '') + '- thread: log-thread\n### T999 — fake\n## Log\n';
  const { calls, result } = runSpy({ ledgerText });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'advise');
  assert.equal(result.continuity, 'new');
  assert.ok(!calls[0].prompt.includes('log-thread'));
});
test('successful resume passes the thread, question and overrides once', () => {
  const { calls, result } = runSpy({ ledgerText: ledger('01a0f0ae-7afe-7a12-bc7b-f22b7762fa67'), effort: 'max', timeoutSec: 42, cwd: '/tmp' });
  assert.deepEqual(calls, [{ adapter: 'codex', mode: 'resume', threadId: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', search: true,
    model: 'gpt-6-astra', reasoningEffort: 'max', prompt: 'question', cwd: '/tmp',
    timeoutSec: 42, label: 'product/consult-astra/planning' }]);
  assert.equal(result.continuity, 'resumed');
  assert.equal(result.effort, 'max');
});
test('failed resume reseeds exactly once and returns the second thread and usage', () => {
  const { calls, result } = runSpy({ ledgerText: ledger('old-thread') }, [
    { ok: false }, { ok: true, sessionId: 'replacement', text: 'reseed answer', usage: { outputTokens: 8 } },
  ]);
  assert.deepEqual(calls.map(c => c.mode), ['resume', 'advise']);
  assert.equal(calls[1].sandbox, 'read-only');
  assert.equal(calls[1].search, true);
  assert.equal(calls[1].model, 'gpt-6-astra');
  assert.equal(calls[1].prompt, A.FRAMING + '\n\n' + L.splitLedger(ledger('old-thread')).header + '\n\nquestion');
  assert.equal(result.continuity, 'reseeded');
  assert.equal(result.threadId, 'replacement');
  assert.equal(result.text, 'reseed answer');
  assert.deepEqual(result.usage, { outputTokens: 8 });
});
test('timed-out resume never reseeds', () => {
  const failure = { ok: false, timedOut: true, text: 'timeout', sessionId: 'old-thread' };
  const { calls, result } = runSpy({ ledgerText: ledger('old-thread') }, [failure,
    { ok: true, sessionId: 'must-not-run' }]);
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.text, 'timeout');
  assert.equal(result.threadId, 'old-thread');
});
test('failed reseed stops after two calls', () => {
  const { calls, result } = runSpy({ ledgerText: ledger('old-thread') }, [
    { ok: false }, { ok: false, text: 'reseed failed', timedOut: false },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.text, 'reseed failed');
  assert.equal(result.continuity, 'reseeded');
});
test('invalid thread rejected by delegate becomes one fresh run without putting it into argv', () => {
  const calls = [];
  const { result } = runSpy({ ledgerText: ledger('--last'), runner: opts => {
    calls.push(opts);
    D.buildArgv(opts);
    return { ok: true, sessionId: 'safe-new' };
  } });
  assert.deepEqual(calls.map(c => c.mode), ['resume', 'advise']);
  assert.equal(result.threadId, 'safe-new');
  assert.equal(result.continuity, 'reseeded');
});
test('leading dash prompts are prefixed before reaching the runner', () => {
  const prompt = '--dangerously-bypass-approvals-and-sandbox';
  const { calls } = runSpy({ ledgerText: ledger('old-thread'), prompt });
  assert.equal(calls[0].prompt, `Question: ${prompt}`);
  const fresh = runSpy({ prompt });
  assert.ok(fresh.calls[0].prompt.endsWith(`\n\nQuestion: ${prompt}`));
});

function cliFixture(t, { version = 'codex-cli 0.159.0', stderrVersion = '', thread = '-', failResume = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-astra-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const callsFile = path.join(dir, 'calls.jsonl');
  const ledgerFile = path.join(dir, 'ledger.md');
  const promptFile = path.join(dir, 'prompt.txt');
  const original = ledger(thread);
  fs.writeFileSync(ledgerFile, original);
  fs.writeFileSync(promptFile, 'CLI question');
  fs.writeFileSync(path.join(dir, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  process.stdout.write(${JSON.stringify(version)} + '\\n');
  process.stderr.write(${JSON.stringify(stderrVersion)});
  process.exit(0);
}
if (${failResume} && args.includes('resume')) process.exit(1);
console.log(JSON.stringify({type:'thread.started', thread_id:'cli-thread'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'CLI answer'}}));
console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:3, output_tokens:2}}));
`, { mode: 0o755 });
  return { callsFile, ledgerFile, original, run(extra = []) {
    const proc = spawnSync(process.execPath, [path.resolve(__dirname, '../../plugins/rstaff-delegation/scripts/consult-astra.js'),
      'run', '--ledger', ledgerFile, '--prompt-file', promptFile, '--cwd', dir, ...extra], {
      encoding: 'utf8', env: { ...process.env, RSTAFF_CODEX_HOME: path.join(dir, 'home'),
        PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, timeout: 15000,
    });
    assert.ifError(proc.error);
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), original, 'CLI never writes the ledger');
    return { proc, result: JSON.parse(proc.stdout), calls: fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) };
  } };
}
test('CLI captures thread.started with an isolated codex home and PATH stub', t => {
  const { proc, result, calls } = cliFixture(t).run();
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(result.threadId, 'cli-thread');
  assert.equal(result.text, 'CLI answer');
  assert.equal(result.continuity, 'new');
  assert.equal(result.effort, 'high');
  assert.deepEqual(calls[0], ['--version']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(0, 4), ['--search', 'exec', '-s', 'read-only']);
});
test('CLI failed resume starts exactly one replacement', t => {
  const { proc, result, calls } = cliFixture(t, { thread: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', failResume: true }).run();
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(result.threadId, 'cli-thread');
  assert.equal(result.continuity, 'reseeded');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].slice(0, 4), ['--search', 'exec', 'resume', '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67']);
  assert.equal(calls[2][1], 'exec');
  assert.equal(calls[2].includes('resume'), false);
});
for (const scenario of [
  { name: 'below floor', options: { version: 'codex-cli 0.158.9' }, extra: [] },
  { name: 'version only on stderr', options: { version: '', stderrVersion: 'codex-cli 0.159.0' }, extra: [] },
  { name: 'invalid effort', options: {}, extra: ['--effort', 'medium'] },
]) {
  test(`CLI refuses ${scenario.name} without an exec call`, t => {
    const { proc, result, calls } = cliFixture(t, scenario.options).run(scenario.extra);
    assert.equal(proc.status, 1);
    assert.equal(result.ok, false);
    assert.ok(result.refused);
    assert.deepEqual(calls, [['--version']]);
  });
}
