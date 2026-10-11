// delegate.js core tests — node:test, zero dependencies.
// argv building, the sandbox guard, model resolution, and output normalization
// are all PURE — every case here runs with NO network/auth/live CLI. Run:
// node --test test/delegate.test.js
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const D = require(path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'delegate.js'));
const { GEMINI_DRAFT_EXCLUDED_TOOLS } = D;

// --- buildArgv: all 6 adapter x mode combos --------------------------------
test('buildArgv: codex advise — exact bin + args', () => {
  const r = D.buildArgv({
    adapter: 'codex', mode: 'advise', cwd: '/work/repo', model: 'gpt-5.6-sol',
    sandbox: 'read-only', outputSchema: '/tmp/verdict.schema.json',
    lastMessageFile: '/tmp/last.txt', reasoningEffort: 'medium', prompt: 'review this plan',
  });
  assert.equal(r.bin, 'codex');
  assert.deepEqual(r.args, [
    'exec', '-s', 'read-only', '-C', '/work/repo', '--skip-git-repo-check',
    '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="medium"',
    '--output-schema', '/tmp/verdict.schema.json',
    '-o', '/tmp/last.txt', '--json', 'review this plan',
  ]);
});

test('buildArgv: codex advise omits absent optional flags (no model/schema/-o)', () => {
  const r = D.buildArgv({ adapter: 'codex', mode: 'advise', cwd: '/work/repo', sandbox: 'read-only', prompt: 'q' });
  assert.deepEqual(r.args, ['exec', '-s', 'read-only', '-C', '/work/repo', '--skip-git-repo-check', '--json', 'q']);
});

test('buildArgv: codex advise puts --search first, before exec', () => {
  const { args } = D.buildArgv({ adapter: 'codex', mode: 'advise', cwd: '/work/repo', search: true, prompt: 'q' });
  assert.equal(args[0], '--search');
  assert.equal(args[1], 'exec');
  assert.deepEqual(args.slice(2), ['-s', 'read-only', '-C', '/work/repo', '--skip-git-repo-check', '--json', 'q']);
});

test('buildArgv: codex review — exact bin + args (base, no prompt)', () => {
  const r = D.buildArgv({ adapter: 'codex', mode: 'review', base: 'main', sandbox: 'read-only' });
  assert.equal(r.bin, 'codex');
  assert.deepEqual(r.args, ['exec', 'review', '--base', 'main', '--json']);
});

test('buildArgv: codex review — with optional custom review instructions', () => {
  const r = D.buildArgv({ adapter: 'codex', mode: 'review', base: 'main', sandbox: 'read-only', prompt: 'focus on auth' });
  assert.deepEqual(r.args, ['exec', 'review', '--base', 'main', '--json', 'focus on auth']);
});

test('buildArgv: codex review puts --search before exec', () => {
  const { args } = D.buildArgv({ adapter: 'codex', mode: 'review', base: 'main', search: true });
  assert.deepEqual(args, ['--search', 'exec', 'review', '--base', 'main', '--json']);
});

test('buildArgv: codex resume — read-only config, no -s/-C, all optional flags', () => {
  const { bin, args } = D.buildArgv({
    adapter: 'codex', mode: 'resume', threadId: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', cwd: '/work/repo',
    search: true, sandbox: 'workspace-write', model: 'gpt-6-astra', reasoningEffort: 'high',
    outputSchema: '/tmp/verdict.schema.json', lastMessageFile: '/tmp/last.txt', prompt: 'follow up',
  });
  assert.equal(bin, 'codex');
  assert.deepEqual(args, [
    '--search', 'exec', 'resume', '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', '--skip-git-repo-check',
    '-c', 'sandbox_mode="read-only"',
    '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="high"',
    '--output-schema', '/tmp/verdict.schema.json', '-o', '/tmp/last.txt', '--json', 'follow up',
  ]);
  assert.deepEqual(args.slice(1, 4), ['exec', 'resume', '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67']);
  const sandboxIndex = args.indexOf('sandbox_mode="read-only"');
  assert.ok(sandboxIndex > 0);
  assert.equal(args[sandboxIndex - 1], '-c');
  assert.ok(!args.includes('-s'));
  assert.ok(!args.includes('-C'));
});

test('buildArgv: codex resume omits absent optional flags and keeps read-only', () => {
  const { args } = D.buildArgv({ adapter: 'codex', mode: 'resume', threadId: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67' });
  assert.deepEqual(args, ['exec', 'resume', '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '--json']);
});

test('buildArgv: codex resume requires a non-empty string threadId', () => {
  for (const threadId of [undefined, null, '', '   ', 123, {}]) {
    assert.throws(() => D.buildArgv({ adapter: 'codex', mode: 'resume', threadId }), /non-empty threadId/);
  }
});

test('buildArgv: codex resume rejects flag-like threadIds and invalid characters', () => {
  for (const threadId of [
    '--dangerously-bypass-approvals-and-sandbox', '--last', 'id with space',
    ' id', 'id ', 'id\t', 'id\n', 'id\r', 'id\0', 'id\u001b',
    '.id', '_id', ':id', 'id/other', 'id?other', 'idé',
    'my-session', '-x', 'A0._:-z', '019abc',
  ]) {
    assert.throws(
      () => D.buildArgv({ adapter: 'codex', mode: 'resume', threadId }),
      /session UUID/, JSON.stringify(threadId),
    );
  }
});

test('buildArgv: codex resume accepts only UUID threadIds, unchanged', () => {
  for (const threadId of ['01a0f0c4-65fa-7052-8e00-02ca15d4d561', '01A0F0AE-7AFE-7A12-BC7B-F22B7762FA67']) {
    const { args } = D.buildArgv({ adapter: 'codex', mode: 'resume', threadId });
    assert.deepEqual(args, ['exec', 'resume', threadId, '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '--json']);
  }
});

test('buildArgv: codex execute — exact bin + args', () => {
  const r = D.buildArgv({
    adapter: 'codex', mode: 'execute', cwd: '/work/tree-t1', model: 'gpt-5.6-sol',
    sandbox: 'workspace-write', lastMessageFile: '/tmp/last-exec.txt', prompt: 'implement T1',
  });
  assert.equal(r.bin, 'codex');
  assert.deepEqual(r.args, [
    'exec', '-s', 'workspace-write', '-C', '/work/tree-t1', '--skip-git-repo-check',
    '-m', 'gpt-5.6-sol', '-o', '/tmp/last-exec.txt', '--json', 'implement T1',
  ]);
});

test('buildArgv: codex search + execute throws', () => {
  assert.throws(() => D.buildArgv({
    adapter: 'codex', mode: 'execute', cwd: '/work/repo', search: true,
  }), /--search.*execute/);
});

// codex refuses to run outside a git/trusted dir without this flag; rstaff always
// passes an explicit -C <cwd> + a sandbox, which remain the real confinement.
test('buildArgv: codex advise + execute pass --skip-git-repo-check; review does NOT', () => {
  const advise = D.buildArgv({ adapter: 'codex', mode: 'advise', cwd: '/work/repo', sandbox: 'read-only', prompt: 'q' });
  const execute = D.buildArgv({ adapter: 'codex', mode: 'execute', cwd: '/work/repo', sandbox: 'workspace-write', prompt: 'go' });
  const review = D.buildArgv({ adapter: 'codex', mode: 'review', base: 'main', sandbox: 'read-only' });
  assert.ok(advise.args.includes('--skip-git-repo-check'), 'advise must skip the git-repo check');
  assert.ok(execute.args.includes('--skip-git-repo-check'), 'execute must skip the git-repo check');
  assert.ok(!review.args.includes('--skip-git-repo-check'), 'review is inherently git-based — must NOT skip');
});

test('buildArgv: gemini draft uses the verified read-only headless invocation', () => {
  const r = D.buildArgv({ adapter: 'gemini', mode: 'draft', model: 'gemini-3.8-flash', prompt: 'draft this' });
  assert.equal(r.bin, 'gemini');
  assert.deepEqual(r.args, [
    '-m', 'gemini-3.8-flash', '-p', 'draft this',
    '--approval-mode', 'plan', '--skip-trust', '-o', 'text',
  ]);
});

// P0 (whole-branch review): `--approval-mode plan` alone does NOT make exit_plan_mode
// structurally uncallable — the bundled plan.toml allows it non-interactively (see
// delegate.js's GEMINI_DRAFT_EXCLUDED_TOOLS comment, verified 2026-09-11). When a
// policyFile is supplied, buildArgv must wire it in with --policy so the caller's
// deny rules load.
test('buildArgv: gemini draft wires a supplied policyFile via --policy', () => {
  const r = D.buildArgv({
    adapter: 'gemini', mode: 'draft', model: 'gemini-3.8-flash', prompt: 'draft this',
    policyFile: '/scratch/rstaff-draft-policy.toml',
  });
  assert.deepEqual(r.args, [
    '-m', 'gemini-3.8-flash', '-p', 'draft this',
    '--approval-mode', 'plan', '--skip-trust',
    '--policy', '/scratch/rstaff-draft-policy.toml',
    '-o', 'text',
  ]);
});

test('GEMINI_DRAFT_EXCLUDED_TOOLS lists every tool that must stay structurally unreachable', () => {
  for (const tool of [
    'exit_plan_mode', 'enter_plan_mode', 'write_file', 'replace',
    'run_shell_command', 'invoke_agent', 'activate_skill', 'web_fetch',
  ]) {
    assert.ok(D.GEMINI_DRAFT_EXCLUDED_TOOLS.includes(tool), `${tool} must be excluded`);
  }
});

test('buildGeminiDraftPolicyToml: denies every excluded tool at user-tier priority (above plan.toml default tier)', () => {
  const toml = D.buildGeminiDraftPolicyToml();
  for (const tool of GEMINI_DRAFT_EXCLUDED_TOOLS) {
    assert.ok(toml.includes(`"${tool}"`), `policy toml must name ${tool}`);
  }
  assert.match(toml, /decision\s*=\s*"deny"/);
  assert.ok(toml.split('\n').includes('priority = 999'), 'policy priority must be the exact line "priority = 999"');
});

test('buildArgv: gemini offers draft only', () => {
  for (const mode of ['advise', 'review', 'execute']) {
    assert.throws(
      () => D.buildArgv({ adapter: 'gemini', mode }),
      new RegExp(`unknown mode "${mode}" for adapter "gemini"`),
    );
  }
});

test('buildArgv: unknown adapter throws a clear Error', () => {
  assert.throws(() => D.buildArgv({ adapter: 'oss', mode: 'advise' }), /unknown adapter/i);
});

test('buildArgv: unknown mode throws a clear Error', () => {
  assert.throws(() => D.buildArgv({ adapter: 'codex', mode: 'debate' }), /unknown mode/i);
});

// --- assertEffort ----------------------------------------------------------
// The effort string reaches the CLI as `-c model_reasoning_effort="<v>"`. An
// unknown level used to be forwarded verbatim and fail inside a dispatched worker
// at spawn time; buildArgv is the last pure place to catch it.
test('buildArgv refuses a reasoning effort the codex CLI does not know', () => {
  const base = { adapter: 'codex', mode: 'advise', cwd: '/work/repo', sandbox: 'read-only', prompt: 'q' };
  assert.throws(() => D.buildArgv({ ...base, reasoningEffort: 'maxx' }), /unknown codex reasoning effort "maxx"/);
  assert.throws(() => D.buildArgv({ ...base, mode: 'execute', reasoningEffort: 'MAX' }), /unknown codex reasoning effort/,
    'the CLI enum is lowercase — an uppercased level is still wrong');
  // Every level the CLI knows must pass, including ones rstaff's tier table does
  // not use: this is a CLI guard, not a policy allowlist.
  for (const effort of D.CODEX_EFFORTS) {
    assert.doesNotThrow(() => D.buildArgv({ ...base, reasoningEffort: effort }), `${effort} must be accepted`);
  }
  assert.doesNotThrow(() => D.buildArgv(base), 'an absent effort is legal — codex applies its own default');
});

test('assertEffort is exported for callers that resolve effort before building argv', () => {
  assert.throws(() => D.assertEffort('turbo'), /unknown codex reasoning effort "turbo"/);
  assert.doesNotThrow(() => D.assertEffort('max'));
  assert.doesNotThrow(() => D.assertEffort(null));
});

// --- assertSandbox / ADAPTERS registry shape -------------------------------
test('assertSandbox: danger-full-access throws without the override env', () => {
  const prev = process.env.RSTAFF_DELEGATE_ALLOW_DANGER;
  delete process.env.RSTAFF_DELEGATE_ALLOW_DANGER;
  try {
    assert.throws(() => D.assertSandbox('danger-full-access'), /RSTAFF_DELEGATE_ALLOW_DANGER/);
  } finally {
    if (prev === undefined) delete process.env.RSTAFF_DELEGATE_ALLOW_DANGER; else process.env.RSTAFF_DELEGATE_ALLOW_DANGER = prev;
  }
});

test('assertSandbox: danger-full-access passes with RSTAFF_DELEGATE_ALLOW_DANGER=1', () => {
  const prev = process.env.RSTAFF_DELEGATE_ALLOW_DANGER;
  process.env.RSTAFF_DELEGATE_ALLOW_DANGER = '1';
  try {
    assert.doesNotThrow(() => D.assertSandbox('danger-full-access'));
  } finally {
    if (prev === undefined) delete process.env.RSTAFF_DELEGATE_ALLOW_DANGER; else process.env.RSTAFF_DELEGATE_ALLOW_DANGER = prev;
  }
});

test('assertSandbox: read-only / workspace-write always pass', () => {
  assert.doesNotThrow(() => D.assertSandbox('read-only'));
  assert.doesNotThrow(() => D.assertSandbox('workspace-write'));
  assert.doesNotThrow(() => D.assertSandbox(undefined));
});

test('buildArgv: codex resume still refuses danger-full-access without the override', () => {
  withEnv({ RSTAFF_DELEGATE_ALLOW_DANGER: undefined }, () => {
    assert.throws(() => D.buildArgv({
      adapter: 'codex', mode: 'resume', threadId: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', sandbox: 'danger-full-access',
    }), /RSTAFF_DELEGATE_ALLOW_DANGER/);
  });
});

test('buildArgv never emits --dangerously-bypass-* even under danger-full-access + override', () => {
  const prev = process.env.RSTAFF_DELEGATE_ALLOW_DANGER;
  process.env.RSTAFF_DELEGATE_ALLOW_DANGER = '1';
  try {
    const r = D.buildArgv({ adapter: 'codex', mode: 'execute', cwd: '/w', sandbox: 'danger-full-access', prompt: 'x' });
    assert.ok(!r.args.some((a) => /dangerously-bypass/.test(a)));
  } finally {
    if (prev === undefined) delete process.env.RSTAFF_DELEGATE_ALLOW_DANGER; else process.env.RSTAFF_DELEGATE_ALLOW_DANGER = prev;
  }
});

test('ADAPTERS registry is shaped for extension: bin + modes.{advise,review,execute}', () => {
  for (const name of ['codex']) {
    const a = D.ADAPTERS[name];
    assert.equal(typeof a.bin, 'string');
    for (const mode of ['advise', 'review', 'execute']) assert.equal(typeof a.modes[mode], 'function');
  }
});

// --- resolveModel -----------------------------------------------------------
test('resolveModel: codex passthrough', () => {
  assert.equal(D.resolveModel('codex', 'gpt-5.6-sol'), 'gpt-5.6-sol');
});
test('resolveModel: codex absent -> null (omit -m, config.toml default applies)', () => {
  assert.equal(D.resolveModel('codex', undefined), null);
  assert.equal(D.resolveModel('codex', ''), null);
});

test('resolveModel: gemini defaults to the verified Vertex model and preserves aliases', () => {
  assert.equal(D.resolveModel('gemini', null), 'gemini-3.8-flash');
  assert.equal(D.resolveModel('gemini', ''), 'gemini-3.8-flash');
  assert.equal(D.resolveModel('gemini', 'gemini-custom'), 'gemini-custom');
});

// --- resolveTimeoutMs -------------------------------------------------------
test('resolveTimeoutMs: gemini draft defaults to 180 seconds', () => {
  assert.equal(D.resolveTimeoutMs({ adapter: 'gemini', mode: 'draft' }), 180000);
  assert.equal(D.GEMINI_DRAFT_TIMEOUT_MS, 180000);
});

test('resolveTimeoutMs: non-gemini drafts retain the 30 minute default', () => {
  assert.equal(D.resolveTimeoutMs({ adapter: 'codex', mode: 'advise' }), D.DEFAULT_TIMEOUT_MS);
  assert.equal(D.DEFAULT_TIMEOUT_MS, 30 * 60 * 1000);
});

test('resolveTimeoutMs: timeoutSec overrides the adapter default', () => {
  assert.equal(D.resolveTimeoutMs({ adapter: 'gemini', mode: 'draft', timeoutSec: 5 }), 5000);
});

test('resolveTimeoutMs: timeoutMs takes precedence over timeoutSec', () => {
  assert.equal(D.resolveTimeoutMs({ adapter: 'gemini', mode: 'draft', timeoutMs: 250, timeoutSec: 5 }), 250);
});

test('normalize: plain gemini stdout is the draft text', () => {
  const r = D.normalize({ adapter: 'gemini', mode: 'draft', stdout: 'A readable draft.\n', stderr: '[STARTUP] noise', exitCode: 0, timedOut: false });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'A readable draft.\n');
  assert.equal(r.stderrTail, '[STARTUP] noise');
  assert.equal(r.usage, null);
});

test('normalize: an empty gemini draft fails visibly', () => {
  const r = D.normalize({ adapter: 'gemini', mode: 'draft', stdout: '', stderr: 'no response', exitCode: 0, timedOut: false });
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.equal(r.stderrTail, 'no response');
});

test('parseCliArgs: --brief aliases the existing --prompt-file option', () => {
  assert.deepEqual(
    D.parseCliArgs(['gemini', 'draft', '--brief', '/tmp/brief.md', '--model', 'gemini-custom']),
    { adapter: 'gemini', mode: 'draft', promptFile: '/tmp/brief.md', model: 'gemini-custom' },
  );
});
test('parseCliArgs: gemini draft preserves --timeout as seconds', () => {
  assert.deepEqual(
    D.parseCliArgs(['gemini', 'draft', '--timeout', '5']),
    { adapter: 'gemini', mode: 'draft', timeoutSec: 5 },
  );
});
test('parseCliArgs: -o maps to outFile', () => {
  assert.deepEqual(
    D.parseCliArgs(['gemini', 'draft', '-o', '/tmp/x.md']),
    { adapter: 'gemini', mode: 'draft', outFile: '/tmp/x.md' },
  );
});
test('parseCliArgs: --out maps to outFile', () => {
  assert.deepEqual(
    D.parseCliArgs(['gemini', 'draft', '--out', '/tmp/x.md']),
    { adapter: 'gemini', mode: 'draft', outFile: '/tmp/x.md' },
  );
});

test('parseCliArgs: codex resume accepts boolean --search and --thread-id', () => {
  assert.deepEqual(
    D.parseCliArgs(['codex', 'resume', '--search', '--thread-id', '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', '--prompt', 'follow up']),
    { adapter: 'codex', mode: 'resume', search: true, threadId: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', prompt: 'follow up' },
  );
});

test('normalize: codex plain last-message text -> ok/text', () => {
  const r = D.normalize({ adapter: 'codex', mode: 'advise', stdout: '', lastMessageText: 'Looks fine, ship it.', exitCode: 0, timedOut: false });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Looks fine, ship it.');
  assert.equal(r.structured, null);
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0);
});

test('normalize: codex JSON schema output -> structured parsed', () => {
  const payload = JSON.stringify({ verdict: 'agree', notes: 'nothing blocking' });
  const r = D.normalize({ adapter: 'codex', mode: 'advise', stdout: '', lastMessageText: payload, exitCode: 0, timedOut: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.structured, { verdict: 'agree', notes: 'nothing blocking' });
});

test('normalize: codex JSONL extracts thread id, final text, and token usage', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1200, cached_input_tokens: 900, cache_write_input_tokens: 50, output_tokens: 80, reasoning_output_tokens: 20 },
    }),
  ].join('\n');
  const r = D.normalize({ adapter: 'codex', mode: 'execute', stdout, lastMessageText: '', exitCode: 0, timedOut: false });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'done');
  assert.equal(r.sessionId, '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67');
  assert.deepEqual(r.usage, {
    inputTokens: 1200,
    cachedInputTokens: 900,
    cacheWriteInputTokens: 50,
    outputTokens: 80,
    reasoningOutputTokens: 20,
    totalTokens: 1280,
  });
});

test('normalizeUsage: all-zero payload is unmeasured', () => {
  assert.equal(D.normalizeUsage({
    input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0,
  }), null);
});

test('parseCodexJSONL: accumulates completed turns', () => {
  const parsed = D.parseCodexJSONL([
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, cache_write_input_tokens: 4, output_tokens: 3 } }),
  ].join('\n'));
  assert.deepEqual(parsed.usage, {
    inputTokens: 30, cachedInputTokens: 0, cacheWriteInputTokens: 4,
    outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 35,
  });
});

test('normalize: timedOut -> ok:false, timedOut:true', () => {
  const r = D.normalize({ adapter: 'codex', mode: 'advise', stdout: '', exitCode: null, timedOut: true });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.text, '');
});

test('normalize: exitCode !== 0 -> ok:false', () => {
  const r = D.normalize({ adapter: 'codex', mode: 'execute', stdout: 'partial output before crash', lastMessageText: '', exitCode: 1, timedOut: false, stderr: 'boom' });
  assert.equal(r.ok, false);
  assert.equal(r.text, 'partial output before crash');
  assert.equal(r.exitCode, 1);
  assert.match(r.stderrTail, /boom/);
});

test('normalize: parsed Codex failure never dumps raw JSONL', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: '019fail' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(5000) } }),
  ].join('\n');
  const r = D.normalize({ adapter: 'codex', mode: 'advise', stdout, exitCode: 1, timedOut: false, stderr: 'denied' });
  assert.equal(r.text, '');
  assert.equal(r.sessionId, '019fail');
  assert.match(r.stderrTail, /denied/);
});

test('normalize: always returns the same stable shape', () => {
  const r = D.normalize({ adapter: 'codex', mode: 'advise', stdout: '', lastMessageText: 'x', exitCode: 0, timedOut: false });
  assert.deepEqual(Object.keys(r).sort(), ['exitCode', 'ok', 'sessionId', 'stderrTail', 'structured', 'text', 'timedOut', 'usage'].sort());
});

test('appendUsageLog: records measured and unmeasured runs safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-usage-test-'));
  const file = path.join(dir, 'var', 'usage.jsonl');
  try {
    assert.equal(D.appendUsageLog(file, { id: 'unmeasured', adapter: 'codex', measured: false }), true);
    assert.equal(D.appendUsageLog(file, {
      timestamp: '2026-07-28T00:00:00.000Z',
      adapter: 'codex',
      mode: 'execute',
      model: 'gpt-test',
      label: 'repo/feature/T1/implement',
      sessionId: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67',
      measured: true,
      usage: { inputTokens: 10, cachedInputTokens: 8, cacheWriteInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 12 },
    }), true);
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records[0].measured, false);
    assert.equal(records[0].usage, null);
    const record = records[1];
    assert.equal(record.label, 'repo/feature/T1/implement');
    assert.equal(record.usage.totalTokens, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- binExists / isAvailable --------------------------------------------------
test('binExists: node is on PATH', () => {
  assert.equal(D.binExists('node'), true);
});
test('binExists: a made-up binary is not on PATH', () => {
  assert.equal(D.binExists('definitely-not-real-bin-xyzzy'), false);
});
test('binExists: shell-injection vector is closed (bin is a positional arg, not interpolated)', () => {
  const marker = path.join(os.tmpdir(), `rstaff-delegate-test-marker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const result = D.binExists('nope; touch ' + marker);
    assert.equal(result, false);
    assert.equal(fs.existsSync(marker), false, 'injected `touch` must not have run');
  } finally {
    try { fs.unlinkSync(marker); } catch (_) {}
  }
});
test('isAvailable: gemini reflects whether its registered binary is on PATH', () => {
  const env = { ...process.env, RSTAFF_GEMINI_PROJECT: 'test-project' };
  assert.equal(D.isAvailable('gemini', env), D.binExists('gemini', env));
});
test('isAvailable: false for an unknown adapter (no crash)', () => {
  assert.equal(D.isAvailable('oss'), false);
});
test('isAvailable: false for gemini when its binary is absent from PATH', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-empty-path-'));
  try {
    const before = process.env.PATH;
    process.env.PATH = emptyDir;
    try { assert.equal(D.isAvailable('gemini'), false); }
    finally { process.env.PATH = before; }
  } finally { fs.rmSync(emptyDir, { recursive: true, force: true }); }
});

// --- spawnWithTimeout: the anti-hang mechanism --------------------------------
test('spawnWithTimeout: a child that outlives the timeout is killed, not hung', () => {
  const r = D.spawnWithTimeout({
    bin: process.execPath,
    args: ['-e', 'setTimeout(()=>{},1000)'],
    timeoutMs: 150,
  });
  assert.equal(r.timedOut, true);
});
test('spawnWithTimeout: a fast child returns normally, not timed out', () => {
  const r = D.spawnWithTimeout({
    bin: process.execPath,
    args: ['-e', 'process.stdout.write("hi")'],
    timeoutMs: 5000,
  });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'hi');
});

// --- The dedicated CLI home isolates the model cache -------------------------
// Two codex binaries sharing one CODEX_HOME race over models_cache.json, and codex
// discards any cache whose `client_version` does not exactly match the running binary. Thus
// the catalog rstaff's oracles read was never the catalog the CLI it spawns loads.
// Fix: rstaff's codex runs get their own home, seeded with symlinks to the
// operator's real config/auth so behaviour is otherwise identical.
const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};
const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-${tag}-`));
// A stand-in for the operator's own ~/.codex: the inputs codex reads, plus the
// cache file that is the whole reason the homes have to be separate.
function fakeSourceHome(files = ['config.toml', 'auth.json', 'AGENTS.md', 'models_cache.json']) {
  const src = tmpdir('codex-src');
  for (const f of files) fs.writeFileSync(path.join(src, f), `${f} contents`);
  return src;
}
// An auth.json in the shape codex writes: the token plus the `last_refresh` stamp
// it records beside it. fakeSourceHome's `auth.json contents` is deliberately NOT
// JSON — only a test that opts into the credential shape gets credential semantics.
const writeAuth = (dir, lastRefresh, token) => fs.writeFileSync(
  path.join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: token }, last_refresh: lastRefresh }));
const authToken = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).tokens.access_token;

test('codexHome: RSTAFF_CODEX_HOME wins over every default', () => {
  const home = withEnv({ RSTAFF_CODEX_HOME: '/tmp/pinned-codex-home' }, () => D.codexHome());
  assert.equal(home, '/tmp/pinned-codex-home');
});

test('codexHome: defaults to var/codex-home inside the control repo, not the shared ~/.codex', () => {
  const ctrl = tmpdir('ctrl');
  fs.writeFileSync(path.join(ctrl, 'rstaff.json'), '{}');
  const home = withEnv({ RSTAFF_CODEX_HOME: undefined, RSTAFF_HOME: ctrl }, () => D.codexHome());
  assert.equal(home, path.join(ctrl, 'var', 'codex-home'));
  assert.notEqual(home, path.join(os.homedir(), '.codex'));
});

test('ensureCodexHome: symlinks the operator-authored inputs into the dedicated home', () => {
  const src = fakeSourceHome();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  for (const f of ['config.toml', 'auth.json', 'AGENTS.md']) {
    const dest = path.join(home, f);
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), true, `${f} should be a symlink`);
    assert.equal(fs.readlinkSync(dest), path.join(src, f));
  }
});

test('ensureCodexHome: does NOT seed models_cache.json — the private cache is the point', () => {
  const src = fakeSourceHome();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  assert.equal(fs.existsSync(path.join(home, 'models_cache.json')), false);
});

test('ensureCodexHome: skips an input the source home does not have', () => {
  const src = fakeSourceHome(['config.toml', 'auth.json']);
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  assert.equal(fs.existsSync(path.join(home, 'AGENTS.md')), false);
  assert.equal(fs.lstatSync(path.join(home, 'auth.json')).isSymbolicLink(), true);
});

test('ensureCodexHome: is idempotent — a second call leaves the links in place', () => {
  const src = fakeSourceHome();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  D.ensureCodexHome(home, src);
  assert.equal(fs.readlinkSync(path.join(home, 'auth.json')), path.join(src, 'auth.json'));
});

test('ensureCodexHome: propagates a diverged auth.json back to the source when it is NEWER', () => {
  // codex rewrites auth.json on token refresh via temp+rename — measured off the
  // native binary: create-temp -> write -> fsync -> rename — and rename() over a
  // symlink path REPLACES the symlink with a real file, leaving the source's copy
  // untouched. Re-linking blindly then discards the fresh token; and because the
  // refresh token that minted it is single-use, the source's older copy can no
  // longer be refreshed either. Both homes end up on a credential that cannot
  // recover, so the newer side has to win and be copied back.
  const src = fakeSourceHome();
  writeAuth(src, '2026-09-01T00:00:00Z', 'old');
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  fs.unlinkSync(path.join(home, 'auth.json'));
  writeAuth(home, '2026-09-08T00:00:00Z', 'fresh');
  D.ensureCodexHome(home, src);
  assert.equal(authToken(path.join(src, 'auth.json')), 'fresh',
    'the newer credential must reach the source home, not be discarded');
  const dest = path.join(home, 'auth.json');
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), true, 'and the home is re-linked afterwards');
  assert.equal(fs.readlinkSync(dest), path.join(src, 'auth.json'));
});

test('ensureCodexHome: discards a diverged auth.json that is OLDER than the source', () => {
  // The propagation is directional. A home left behind by an old run must never
  // push its stale token over the operator's fresher one — that is the same
  // credential loss as the discard bug, aimed the other way.
  const src = fakeSourceHome();
  writeAuth(src, '2026-09-08T00:00:00Z', 'fresh');
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  fs.unlinkSync(path.join(home, 'auth.json'));
  writeAuth(home, '2026-09-01T00:00:00Z', 'old');
  D.ensureCodexHome(home, src);
  assert.equal(authToken(path.join(src, 'auth.json')), 'fresh', 'the source must keep its newer credential');
  assert.equal(fs.readlinkSync(path.join(home, 'auth.json')), path.join(src, 'auth.json'));
});

test('ensureCodexHome: discards a diverged auth.json it cannot date, rather than guess', () => {
  // No parseable `last_refresh` on either side means no evidence of which is newer.
  // Writing into the operator's home on a guess is the one thing this must not do,
  // so the unprovable case falls back to the old behaviour: re-link, touch nothing.
  const src = fakeSourceHome();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  fs.unlinkSync(path.join(home, 'auth.json'));
  fs.writeFileSync(path.join(home, 'auth.json'), 'not json at all');
  D.ensureCodexHome(home, src);
  assert.equal(fs.readFileSync(path.join(src, 'auth.json'), 'utf8'), 'auth.json contents',
    'an undateable divergence must not reach the source home');
  assert.equal(fs.lstatSync(path.join(home, 'auth.json')).isSymbolicLink(), true);
});

test('ensureCodexHome: re-links a diverged config.toml without writing into the source home', () => {
  // Decision A relaxed "never writes into the source home" to "never, except to
  // propagate a newer credential". It still holds unconditionally for every
  // non-credential seed: config.toml and AGENTS.md are operator-AUTHORED, codex
  // never rewrites them, and a copy in the dedicated home is always the stale side.
  const src = fakeSourceHome();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  // Both sides are given a readable `last_refresh` — real config.toml is TOML and
  // carries none, but a fixture that cannot be dated would pass for the wrong
  // reason. Dated this way, the ONLY thing standing between the newer copy and the
  // operator's file is the auth.json name guard, which is what this pins.
  fs.writeFileSync(path.join(src, 'config.toml'), JSON.stringify({ last_refresh: '2026-09-01T00:00:00Z', model: 'operator' }));
  fs.unlinkSync(path.join(home, 'config.toml'));
  fs.writeFileSync(path.join(home, 'config.toml'), JSON.stringify({ last_refresh: '2026-09-08T00:00:00Z', model: 'usurper' }));
  D.ensureCodexHome(home, src);
  assert.match(fs.readFileSync(path.join(src, 'config.toml'), 'utf8'), /operator/,
    'a diverged config.toml must never overwrite the operator\'s own');
  assert.equal(fs.readlinkSync(path.join(home, 'config.toml')), path.join(src, 'config.toml'));
});

test('ensureCodexHome: writes nothing into the source home on an ordinary seed', () => {
  const src = fakeSourceHome();
  const before = fs.readdirSync(src).sort();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  D.ensureCodexHome(home, src);
  assert.deepEqual(fs.readdirSync(src).sort(), before);
  assert.equal(fs.readFileSync(path.join(src, 'auth.json'), 'utf8'), 'auth.json contents');
});

test('ensureCodexHome: refuses to seed a populated directory it does not own', () => {
  // RSTAFF_CODEX_HOME points the seeder at an arbitrary path, and seeding REMOVES
  // whatever sits on a seed name. Aimed at a directory the operator keeps their own
  // config in, that is silent data loss — so a home rstaff did not create and did
  // not mark is not rstaff's to write in.
  const src = fakeSourceHome();
  const victim = tmpdir('victim');
  fs.writeFileSync(path.join(victim, 'config.toml'), 'the operator\'s own config');
  fs.writeFileSync(path.join(victim, 'auth.json'), 'the operator\'s own credential');
  assert.throws(() => D.ensureCodexHome(victim, src), (e) => e.message.includes(victim),
    'the refusal must name the path, or the operator cannot act on it');
  assert.equal(fs.readFileSync(path.join(victim, 'config.toml'), 'utf8'), 'the operator\'s own config');
  assert.equal(fs.readFileSync(path.join(victim, 'auth.json'), 'utf8'), 'the operator\'s own credential');
});

test('ensureCodexHome: marks the home it creates, and adopts one holding only its own links', () => {
  const src = fakeSourceHome();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  assert.equal(fs.existsSync(path.join(home, '.rstaff-codex-home')), true,
    'a home rstaff created must carry the marker that lets the next run write in it');
  // An upgrade meets a home seeded before the marker existed: only rstaff's own
  // links are in it, so there is nothing to destroy and it is adopted, not refused.
  fs.unlinkSync(path.join(home, '.rstaff-codex-home'));
  D.ensureCodexHome(home, src);
  assert.equal(fs.existsSync(path.join(home, '.rstaff-codex-home')), true);
  assert.equal(fs.readlinkSync(path.join(home, 'auth.json')), path.join(src, 'auth.json'));
});

test('ensureCodexHome: treats a home that RESOLVES to the source as the opt-out', () => {
  // The guard decides identity, and a string compare is not identity: /tmp and
  // /private/tmp are one directory on macOS, and a symlinked home compares unequal
  // while resolving into the very files the seeder would remove — then re-link at
  // themselves, leaving the operator's home a ring of dangling links.
  const src = fakeSourceHome();
  const alias = path.join(tmpdir('alias'), 'codex-alias');
  fs.symlinkSync(src, alias);
  assert.equal(D.ensureCodexHome(alias, src), alias);
  assert.equal(fs.lstatSync(path.join(src, 'auth.json')).isSymbolicLink(), false,
    'the source\'s real files must survive a home that only spells its path differently');
  assert.equal(fs.readFileSync(path.join(src, 'auth.json'), 'utf8'), 'auth.json contents');
});

test('ensureCodexHome: replaces a seed name that diverged into a directory', () => {
  // `rmSync(dest, {force: true})` without `recursive` cannot remove a directory. The
  // error was swallowed, dest survived, and symlinkSync then threw EEXIST straight
  // out of run() — a dispatched worker dead at spawn, with a message about a symlink
  // that says nothing about the directory sitting in the way.
  const src = fakeSourceHome();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  D.ensureCodexHome(home, src);
  fs.unlinkSync(path.join(home, 'AGENTS.md'));
  fs.mkdirSync(path.join(home, 'AGENTS.md'));
  fs.writeFileSync(path.join(home, 'AGENTS.md', 'stray'), 'left by something else');
  D.ensureCodexHome(home, src);
  assert.equal(fs.lstatSync(path.join(home, 'AGENTS.md')).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(home, 'AGENTS.md')), path.join(src, 'AGENTS.md'));
});

test('linkSeed: accepts EEXIST when the link that landed is the one it was making', () => {
  // /dispatch runs up to three feature-runners at once, all seeding one home. Each
  // removes the seed name and re-links it, so a peer can land its symlink between
  // our rmSync and our symlinkSync. The outcome is already the one we wanted, so
  // losing that race is not an error — it must not throw out of run().
  const src = fakeSourceHome();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const dest = path.join(home, 'auth.json');
  fs.symlinkSync(path.join(src, 'auth.json'), dest);   // the peer got there first
  D.linkSeed(path.join(src, 'auth.json'), dest);
  assert.equal(fs.readlinkSync(dest), path.join(src, 'auth.json'));
});

test('linkSeed: rethrows EEXIST when what landed is NOT the link it was making', () => {
  // Tolerating EEXIST blindly would turn a genuine collision — a link into some
  // other home, a file another tool owns — into a silent no-op, and the run would
  // proceed against the wrong credential.
  const src = fakeSourceHome();
  const home = path.join(tmpdir('codex-home'), 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const dest = path.join(home, 'auth.json');
  fs.symlinkSync('/somewhere/else/auth.json', dest);
  assert.throws(() => D.linkSeed(path.join(src, 'auth.json'), dest), { code: 'EEXIST' });
});

test('ensureCodexHome: no-op when the dedicated home IS the source home (the opt-out)', () => {
  const src = fakeSourceHome();
  const before = fs.readdirSync(src).sort();
  assert.equal(D.ensureCodexHome(src, src), src);
  assert.deepEqual(fs.readdirSync(src).sort(), before);
  assert.equal(fs.lstatSync(path.join(src, 'auth.json')).isSymbolicLink(), false);
});

test('buildEnv: codex is spawned with CODEX_HOME pointing at the dedicated home', () => {
  const env = D.buildEnv({ adapter: 'codex', env: { PATH: '/bin', CODEX_HOME: '/home/op/.codex' }, codexHome: '/ctrl/var/codex-home' });
  assert.equal(env.CODEX_HOME, '/ctrl/var/codex-home');
  assert.equal(env.PATH, '/bin');
});

test('buildEnv: gemini uses the configured Vertex project, preserves ADC config, and strips API keys', () => {
  const base = {
    PATH: '/bin', CODEX_HOME: '/home/op/.codex', CLOUDSDK_CONFIG: '/operator/gcloud',
    RSTAFF_GEMINI_PROJECT: 'configured-project', GOOGLE_CLOUD_PROJECT: 'inherited-project',
    GEMINI_API_KEY: 'secret-1', GOOGLE_API_KEY: 'secret-2',
  };
  const env = D.buildEnv({ adapter: 'gemini', env: base, codexHome: '/ctrl/var/codex-home' });
  assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, 'true');
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'configured-project');
  assert.equal(env.GOOGLE_CLOUD_LOCATION, 'global');
  assert.equal(env.CLOUDSDK_CONFIG, '/operator/gcloud');
  assert.equal('GEMINI_API_KEY' in env, false);
  assert.equal('GOOGLE_API_KEY' in env, false);
  assert.equal(base.GEMINI_API_KEY, 'secret-1', 'the pure builder must not mutate its input');
});

test('buildEnv: RSTAFF_GEMINI_PROJECT overrides an inherited project and location', () => {
  const env = D.buildEnv({
    adapter: 'gemini',
    env: {
      GOOGLE_CLOUD_PROJECT: 'inherited-project', RSTAFF_GEMINI_PROJECT: 'another-project',
      RSTAFF_GEMINI_LOCATION: 'us-central1',
    },
  });
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'another-project');
  assert.equal(env.GOOGLE_CLOUD_LOCATION, 'us-central1');
});

test('buildEnv: inherited GOOGLE_CLOUD_PROJECT is used when no rstaff project is set', () => {
  const env = D.buildEnv({ adapter: 'gemini', env: { GOOGLE_CLOUD_PROJECT: 'inherited-project' } });
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'inherited-project');
});

test('isAvailable: inherited GOOGLE_CLOUD_PROJECT makes the Gemini adapter available', () => {
  const dir = tmpdir('gemini-inherited-project');
  fs.writeFileSync(path.join(dir, 'gemini'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, 'gemini'), 0o755);
  const env = {
    PATH: `${dir}${path.delimiter}${process.env.PATH || ''}`,
    GOOGLE_CLOUD_PROJECT: 'inherited-project',
  };
  assert.equal(D.isAvailable('gemini', env), true);
});

test('gemini is unavailable without a project and fails before invoking the CLI', () => {
  const dir = tmpdir('gemini-no-project');
  const invoked = path.join(dir, 'invoked');
  fs.writeFileSync(path.join(dir, 'gemini'), `#!/bin/sh\ntouch "${invoked}"\n`);
  fs.chmodSync(path.join(dir, 'gemini'), 0o755);
  assert.equal(D.isAvailable('gemini', { PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` }), false);
  assert.throws(
    () => D.buildEnv({ adapter: 'gemini', env: { PATH: dir } }),
    /gemini unavailable — FIX: set RSTAFF_GEMINI_PROJECT \(or export GOOGLE_CLOUD_PROJECT\)/,
  );
  assert.throws(
    () => D.run({ adapter: 'gemini', mode: 'draft', cwd: dir, env: { PATH: dir } }),
    /gemini unavailable — FIX: set RSTAFF_GEMINI_PROJECT \(or export GOOGLE_CLOUD_PROJECT\)/,
  );
  assert.equal(fs.existsSync(invoked), false);
});

test('run: gemini receives the brief as -p, Vertex env, and normalizes plain stdout', () => {
  const dir = tmpdir('gemini-run');
  const brief = path.join(dir, 'brief.md');
  const seen = path.join(dir, 'seen.txt');
  const seenCwd = path.join(dir, 'seen-cwd.txt');
  const seenPolicy = path.join(dir, 'seen.policy');
  fs.writeFileSync(brief, 'facts for the draft');
  fs.writeFileSync(path.join(dir, 'gemini'), [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${seen}"`,
    `printf '%s\\n' "$GOOGLE_GENAI_USE_VERTEXAI|$GOOGLE_CLOUD_PROJECT|$GOOGLE_CLOUD_LOCATION|$CLOUDSDK_CONFIG|${'$'}{GEMINI_API_KEY-unset}|${'$'}{GOOGLE_API_KEY-unset}" >> "${seen}"`,
    `printf '%s\\n' "$PWD" > "${seenCwd}"`,
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--policy" ]; then policy="$2"; break; fi',
    '  shift',
    'done',
    `/bin/cp "$policy" "${seenPolicy}"`,
    "printf 'Finished draft.\\n'",
  ].join('\n'));
  fs.chmodSync(path.join(dir, 'gemini'), 0o755);
  const r = D.run({
    adapter: 'gemini', mode: 'draft', promptFile: brief, cwd: dir,
    env: {
      PATH: dir, RSTAFF_GEMINI_PROJECT: 'project-from-test', CLOUDSDK_CONFIG: '/operator/gcloud',
      GEMINI_API_KEY: 'x', GOOGLE_API_KEY: 'y',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Finished draft.\n');
  assert.equal(r.timeoutMs, D.GEMINI_DRAFT_TIMEOUT_MS);
  const seenArgs = fs.readFileSync(seen, 'utf8').trim().split('\n');
  assert.deepEqual(seenArgs.slice(0, 7), [
    '-m', 'gemini-3.8-flash', '-p', 'facts for the draft',
    '--approval-mode', 'plan', '--skip-trust',
  ]);
  assert.equal(seenArgs[7], '--policy');
  const policyFile = seenArgs[8];
  assert.deepEqual(seenArgs.slice(9, 11), ['-o', 'text']);
  // The last "seen" line is the env-probe printf, appended by the fake CLI's second line.
  assert.equal(seenArgs[seenArgs.length - 1], 'true|project-from-test|global|/operator/gcloud|unset|unset');

  // P0: exit_plan_mode etc. must be structurally unreachable via a caller-owned
  // policy file, and the draft must run in a scratch cwd — never the caller's cwd
  // (which is where a product repo's .gemini/settings.json / GEMINI.md would live).
  const cwdSeen = fs.readFileSync(seenCwd, 'utf8').trim();
  assert.notEqual(cwdSeen, dir, 'gemini draft must not spawn with cwd = the caller-supplied cwd');
  assert.notEqual(cwdSeen, process.cwd(), 'gemini draft must not spawn with cwd = process.cwd()');
  assert.ok(!fs.existsSync(cwdSeen), 'the scratch cwd must be cleaned up after the run');
  // Compare through os.tmpdir()'s own realpath, since shells (e.g. macOS's sh)
  // resolve $PWD through symlinks (/var -> /private/var) that Node's raw
  // mkdtempSync() path does not — a platform quirk, not a real divergence.
  const resolvedPolicyDir = path.join(
    fs.realpathSync(os.tmpdir()), path.relative(os.tmpdir(), path.dirname(policyFile)),
  );
  assert.equal(resolvedPolicyDir, cwdSeen, 'the policy file must live in the scratch cwd, not the product repo');
  const policy = fs.readFileSync(seenPolicy, 'utf8');
  assert.match(policy, /^decision = "deny"$/m);
  assert.match(policy, /^priority = 999$/m);
  for (const tool of GEMINI_DRAFT_EXCLUDED_TOOLS) {
    assert.ok(policy.includes(`"${tool}"`), `spawned policy must name ${tool}`);
  }
});

test('run: gemini draft removes its scratch dir when the sandbox guard throws', () => {
  const dir = tmpdir('gemini-danger');
  fs.writeFileSync(path.join(dir, 'gemini'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, 'gemini'), 0o755);
  const scratchDirs = () => fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('rstaff-gemini-draft-')).sort();
  const before = scratchDirs();

  withEnv({ RSTAFF_DELEGATE_ALLOW_DANGER: undefined }, () => {
    assert.throws(() => D.run({
      adapter: 'gemini', mode: 'draft', sandbox: 'danger-full-access', prompt: 'draft this',
      cwd: dir, timeoutMs: 10000, env: { PATH: dir },
    }), /RSTAFF_DELEGATE_ALLOW_DANGER/);
  });

  assert.deepEqual(scratchDirs(), before, 'failed gemini draft must not leak its scratch directory');
});

test('run: gemini draft removes its CLI chat log without removing unrelated projects', () => {
  const dir = tmpdir('gemini-home-cleanup');
  const home = path.join(dir, 'home');
  const unrelated = path.join(home, '.gemini', 'tmp', 'other-project', 'keep.txt');
  fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(unrelated, 'keep');
  fs.writeFileSync(path.join(dir, 'gemini'), [
    '#!/bin/sh',
    'project_dir="$HOME/.gemini/tmp/$(basename "$PWD")"',
    'mkdir -p "$project_dir/chats"',
    'printf "%s\\n" "brief residue" > "$project_dir/chats/s.jsonl"',
    "printf 'Finished draft.\\n'",
  ].join('\n'));
  fs.chmodSync(path.join(dir, 'gemini'), 0o755);

  withEnv({ HOME: home }, () => {
    const r = D.run({
      adapter: 'gemini', mode: 'draft', prompt: 'facts for the draft', cwd: dir,
      env: {
        ...process.env, PATH: `${dir}${path.delimiter}/bin${path.delimiter}/usr/bin`,
        RSTAFF_GEMINI_PROJECT: 'project-from-test',
      },
    });
    assert.equal(r.ok, true);
  });

  const geminiTmp = path.join(home, '.gemini', 'tmp');
  assert.deepEqual(
    fs.readdirSync(geminiTmp).filter((name) => name.startsWith('rstaff-gemini-draft-')),
    [],
    'run() must remove the CLI project directory named after its scratch cwd',
  );
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
});

test('CLI: gemini draft writes -o text while stdout remains the JSON envelope', () => {
  const dir = tmpdir('gemini-cli-out');
  const bin = path.join(dir, 'bin');
  const brief = path.join(dir, 'brief.md');
  const outFile = path.join(dir, 'nested', 'draft.md');
  const failedOutFile = path.join(dir, 'empty-output', 'draft.md');
  const usageLog = path.join(dir, 'usage.jsonl');
  const gemini = path.join(bin, 'gemini');
  const delegate = path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'delegate.js');
  fs.mkdirSync(bin);
  fs.writeFileSync(brief, 'facts for the CLI draft');

  try {
    fs.writeFileSync(gemini, ['#!/bin/sh', "printf '%s\\n' 'draft text from fake gemini'", ''].join('\n'));
    fs.chmodSync(gemini, 0o755);
    const success = spawnSync(process.execPath, [
      delegate, 'gemini', 'draft', '--brief', brief, '-o', outFile, '--usage-log', usageLog,
    ], { encoding: 'utf8', env: { ...process.env, PATH: bin, RSTAFF_GEMINI_PROJECT: 'project-from-test' } });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(fs.readFileSync(outFile, 'utf8'), 'draft text from fake gemini\n');
    const successEnvelope = JSON.parse(success.stdout);
    assert.equal(successEnvelope.ok, true);
    assert.equal(successEnvelope.text, 'draft text from fake gemini\n');
    assert.equal(successEnvelope.structured, null);
    assert.equal(successEnvelope.timedOut, false);
    assert.equal(successEnvelope.exitCode, 0);
    assert.equal(successEnvelope.stderrTail, '');
    assert.equal(successEnvelope.sessionId, null);
    assert.equal(successEnvelope.usage, null);

    fs.writeFileSync(gemini, ['#!/bin/sh', 'exit 0', ''].join('\n'));
    const failure = spawnSync(process.execPath, [
      delegate, 'gemini', 'draft', '--brief', brief, '--out', failedOutFile, '--usage-log', usageLog,
    ], { encoding: 'utf8', env: { ...process.env, PATH: bin, RSTAFF_GEMINI_PROJECT: 'project-from-test' } });
    assert.equal(failure.status, 1, failure.stderr);
    const failureEnvelope = JSON.parse(failure.stdout);
    assert.equal(failureEnvelope.ok, false);
    assert.equal(fs.existsSync(failedOutFile), false, 'ok:false must not create the output file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: codex resume forwards search/threadId, uses spawn cwd, and preserves sessionId', () => {
  const dir = tmpdir('codex-resume');
  const home = path.join(dir, 'codex-home');
  const cwd = path.join(dir, 'work');
  const seen = path.join(dir, 'seen.json');
  const delegate = path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'delegate.js');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(dir, 'codex'), [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67' }));",
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'continued' } }));",
  ].join('\n'));
  fs.chmodSync(path.join(dir, 'codex'), 0o755);

  try {
    const result = spawnSync(process.execPath, [
      delegate, 'codex', 'resume', '--search', '--thread-id', '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', '--cwd', cwd,
      '--sandbox', 'workspace-write', '--prompt', 'follow up', '--usage-log', path.join(dir, 'usage.jsonl'),
    ], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: dir, CODEX_HOME: home, RSTAFF_CODEX_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.text, 'continued');
    assert.equal(envelope.sessionId, '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67');
    const observed = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.equal(observed.cwd, fs.realpathSync(cwd));
    assert.deepEqual(observed.args.slice(0, 7), [
      '--search', 'exec', 'resume', '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"',
    ]);
    assert.deepEqual(observed.args.slice(-2), ['--json', 'follow up']);
    assert.ok(!observed.args.includes('-s'));
    assert.ok(!observed.args.includes('-C'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: the spawned codex actually receives CODEX_HOME (end-to-end, fake CLI on PATH)', () => {
  const src = fakeSourceHome();
  const ctrl = tmpdir('ctrl');
  fs.writeFileSync(path.join(ctrl, 'rstaff.json'), '{}');
  const bin = tmpdir('bin');
  const seen = path.join(bin, 'seen.txt');
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nprintf '%s' "$CODEX_HOME" > ${seen}\n`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);

  withEnv({ RSTAFF_CODEX_HOME: undefined, RSTAFF_HOME: ctrl, CODEX_HOME: src }, () => {
    D.run({
      adapter: 'codex', mode: 'advise', cwd: os.tmpdir(), prompt: 'ping',
      env: { ...process.env, PATH: bin }, timeoutMs: 10000,
    });
  });
  assert.equal(fs.readFileSync(seen, 'utf8'), path.join(ctrl, 'var', 'codex-home'));
});

// --- rollout telemetry (separate from codex exec stdout) ---------------------
const rolloutFixture = fs.readFileSync(path.join(__dirname, '../fixtures', 'codex-rollout-two-calls.jsonl'), 'utf8');
const rolloutEvents = () => rolloutFixture.trim().split('\n').map((line) => JSON.parse(line));
const rolloutText = (events) => events.map((event) => JSON.stringify(event)).join('\n');
const emptyRollout = { quota: null, modelCalls: null, peakContext: null, contextWindow: null, effort: null };

test('parseCodexRollout: two calls capture first and last quota and context', () => {
  assert.deepEqual(D.parseCodexRollout(rolloutFixture), {
    quota: {
      primary: { start: 9, end: 10, windowMinutes: 300, resetsAt: 1790883618, reset: false },
      secondary: { start: 80, end: 81, windowMinutes: 10080, resetsAt: 1791039494, reset: false },
    },
    modelCalls: 2, peakContext: 19814, contextWindow: 258400, effort: 'medium',
  });
});

test('parseCodexRollout: removing second call leaves end equal to start', () => {
  const parsed = D.parseCodexRollout(rolloutText(rolloutEvents().slice(0, 2)));
  assert.equal(parsed.modelCalls, 1);
  assert.equal(parsed.quota.primary.start, 9);
  assert.equal(parsed.quota.primary.end, 9);
  assert.equal(parsed.quota.secondary.end, 80);
  assert.equal(parsed.peakContext, 14997);
});

test('parseCodexRollout: since includes boundary and excludes older or undated events', () => {
  const events = rolloutEvents();
  events.push({ ...events[1], timestamp: 'invalid' }, { ...events[1], timestamp: undefined },
    { ...events[1], timestamp: { toString: null, valueOf: null } });
  const parsed = D.parseCodexRollout(rolloutText(events), { since: Date.parse(events[2].timestamp) });
  assert.equal(parsed.modelCalls, 1);
  assert.equal(parsed.quota.primary.start, 10);
  assert.equal(parsed.quota.primary.end, 10);
  assert.equal(parsed.quota.secondary.start, 81);
  assert.equal(parsed.peakContext, 19814);
  assert.equal(parsed.effort, null);
  assert.deepEqual(D.parseCodexRollout(rolloutFixture, { since: Date.parse(events[2].timestamp) + 1 }), emptyRollout);
});

test('parseCodexRollout: changed resets_at marks only the affected window', () => {
  const events = rolloutEvents();
  events[2].payload.rate_limits.primary.resets_at += 300;
  events[2].payload.rate_limits.primary.window_minutes = 600;
  const parsed = D.parseCodexRollout(rolloutText(events));
  assert.equal(parsed.quota.primary.reset, true);
  assert.equal(parsed.quota.primary.resetsAt, 1790883918);
  assert.equal(parsed.quota.primary.windowMinutes, 600);
  assert.equal(parsed.quota.secondary.reset, false);
});

test('parseCodexRollout: percentage drop remains a reset after recovery', () => {
  const events = rolloutEvents();
  events[2].payload.rate_limits.secondary.used_percent = 1;
  const recovery = JSON.parse(JSON.stringify(events[2]));
  recovery.payload.rate_limits.secondary.used_percent = 82;
  events.push(recovery);
  const parsed = D.parseCodexRollout(rolloutText(events));
  assert.equal(parsed.quota.secondary.end, 82);
  assert.equal(parsed.quota.secondary.reset, true);
  assert.equal(parsed.quota.primary.reset, false);
});

test('parseCodexRollout: empty garbage and unrelated events yield null measurements', () => {
  for (const text of ['', 'not JSON', 'null\n42\n[]\n{}', '{"type":"event_msg","payload":{"type":"other","info":{}}}']) {
    assert.deepEqual(D.parseCodexRollout(text), emptyRollout);
  }
  assert.deepEqual(D.parseCodexRollout('broken\nnull\n' + rolloutFixture + '\n{"type":"event_msg","payload":null}'), D.parseCodexRollout(rolloutFixture));
});

test('parseCodexRollout: model calls require non-null info and event_msg envelope', () => {
  const events = rolloutEvents();
  events[1].payload.info = null;
  events[2].type = 'other';
  const parsed = D.parseCodexRollout(rolloutText(events));
  assert.equal(parsed.modelCalls, null);
  assert.equal(parsed.peakContext, null);
  assert.equal(parsed.contextWindow, null);
});

test('parseCodexRollout: peak uses maximum input and context window uses last info', () => {
  const events = rolloutEvents();
  events[1].payload.info.last_token_usage.input_tokens = 30000;
  events[2].payload.info.model_context_window = 128000;
  const parsed = D.parseCodexRollout(rolloutText(events));
  assert.equal(parsed.peakContext, 30000);
  assert.equal(parsed.contextWindow, 128000);
});

test('parseCodexRollout: effort uses last turn context with reasoning_effort fallback', () => {
  const events = rolloutEvents();
  events.push({ type: 'turn_context', payload: { reasoning_effort: 'high' } });
  assert.equal(D.parseCodexRollout(rolloutText(events)).effort, 'high');
  events.push({ type: 'turn_context', payload: { effort: 'low', reasoning_effort: 'max' } });
  assert.equal(D.parseCodexRollout(rolloutText(events)).effort, 'low');
});

test('parseCodexRollout: absent and invalid measurements stay null', () => {
  const events = rolloutEvents();
  for (const event of events.slice(1)) {
    event.payload.rate_limits = { primary: { used_percent: '9' } };
    event.payload.info = { last_token_usage: { input_tokens: '19814' } };
  }
  assert.deepEqual(D.parseCodexRollout(rolloutText(events)), { ...emptyRollout, modelCalls: 2, effort: 'medium' });
  events[1].payload.rate_limits = { primary: { used_percent: 0 } };
  events[1].payload.info = { last_token_usage: { input_tokens: 0 }, model_context_window: 0 };
  const parsed = D.parseCodexRollout(rolloutText(events));
  assert.deepEqual(parsed.quota, { primary: { start: 0, end: 0, windowMinutes: null, resetsAt: null, reset: false }, secondary: null });
  assert.equal(parsed.peakContext, 0);
  assert.equal(parsed.contextWindow, null);
});

test('findCodexRollout: finds absolute path through exactly three date directories', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-find-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const date = path.join(home, 'sessions', '2026', '10', '01');
  fs.mkdirSync(date, { recursive: true });
  const target = path.join(date, 'rollout-2026-10-01T15-58-18-thread.id.jsonl');
  fs.writeFileSync(target, rolloutFixture);
  fs.writeFileSync(path.join(home, 'sessions', 'stray-file'), 'ignored');
  fs.writeFileSync(path.join(date, 'other-thread.id.jsonl'), 'ignored');
  fs.mkdirSync(path.join(date, 'rollout-directory-thread.id.jsonl'));
  fs.writeFileSync(path.join(path.dirname(date), 'rollout-stamp-shallow.jsonl'), 'ignored');
  const deeper = path.join(date, 'extra');
  fs.mkdirSync(deeper);
  fs.writeFileSync(path.join(deeper, 'rollout-stamp-deep.jsonl'), 'ignored');
  assert.equal(D.findCodexRollout(path.relative(process.cwd(), home), 'thread.id'), target);
  assert.equal(D.findCodexRollout(home, 'threadXid'), null);
  assert.equal(D.findCodexRollout(home, 'shallow'), null);
  assert.equal(D.findCodexRollout(home, 'deep'), null);
});

test('findCodexRollout: unknown id and missing or unreadable sessions return null', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-missing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(D.findCodexRollout(home, 'unknown'), null);
  fs.writeFileSync(path.join(home, 'sessions'), 'not a directory');
  assert.equal(D.findCodexRollout(home, 'unknown'), null);
});

test('findCodexRollout: empty thread id cannot match an empty suffix', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const date = path.join(home, 'sessions', '2026', '10', '01');
  fs.mkdirSync(date, { recursive: true });
  fs.writeFileSync(path.join(date, 'rollout-stamp-.jsonl'), 'ignored');
  assert.equal(D.findCodexRollout(home, ''), null);
});

// T3: exercise the same dedicated home and stdout path as the real delegate CLI.
function quotaCodex(t, { rollout = true, exitCode = 0 } = {}) {
  const dir = tmpdir('codex-quota');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const source = path.join(dir, 'source');
  fs.mkdirSync(home);
  fs.mkdirSync(source);
  const threadId = '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67';
  const events = rolloutEvents();
  const old = JSON.parse(JSON.stringify(events[1]));
  old.timestamp = '2000-01-01T00:00:00Z';
  old.payload.rate_limits.secondary.used_percent = 1;
  const file = path.join(home, 'sessions', '2026', '10', '02', `rollout-2026-10-02T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(path.join(dir, 'codex'), [
    `#!${process.execPath}`,
    "const fs = require('node:fs'); const path = require('node:path');",
    `const events = ${JSON.stringify(events)};`,
    'for (const event of events) event.timestamp = new Date().toISOString();',
    `const file = path.join(process.env.CODEX_HOME, 'sessions/2026/10/02/rollout-2026-10-02T00-00-00-${threadId}.jsonl');`,
    rollout ? String.raw`fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, [${JSON.stringify(old)}, ...events].map(e => JSON.stringify(e)).join('\n'));` : '',
    `console.log(JSON.stringify({ type: 'thread.started', thread_id: '${threadId}' }));`,
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'completed' } }));",
    "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 30 } }));",
    `process.exit(${exitCode});`,
  ].join('\n'));
  fs.chmodSync(path.join(dir, 'codex'), 0o755);
  const env = { ...process.env, PATH: dir, CODEX_HOME: source, RSTAFF_CODEX_HOME: home };
  const log = path.join(dir, 'usage.jsonl');
  const cli = (flags = []) => spawnSync(process.execPath, [
    path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'delegate.js'), 'codex', 'execute',
    '--cwd', dir, '--usage-log', log, ...flags,
  ], { encoding: 'utf8', timeout: 10000, env });
  return { dir, home, file, env, cli, row: () => JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)) };
}

test('parseCliArgs: attempt accepts only positive integers', () => {
  assert.strictEqual(D.parseCliArgs(['codex', 'execute', '--attempt', '2']).attempt, 2);
  for (const value of ['abc', '0', '-1', '2.5', 'Infinity', '', undefined]) {
    const args = ['codex', 'execute', '--attempt'];
    if (value !== undefined) args.push(value);
    assert.strictEqual(D.parseCliArgs(args).attempt, null, String(value));
  }
});

test('CLI: codex records current rollout telemetry and effort override per attempt', (t) => {
  const fake = quotaCodex(t);
  const result = fake.cli(['--reasoning-effort', 'high', '--attempt', '3']);
  assert.strictEqual(result.status, 0, result.stderr);
  const row = fake.row();
  assert.strictEqual(row.effort, 'high');
  assert.strictEqual(row.attempt, 3);
  assert.deepEqual(row.quota, D.parseCodexRollout(rolloutFixture).quota);
  assert.strictEqual(row.modelCalls, 2);
  assert.strictEqual(row.peakContext, 19814);
  assert.strictEqual(row.contextWindow, 258400);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(envelope).sort(), ['exitCode', 'ok', 'sessionId', 'stderrTail', 'structured', 'text', 'timedOut', 'usage', 'timeoutMs'].sort());
  assert.strictEqual(fake.cli().status, 0);
  assert.strictEqual(fake.row().effort, 'medium');
  assert.strictEqual(fake.row().attempt, null);
});

test('CLI: codex missing rollout preserves usage and success or failure envelope', (t) => {
  for (const exitCode of [0, 7]) {
    const fake = quotaCodex(t, { rollout: false, exitCode });
    const result = fake.cli(['--reasoning-effort', 'high']);
    assert.strictEqual(result.status, exitCode === 0 ? 0 : 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: exitCode === 0, text: 'completed', structured: null, timedOut: false,
      exitCode, stderrTail: '', sessionId: '01a0f0ae-7afe-7a12-bc7b-f22b7762fa67',
      usage: { inputTokens: 200, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 230 },
      timeoutMs: D.DEFAULT_TIMEOUT_MS,
    });
    const row = fake.row();
    assert.strictEqual(row.measured, true);
    assert.strictEqual(row.usage.totalTokens, 230);
    assert.strictEqual(row.effort, 'high');
    for (const key of ['quota', 'modelCalls', 'peakContext', 'contextWindow', 'attempt']) assert.strictEqual(row[key], null);
  }
});

test('run: codex rollout read errors are swallowed without changing the run', (t) => {
  const fake = quotaCodex(t);
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (file === fake.file) throw new Error('rollout read failed');
    return read.call(this, file, ...args);
  };
  try {
    const result = withEnv({ RSTAFF_CODEX_HOME: fake.home, CODEX_HOME: fake.home }, () => D.run({
      adapter: 'codex', mode: 'execute', cwd: fake.dir, env: fake.env,
    }));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.text, 'completed');
    assert.strictEqual(result.stderrTail, '');
    assert.strictEqual(result.rollout, null);
  } finally {
    fs.readFileSync = read;
  }
});

test('runner docs: codex commands pass ledger attempts for quota per attempt', () => {
  for (const name of ['external-writer', 'review-packet']) {
    const text = fs.readFileSync(path.join(__dirname, '../..', 'plugins', 'rstaff-engineer', 'skills', 'parallel-build', 'references', `${name}.md`), 'utf8');
    const command = text.match(/```(?:bash)?\n(node [\s\S]*?)```/)[1];
    assert.match(command, /--attempt <N>/, name);
    assert.match(text, /`<N>` is the 1-based writer attempt number/, name);
  }
  // Task-mode verdicts record the same label and ordinal.
  for (const rel of ['skills/parallel-build/SKILL.md', 'agents/feature-runner.md']) {
    const text = fs.readFileSync(path.join(__dirname, '../..', 'plugins', 'rstaff-engineer', rel), 'utf8');
    const tagged = text.match(/--mode task --verdict (block|pass) \\\n\s*(?:│\s*)?--label <repo>\/<slug>\/<task-id> --attempt <N>/g) || [];
    assert.equal(tagged.length, 2, rel);
  }
});

for (const present of [false, true]) {
  test(`CLI: delegate returns its result with usage layer ${present ? 'present' : 'absent'}`, () => {
    const dir = tmpdir('optional-usage');
    const bin = path.join(dir, 'bin');
    const preload = path.join(dir, 'locate-stub.js');
    const log = path.join(dir, 'usage.jsonl');
    const delegate = path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'delegate.js');
    const locator = path.join(path.dirname(delegate), 'locate.js');
    const usageRoot = path.join(__dirname, '../..', 'plugins', 'rstaff-usage');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gemini'), '#!/bin/sh\nprintf "delegated result\\n"\n', { mode: 0o755 });
    // Patch only locate in this child; no host registry or source sibling can override it.
    fs.writeFileSync(preload, `require(${JSON.stringify(locator)}).locate = name => {\n` +
      `  if (name !== 'rstaff-usage') throw new Error('unexpected plugin');\n` +
      `  return ${present ? JSON.stringify(usageRoot) : 'null'};\n};\n`);
    try {
      const result = spawnSync(process.execPath, ['--require', preload, delegate, 'gemini', 'draft',
        '--prompt', 'write a draft', '--usage-log', log, '--label', 'repo/split/T4/implement'], {
        encoding: 'utf8', env: { ...process.env, PATH: bin, RSTAFF_GEMINI_PROJECT: 'project-from-test' },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.text, 'delegated result\n');
      assert.equal(envelope.stderrTail, '');
      assert.equal(fs.existsSync(log), present);
      if (present) {
        const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].label, 'repo/split/T4/implement');
        assert.equal(rows[0].adapter, 'gemini');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
