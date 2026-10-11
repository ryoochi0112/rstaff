// rstaff hook contract tests — node:test, zero dependencies.
// Each hook is spawned as Claude Code would (JSON event on stdin) and its
// stdout/stderr contract is asserted. Run: node --test test/
// NOTE: secret literals below are split with `+` so they don't match the
// scanner at authoring time; they reassemble to real formats at runtime.
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const HOOKS = path.join(__dirname, '..', 'plugins', 'rstaff', 'hooks');
const USAGE_HOOKS = path.join(__dirname, '..', 'plugins', 'rstaff-usage', 'hooks');
const hookPath = script => path.join(['guard-context.js', 'guard-skill.js', 'usage-capture.js'].includes(script) ? USAGE_HOOKS : HOOKS, script);
const lib = require(path.join(HOOKS, 'lib.js'));
const payloads = require(path.join(__dirname, '..', 'maintainer', 'lib-guard-payloads.js'));

function runHook(script, args, event, env, timeout) {
  return runHookRaw(script, args, JSON.stringify(event || {}), env, undefined, timeout);
}
function runHookRaw(script, args, input, env, cwd, timeout) {
  const r = spawnSync(process.execPath, [hookPath(script), ...(args || [])], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...(env || {}) },
    cwd,
    timeout,
  });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch (_) {}
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, out };
}
function runReadEventRaw(input) {
  return spawnSync(process.execPath, [
    '-e',
    'const { readEvent } = require(process.argv[1]); process.stdout.write(JSON.stringify(readEvent()));',
    path.join(HOOKS, 'lib.js'),
  ], { input, encoding: 'utf8' });
}
function additionalContext(r, message) {
  assert.ok(r.out.hookSpecificOutput,
    `${message}: expected hook output; stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  return r.out.hookSpecificOutput.additionalContext;
}
const decision = (r) => r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecision;
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

// The guard-bash time budgets count the guard's own CPU time, not wall clock.
// Wall clock also counted scheduler queueing, so every run of 3 concurrent
// `make verify` broke the 500 ms budget while the guard itself used < 40 ms
// Contention delays CPU work but does not multiply it, so a
// superlinear scan still blows the budget. The 4.5 s child timeout stays as
// the wall-clock backstop: a killed guard fails the exit-status assertion.
const CPU_PRELOAD = path.join(__dirname, 'fixtures', 'cpu-usage-preload.js');
const GUARD_CPU_BUDGET_MS = 500;
function runGuardCpu(command) {
  const r = spawnSync(process.execPath, ['--require', CPU_PRELOAD, path.join(HOOKS, 'guard-bash.js')], {
    input: JSON.stringify(bash(command)),
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
    timeout: 4500,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch (_) {}
  const reported = (r.output && r.output[3]) || '';
  const cpuMs = /^\d+(\.\d+)?$/.test(reported) ? Number(reported) : NaN;
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, out, cpuMs };
}
function assertCpuBudget(r, label) {
  assert.ok(Number.isFinite(r.cpuMs), `${label}: the CPU preload must report a usage figure`);
  assert.ok(r.cpuMs < GUARD_CPU_BUDGET_MS,
    `${label} must use < ${GUARD_CPU_BUDGET_MS}ms of guard CPU; used ${r.cpuMs.toFixed(1)}ms`);
}
// A genuine control repo is marked by rstaff.json.
const mkctrl = (tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-${tag}-`));
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{"rstaff":"control-repo"}');
  return dir;
};

test('guard payload corpus is populated and rot-pinned', () => {
  const corpora = [
    ['bashDeny', payloads.bashDeny],
    ['bashAsk', payloads.bashAsk],
    ['bashPass', payloads.bashPass],
    ['secretDeny', payloads.secretDeny],
    ['secretClean', payloads.secretClean],
  ];
  assert.equal(payloads.bashDeny.length, 25);
  assert.equal(payloads.bashAsk.length, 65);
  assert.equal(payloads.bashPass.length, 45);
  assert.equal(payloads.secretDeny.length, 10);
  assert.equal(payloads.secretClean.length, 6);
  const ids = [];
  for (const [name, rows] of corpora) {
    assert.ok(rows.length > 0, `${name} must be non-empty`);
    ids.push(...rows.map((row) => row.id));
  }
  assert.equal(new Set(ids).size, ids.length, 'guard payload row ids must be unique');
});

test('deny-tier hook set is explicit, non-empty, and uses the strict event reader', () => {
  const expected = new Set(['guard-bash.js', 'secret-scan.js', 'guard-skill.js']);
  const sources = new Map([HOOKS, USAGE_HOOKS].flatMap(root => fs.readdirSync(root)
    .filter(file => file.endsWith('.js'))
    .map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')])));
  const actual = new Set([...sources]
    .filter(([file, source]) => file !== 'lib.js' && /\b(?:denyTool|askTool|blockPrompt)\b/.test(source))
    .map(([file]) => file));

  assert.ok(actual.size > 0, 'deny-tier hook discovery must not be empty');
  for (const file of actual) {
    assert.ok(expected.has(file), `unexpected deny-tier hook: ${file}`);
  }
  for (const file of expected) {
    assert.ok(actual.has(file), `expected deny-tier hook is missing: ${file}`);
    assert.match(sources.get(file), /\breadEventStrict\s*\(/,
      `${file} must call readEventStrict`);
  }
});

test('malformed events ask in every deny-tier PreToolUse hook', () => {
  const cases = [
    ['A32 guard-bash', 'guard-bash.js', []],
    ['A33 secret-scan file', 'secret-scan.js', ['file']],
    ['A33 guard-skill', 'guard-skill.js', []],
  ];
  for (const [label, script, args] of cases) {
    const r = runHookRaw(script, args, '{"tool_input":');
    assert.equal(r.status, 0, `${label} must exit zero`);
    assert.equal(decision(r), 'ask', `${label} must ask on malformed stdin`);
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /malformed event/i,
      `${label} reason must name the malformed event`);
  }
});

test('non-object JSON asks in every deny-tier PreToolUse hook', () => {
  const cases = [
    ['guard-bash null', 'guard-bash.js', [], 'null'],
    ['guard-bash array', 'guard-bash.js', [], '[]'],
    ['guard-bash number', 'guard-bash.js', [], '123'],
    ['guard-bash string', 'guard-bash.js', [], '"x"'],
    ['secret-scan file null', 'secret-scan.js', ['file'], 'null'],
    ['secret-scan file array', 'secret-scan.js', ['file'], '[]'],
    ['secret-scan file number', 'secret-scan.js', ['file'], '123'],
    ['secret-scan file string', 'secret-scan.js', ['file'], '"x"'],
    ['guard-skill null', 'guard-skill.js', [], 'null'],
    ['guard-skill array', 'guard-skill.js', [], '[]'],
    ['guard-skill number', 'guard-skill.js', [], '123'],
    ['guard-skill string', 'guard-skill.js', [], '"x"'],
  ];
  for (const [label, script, args, input] of cases) {
    const r = runHookRaw(script, args, input);
    assert.equal(r.status, 0, `${label} must exit zero`);
    assert.equal(decision(r), 'ask', `${label} must ask`);
  }
});

test('valid non-object JSON does not crash context hooks', () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-non-object-event-cwd-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-non-object-event-home-'));
  const hooks = [
    ['session-start.js', []],
    ['guard-context.js', []],
    ['usage-capture.js', []],
  ];
  try {
    for (const input of ['null', '[]', '123', '"x"']) {
      for (const [script, args] of hooks) {
        const r = runHookRaw(script, args, input,
          { HOME: fakeHome, RSTAFF_QUIET: '1' }, lonely);
        assert.equal(r.status, 0,
          `${script} must exit zero on raw input ${JSON.stringify(input)}; stderr=${JSON.stringify(r.stderr)}`);
      }
    }
  } finally {
    fs.rmSync(lonely, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('guard-context ceiling tiers name only shipped commands and include a handoff note', () => {
  const ctrl = mkctrl('guard-context-handoff');
  const transcript = path.join(ctrl, 'transcript.jsonl');
  const contextAt = (tokens, sessionId) => {
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'assistant',
      message: { usage: { cache_read_input_tokens: tokens } },
    }) + '\n');
    return additionalContext(runHook('guard-context.js', [], {
      cwd: ctrl,
      transcript_path: transcript,
      session_id: sessionId,
    }, { RSTAFF_HOME: ctrl }), `guard-context tier at ${tokens} tokens`);
  };

  const warning = contextAt(250000, 'handoff-warning');
  const exceeded = contextAt(450000, 'handoff-exceeded');
  assert.match(warning, /⚠/);
  assert.match(exceeded, /⛔/);
  for (const context of [warning, exceeded]) {
    assert.match(context, /handoff note/i);
    for (const [, name] of context.matchAll(/`\/([A-Za-z0-9_-]+)`/g)) {
      assert.ok(
        fs.readdirSync(path.join(__dirname, '..', 'plugins')).some(owner =>
          fs.existsSync(path.join(__dirname, '..', 'plugins', owner, 'commands', `${name}.md`))),
        `/${name} must have a shipped plugin command`
      );
    }
  }
});

test('readEvent normalizes non-object JSON and preserves event objects', () => {
  for (const input of ['null', '[]', '123', '"x"', 'true']) {
    const r = runReadEventRaw(input);
    assert.equal(r.status, 0, `readEvent must not throw on ${input}`);
    assert.deepEqual(JSON.parse(r.stdout), {}, `${input} must normalize to an empty event`);
  }

  const object = { cwd: '/tmp/example', nested: { ok: true } };
  const objectRun = runReadEventRaw(JSON.stringify(object));
  assert.equal(objectRun.status, 0);
  assert.deepEqual(JSON.parse(objectRun.stdout), object);

  const emptyRun = runReadEventRaw('');
  assert.equal(emptyRun.status, 0);
  assert.deepEqual(JSON.parse(emptyRun.stdout), {});
});

test('P43 empty or whitespace stdin passes silently in strict and lenient reader hooks', () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-empty-event-cwd-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-empty-event-home-'));
  const hooks = [
    ['guard-bash.js', []],
    ['secret-scan.js', ['file']],
    ['guard-skill.js', []],
    ['session-start.js', []],
    ['guard-context.js', []],
    ['usage-capture.js', []],
  ];
  try {
    for (const input of ['', ' \n\t']) {
      for (const [script, args] of hooks) {
        const r = runHookRaw(script, args, input,
          { HOME: fakeHome, RSTAFF_QUIET: '1' }, lonely);
        assert.equal(r.status, 0, `${script} must exit zero on ${JSON.stringify(input)}`);
        assert.equal(r.stdout, '', `${script} must pass silently on ${JSON.stringify(input)}`);
      }
    }
  } finally {
    fs.rmSync(lonely, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('session-start emits well-formed context on empty stdin with a control repo', () => {
  const ctrl = mkctrl('empty-event-session-start');
  const proj = path.join(ctrl, 'fixapp'); fs.mkdirSync(proj);
  try {
    const profiles = path.join(ctrl, 'profiles');
    fs.mkdirSync(profiles, { recursive: true });
    fs.writeFileSync(path.join(profiles, 'fixapp.md'), '# Fixture profile\n');

    const r = runHookRaw('session-start.js', [], '', { RSTAFF_HOME: ctrl }, proj);
    assert.equal(r.status, 0, `session-start must exit zero; stderr=${JSON.stringify(r.stderr)}`);
    const output = JSON.parse(r.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(typeof output.hookSpecificOutput.additionalContext === 'string'
      && output.hookSpecificOutput.additionalContext.length > 0,
    'session-start must emit non-empty additionalContext');
  } finally {
    fs.rmSync(ctrl, { recursive: true, force: true });
  }
});

test('secret-scan prompt mode warns and passes on malformed stdin', () => {
  const r = runHookRaw('secret-scan.js', ['prompt'], 'not json at all');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'malformed prompt event must not emit a block decision');
  assert.notEqual(r.stderr, '', 'malformed prompt event must warn on stderr');
});

// --- guard-bash ---------------------------------------------------------
test('guard-bash denies verify-gate bypasses', () => {
  for (const row of payloads.bashDeny) {
    const r = runHook('guard-bash.js', [], bash(row.command));
    assert.equal(decision(r), 'deny', `expected deny: ${row.id} ${row.command}`);
  }
});
test('guard-bash asks before destructive commands', () => {
  for (const row of payloads.bashAsk) {
    const r = runHook('guard-bash.js', [], bash(row.command));
    assert.equal(decision(r), 'ask', `expected ask: ${row.id} ${row.command}`);
  }
});
test('guard-bash passes normal commands silently', () => {
  for (const row of payloads.bashPass) {
    const r = runHook('guard-bash.js', [], bash(row.command));
    assert.equal(r.stdout, '', `expected silent pass: ${row.id} ${row.command}`);
    assert.equal(r.status, 0);
  }
});

test('guard-bash extracts -c shell bodies after a bare assignment and from clustered flags', () => {
  for (const command of [
    'x=1 bash -c "git commit --no-verify -m x"',
    'bash -ec "git commit --no-verify -m x"',
  ]) {
    assert.equal(decision(runHook('guard-bash.js', [], bash(command))), 'deny',
      `expected deny: ${command}`);
  }
});

test('guard-bash shell executors do not consume arguments from later lines', () => {
  for (const command of [
    'eval "$(ssh-agent -s)"\ngit commit -m "docs: note that --no-verify is forbidden"',
    'bash -x\n-c "git commit --no-verify -m x"',
  ]) {
    const r = runHook('guard-bash.js', [], bash(command));
    assert.equal(r.status, 0, `expected zero exit: ${command}`);
    assert.equal(r.stdout, '', `expected silent pass: ${command}`);
  }

  assert.equal(decision(runHook('guard-bash.js', [], bash(
    'eval git commit --no-verify -m x',
  ))), 'deny', 'same-line multi-argument eval must still expose the bypass');
});

test('guard-bash shell-body recursion stops at depth 4', () => {
  const bypass = 'git commit --no-' + 'verify -m x';
  const nest = (body, depth) => {
    for (let i = 0; i < depth; i += 1) body = `bash -c ${JSON.stringify(body)}`;
    return body;
  };

  assert.equal(decision(runHook('guard-bash.js', [], bash(nest(bypass, 4)))), 'deny',
    'a body at depth 4 must still be scanned');
  const beyondDepth = runHook('guard-bash.js', [], bash(nest(bypass, 5)));
  assert.equal(beyondDepth.status, 0);
  assert.equal(beyondDepth.stdout, '', 'a body deeper than 4 is the documented residual');
});

test('guard-bash scans every extracted body whole within the extraction budget', () => {
  const bypass = 'git commit --no-' + 'verify -m x';
  const large = 'x'.repeat(70 * 1024);
  let deep = `${'x'.repeat(200 * 1024)}; ${bypass}`;
  for (let i = 0; i < 4; i += 1) deep = `bash -c ${JSON.stringify(deep)}`;
  const cases = [
    ['70 KiB body ending in bypass', `bash -c "${large}; ${bypass}"`],
    ['four-deep 200 KiB body ending in bypass', deep],
    ['large body before bypass body', `bash -c "${large}"; bash -c "${bypass}"`],
    ['bypass body before large body', `bash -c "${bypass}"; bash -c "${large}"`],
  ];
  for (const [label, command] of cases) {
    const r = runGuardCpu(command);
    assert.equal(r.status, 0,
      `${label} must exit zero rather than be killed; signal=${r.signal} stderr=${JSON.stringify(r.stderr)}`);
    assert.equal(decision(r), 'deny', `${label} must deny`);
    assertCpuBudget(r, label);
  }
});

test('guard-bash passes a 1 MiB benign command within the hook time budget', () => {
  const r = runGuardCpu(`echo ${'x'.repeat(1024 * 1024)}`);
  assert.equal(r.status, 0,
    `1 MiB benign echo must exit zero rather than be killed; signal=${r.signal} stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(r.stdout, '', '1 MiB benign echo must pass silently');
  assertCpuBudget(r, '1 MiB benign echo');
});

test('guard-bash push-tier rules stay within the hook time budget', () => {
  const cases = [
    ['late +refspec', 'git push origin ' + 'a '.repeat(80000) + '+main', 'ask'],
    ['many +refspecs', 'git push origin ' + '+a '.repeat(80000), 'ask'],
    ['force followed by empty quotes', 'git push origin main -f' + '""'.repeat(80000) + '$X', 'ask'],
    ['many force-with-lease tokens', 'git push origin main ' + '--force-with-lease '.repeat(40000) + 'x', 'pass'],
  ];
  for (const [label, command, expected] of cases) {
    const r = runGuardCpu(command);
    assert.equal(r.status, 0,
      `${label} must exit zero rather than be killed; signal=${r.signal} stderr=${JSON.stringify(r.stderr)}`);
    const actual = decision(r) || (r.stdout === '' ? 'pass' : 'invalid');
    assert.equal(actual, expected, `${label} must ${expected}`);
    assertCpuBudget(r, label);
  }
});

// A single-sample wall-clock comparison against HEAD with a 500 ms margin flexed
// with machine load under parallel `node --test` runs,
// so the gate is the hooks.json fail-open timeout — a bound that cannot drift
// from the production contract. The scan is single-pass, so the
// 200 KB line (the original adversarial input, ~2-4 s before) runs in well under
// 100 ms and sits >50x inside the budget. The push-tier fixtures above own the
// per-case budget.
test('guard-bash scan stays inside the hooks.json timeout on 200 KB push lines', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.PreToolUse.flatMap((candidate) => candidate.hooks)
    .find((hook) => hook.command.includes('guard-bash.js'));
  assert.ok(entry && entry.timeout > 0, 'guard-bash must carry a hooks.json timeout');
  const budgetMs = entry.timeout * 1000;
  // Two shapes: one where the push matcher succeeds at the first `git`, and
  // one where every `git` token is a failing-match start (an unbounded option
  // loop was quadratic here while the first shape stayed fast, so the early-match
  // pin alone proved nothing).
  const cases = [
    ['early-match push line', '(git push '.repeat(20000) + 'origin main'],
    ['failing-match git -c chain', 'git -c '.repeat(28000) + 'nopush'],
  ];
  for (const [label, command] of cases) {
    const started = performance.now();
    const r = spawnSync(process.execPath, [path.join(HOOKS, 'guard-bash.js')], {
      input: JSON.stringify(bash(command)), encoding: 'utf8',
      env: { PATH: process.env.PATH }, timeout: budgetMs,
    });
    const elapsed = performance.now() - started;
    assert.equal(r.status, 0,
      `${label}: working copy must exit zero inside the ${budgetMs} ms hooks.json timeout; signal=${r.signal} elapsed=${elapsed.toFixed(0)}ms stderr=${JSON.stringify(r.stderr)}`);
    assert.equal(r.stdout, '', `${label}: fixture must pass`);
    assert.ok(elapsed < budgetMs,
      `${label}: working copy must finish inside the ${budgetMs} ms hooks.json timeout; took ${elapsed.toFixed(0)}ms`);
  }
});

test('guard-bash T5 destructive rules stay within the hook time budget', () => {
  const cases = [
    ['late recursive rm', 'rm '.repeat(40000) + '-rf /', 'ask'],
    ['many quoted rm targets', 'rm -rf ' + '"/" '.repeat(40000), 'ask'],
    ['quoted rm prose', 'echo ' + '"rm -rf /" '.repeat(40000), 'pass'],
    ['many segments before quoted rm target', 'true; '.repeat(40000) + 'rm -rf "/"', 'ask'],
    ['late quoted rm target', 'x'.repeat(1024 * 1024) + ' rm -rf "/"', 'ask'],
    ['late IFS-obfuscated rm', 'x'.repeat(1024 * 1024) + ' ; rm${IFS}-rf${IFS}/', 'ask'],
    ['many checkout refs before whole-tree syntax', 'git checkout ' + 'a '.repeat(80000) + '-- .', 'pass'],
    ['many non-bare checkout paths', 'git checkout HEAD -- ' + './ '.repeat(80000) + '.', 'pass'],
    ['many restore options', 'git restore ' + '--x '.repeat(40000) + '.', 'ask'],
    ['many restore options before a file', 'git restore ' + '--x '.repeat(40000) + 'src/a.ts', 'pass'],
    ['many branch options before forced deletion', 'git branch ' + '--x '.repeat(40000) + '-D x', 'ask'],
    ['many branch options without forced deletion', 'git branch ' + '--x '.repeat(40000) + 'x', 'pass'],
    ['many branch options before safe deletion', 'git branch ' + '--x '.repeat(40000) + '-d x', 'pass'],
    ['short restore miss still reaches later destructive rule', 'git restore ' + '--staged '.repeat(26) + 'src/a.ts; dd if=/dev/zero of=/dev/sda', 'ask'],
    ['many quoted strings', 'echo ' + '"a" '.repeat(80000), 'pass'],
  ];
  for (const [label, command, expected] of cases) {
    const r = runGuardCpu(command);
    assert.equal(r.status, 0,
      `${label} must exit zero rather than be killed; signal=${r.signal} stderr=${JSON.stringify(r.stderr)}`);
    const actual = decision(r) || (r.stdout === '' ? 'pass' : 'invalid');
    assert.equal(actual, expected, `${label} must ${expected}`);
    assertCpuBudget(r, label);
  }
});

test('guard-bash shell-body extraction stays linear on pathological input', () => {
  // The fixture cannot instantiate Claude Code's hooks.json supervisor; the
  // 4.5s child timeout models its configured 5s kill with assertion headroom.
  const cases = [
    ['repeated parens', '(a '.repeat(80000) + '; rm -rf /', 'ask'],
    ['repeated newlines', 'a\n'.repeat(80000) + 'rm -rf /', 'ask'],
    ['repeated sh', 'sh '.repeat(80000), 'pass'],
    ['repeated bash', 'bash '.repeat(80000) + '; git commit --no-verify -m x', 'deny'],
    ['quoted prose', Array.from({ length: 4000 }, (_, i) => `echo "line ${i} isn't shell prose"`).join('\n'), 'pass'],
    ['escaped double quotes', '\\"'.repeat(80000) + '; rm -rf /', 'ask'],
    ['unterminated shell body', 'bash -c "' + '\\"'.repeat(40000), 'pass'],
    ['unbalanced single quote', "'" + 'a '.repeat(80000) + '; rm -rf /', 'ask'],
  ];
  for (const [label, command, expected] of cases) {
    const r = runGuardCpu(command);
    assert.equal(r.status, 0,
      `${label} must exit zero rather than be killed; signal=${r.signal} stderr=${JSON.stringify(r.stderr)}`);
    const actual = decision(r) || (r.stdout === '' ? 'pass' : 'invalid');
    assert.equal(actual, expected, `${label} must ${expected}`);
    assertCpuBudget(r, label);
  }
});

// A shelled Codex writer is the one dispatch path a PreToolUse hook can see, so
// it is where "route.js is not optional" gets teeth. The label carries the ledger
// coordinates; the hook resolves the ledger from $RSTAFF_HOME and reads the row.
const dispatch = (label) => `node "$P/scripts/delegate.js" codex execute --cwd /w`
  + ` --prompt-file /tmp/b.md --model gpt-5.6-sol --label "${label}"`;
const withLedger = (tag, body) => {
  const ctrl = mkctrl(tag);
  fs.mkdirSync(path.join(ctrl, 'var', 'specs', 'demo-repo'), { recursive: true });
  fs.writeFileSync(path.join(ctrl, 'var', 'specs', 'demo-repo', 'feat.tasks.md'), body);
  return ctrl;
};
const LEDGER = `# Tasks — feat
impl: auto

## T1: Unrouted
- status: pending
- risk: high
- route: pending

## T2: Routed
- status: pending
- risk: medium
- route: codex/gpt-5.6-sol@medium -> claude/inherited
`;

test('guard-bash denies a writer dispatched with no persisted route', () => {
  const ctrl = withLedger('route-deny', LEDGER);
  const r = runHook('guard-bash.js', [], bash(dispatch('demo-repo/feat/T1/implement')), { RSTAFF_HOME: ctrl });
  assert.equal(decision(r), 'deny');
  assert.match(r.stdout, /unrouted writer dispatch for demo-repo\/feat\/T1/);
  // A label naming a task the ledger doesn't have is a mislabelled dispatch.
  assert.equal(decision(runHook('guard-bash.js', [], bash(dispatch('demo-repo/feat/T9/implement')), { RSTAFF_HOME: ctrl })), 'deny');
});

test('guard-bash lets a routed writer through, and stays out of the way otherwise', () => {
  const ctrl = withLedger('route-pass', LEDGER);
  const ok = (cmd) => {
    const r = runHook('guard-bash.js', [], bash(cmd), { RSTAFF_HOME: ctrl });
    assert.equal(r.stdout, '', `expected silent pass: ${cmd}`);
    assert.equal(r.status, 0);
  };
  ok(dispatch('demo-repo/feat/T2/implement'));
  // Fails OPEN when the label isn't a locatable parallel-build ledger task:
  // /consult, /sweep, and review labels are none of this hook's business.
  ok(dispatch('other-repo/feat/T1/implement'));
  ok(dispatch('demo-repo/feat/T1/review'));
  ok(dispatch('adhoc-question'));
  ok('node "$P/scripts/delegate.js" codex advise --prompt-file /tmp/q.md');
});

// --- secret-scan ---------------------------------------------------------
test('secret-scan file mode is wired for Bash in hooks.json', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.PreToolUse.find((candidate) =>
    candidate.hooks.some((hook) => hook.command.includes('secret-scan.js" file')));
  assert.ok(entry, 'secret-scan file hook must be present in PreToolUse');
  for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit']) {
    assert.ok(new RegExp('^(?:' + entry.matcher + ')$').test(tool),
      `secret-scan matcher must include ${tool}`);
  }
});

test('secret-scan file mode ignores a Bash event with no command', () => {
  const r = runHook('secret-scan.js', ['file'], { tool_name: 'Bash', tool_input: {} });
  assert.equal(r.stdout, '');
  assert.equal(r.status, 0);
});

test('secret-scan (file mode) denies known secret formats', () => {
  for (const row of payloads.secretDeny) {
    const r = row.command
      ? runHook('secret-scan.js', ['file'], { tool_name: 'Bash', tool_input: { command: row.command } })
      : runHook('secret-scan.js', ['file'], { tool_input: { content: row.text } });
    assert.equal(decision(r), 'deny', `expected deny for ${row.id} ${row.label}`);
  }
});
test('secret-scan (file mode) scans new_string and edits[] too', () => {
  let r = runHook('secret-scan.js', ['file'], { tool_input: { new_string: 'ghp_' + 'D'.repeat(36) } });
  assert.equal(decision(r), 'deny');
  r = runHook('secret-scan.js', ['file'], { tool_input: { edits: [{ new_string: 'AKIA' + 'ABCDEFGHIJKLMNOP' }] } });
  assert.equal(decision(r), 'deny');
});
test('secret-scan (prompt mode) blocks the prompt', () => {
  const r = runHook('secret-scan.js', ['prompt'], { prompt: 'here is sk-' + 'ant-' + 'e5f6'.repeat(6) });
  assert.equal(r.out.decision, 'block');
});
test('secret-scan passes clean text', () => {
  for (const row of payloads.secretClean) {
    const f = row.command
      ? runHook('secret-scan.js', ['file'], { tool_name: 'Bash', tool_input: { command: row.command } })
      : runHook('secret-scan.js', ['file'], { tool_input: { content: row.text } });
    assert.equal(f.stdout, '', `expected pass (file): ${row.id} ${row.text}`);
    if (row.text) {
      const p = runHook('secret-scan.js', ['prompt'], { prompt: row.text });
      assert.equal(p.stdout, '', `expected pass (prompt): ${row.id} ${row.text}`);
    }
  }
});
test('secret-scan file mode stays fast on a 1 MiB Bash command', () => {
  const started = performance.now();
  const r = runHook('secret-scan.js', ['file'], {
    tool_name: 'Bash',
    tool_input: { command: 'echo ' + 'x'.repeat(1024 * 1024) },
  }, undefined, 4500);
  const elapsed = performance.now() - started;
  assert.equal(r.stdout, '');
  assert.equal(r.status, 0);
  assert.ok(elapsed < 500, `1 MiB Bash command must finish in < 500ms; took ${elapsed.toFixed(1)}ms`);
});
test('secret-scan: Cursor key pattern is active but not over-broad', () => {
  // Cursor's prefix is confirmed `crsr_` + 64 chars (2026-07-21), so PATTERNS now
  // has a regex for it (a real key is covered by the payloads.secretDeny loop above).
  // Guard the lower bound: the bare prefix / a placeholder must NOT trip it, so
  // the pattern can't silently widen into false-positive noise.
  for (const clean of ['CURSOR_API_KEY=<from-env>', 'crsr_short', 'the crsr_ prefix alone']) {
    const r = runHook('secret-scan.js', ['file'], { tool_input: { content: clean } });
    assert.equal(r.stdout, '', `expected pass (file): ${clean}`);
    assert.notEqual(decision(r), 'deny');
  }
});

// --- lib.resolveHome precedence ------------------------------------------
test('resolveHome: env → walk-up → ~/.rstaff', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-rh-'));
  const ctrl = path.join(tmp, 'ctrl');
  fs.mkdirSync(ctrl, { recursive: true });
  fs.writeFileSync(path.join(ctrl, 'rstaff.json'), '{}');
  const prev = process.env.RSTAFF_HOME;
  try {
    process.env.RSTAFF_HOME = ctrl;
    assert.equal(lib.resolveHome('/'), ctrl, 'valid env wins');
    process.env.RSTAFF_HOME = path.join(tmp, 'nope');
    const inner = path.join(ctrl, 'a', 'b');
    fs.mkdirSync(inner, { recursive: true });
    assert.equal(lib.resolveHome(inner), ctrl, 'invalid env → walk-up finds control repo');
    delete process.env.RSTAFF_HOME;
    assert.equal(lib.resolveHome(tmp), path.join(os.homedir(), '.rstaff'), 'no env, no walk-up hit → ~/.rstaff');
  } finally {
    if (prev === undefined) delete process.env.RSTAFF_HOME; else process.env.RSTAFF_HOME = prev;
  }
});

// --- lib.isControlRepo ----------------------------------------------------
test('isControlRepo: rstaff.json, marketplace manifest, or RSTAFF_HOME match', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-icr-'));
  const marker = path.join(tmp, 'marked');   // genuine: carries rstaff.json
  fs.mkdirSync(marker, { recursive: true });
  fs.writeFileSync(path.join(marker, 'rstaff.json'), '{}');
  const mkt = path.join(tmp, 'mkt');          // genuine: carries the marketplace manifest
  fs.mkdirSync(path.join(mkt, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(mkt, '.claude-plugin', 'marketplace.json'), '{}');
  const foreign = path.join(tmp, 'other');    // foreign: neither marker
  fs.mkdirSync(foreign, { recursive: true });
  const prev = process.env.RSTAFF_HOME;
  try {
    delete process.env.RSTAFF_HOME;
    assert.equal(lib.isControlRepo(marker), true, 'rstaff.json → control repo');
    assert.equal(lib.isControlRepo(mkt), true, 'marketplace manifest → control repo');
    assert.equal(lib.isControlRepo(foreign), false, 'unmarked repo → NOT a control repo');
    process.env.RSTAFF_HOME = foreign;
    assert.equal(lib.isControlRepo(foreign), true, 'explicit RSTAFF_HOME → trusted');
  } finally {
    if (prev === undefined) delete process.env.RSTAFF_HOME; else process.env.RSTAFF_HOME = prev;
  }
});

// --- session-start --------------------------------------------------------
const backlogSection = (id, fields = {}) => {
  const v = {
    title: 'Do the work', status: 'open', pri: 'P1', route: 'plan', deps: '-',
    source: 'hand', filed: '2026-08-01', falsifier: '-', 'cheapest-test': '-',
    links: '-', context: 'Enough context to act.', ...fields,
  };
  return `## ${id}: ${v.title}\n- status: ${v.status}\n- pri: ${v.pri}\n- route: ${v.route}\n- deps: ${v.deps}\n- source: ${v.source}\n- filed: ${v.filed}\n- falsifier: ${v.falsifier}\n- cheapest-test: ${v['cheapest-test']}\n- links: ${v.links}\n- context: ${v.context}\n`;
};

test('session-start injects memory and writes the liveness marker', () => {
  const ctrl = mkctrl('ss');
  fs.mkdirSync(path.join(ctrl, 'profiles'));
  fs.writeFileSync(path.join(ctrl, 'profiles', `${lib.slug(ctrl)}.md`), '# Fixture profile\n');
  fs.writeFileSync(path.join(ctrl, 'LEARNINGS.md'),
    '# LEARNINGS\n## L01 — t\n- **Date:** 2026-07-01\n- **Type:** preference\n- **Statement:** commit small and often\n- **Scope:** global\n- **Confidence:** high\n- **Status:** ACTIVE\n- **Review by:** 2026-12-01\n');
  const r = runHook('session-start.js', [], { cwd: ctrl }, { RSTAFF_HOME: ctrl });
  const ctx = r.out.hookSpecificOutput && r.out.hookSpecificOutput.additionalContext;
  assert.match(ctx || '', /rstaff memory/);
  assert.doesNotMatch(ctx || '', /commit small and often/);
  // AC6 (gemini doc adapter): the propose-/write rule must reach every managed repo,
  // not only the control repo's CLAUDE.md.
  assert.match(ctx || '', /propose `\/write` in one line/);
  const marker = path.join(ctrl, 'var', 'sessions', '.last-session-start.json');
  assert.ok(fs.existsSync(marker), 'liveness marker written under var/sessions');
  const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(m.home, ctrl);
});
test('session-start injects the product profile for the repo', () => {
  const ctrl = mkctrl('ssp');
  const proj = path.join(ctrl, 'myapp'); fs.mkdirSync(proj);
  fs.mkdirSync(path.join(ctrl, 'profiles'));
  fs.writeFileSync(path.join(ctrl, 'profiles', 'myapp.md'), '# myapp\n**Verify:** `make verify`\n');
  const r = runHook('session-start.js', [], { cwd: proj }, { RSTAFF_HOME: ctrl });
  const ctx = r.out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Product profile — myapp/);
  assert.match(ctx, /make verify/);
});
test('session-start warns about an expired/soon dev credential (non-blocking)', () => {
  const ctrl = mkctrl('cred');
  const proj = path.join(ctrl, 'credapp'); fs.mkdirSync(proj);
  fs.mkdirSync(path.join(ctrl, 'profiles'));
  const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(ctrl, 'profiles', 'credapp.md'),
    '# credapp\n**Repo:** `/tmp/credapp`\n\n## credentials\n' +
    '- `OLD_TOKEN` — persona: member — expires: 2020-01-01 — refresh: re-login\n' +
    `- \`SOON_TOKEN\` — persona: owner — expires: ${soon} — refresh: re-login\n` +
    '- `FRESH_TOKEN` — persona: member — expires: 2099-01-01 — refresh: re-login\n');
  const r = runHook('session-start.js', [], { cwd: proj }, { RSTAFF_HOME: ctrl });
  assert.equal(r.status, 0, 'never blocks the session');
  const ctx = r.out.hookSpecificOutput.additionalContext;
  const pf = (ctx.match(/## [^\n]*Credential preflight[\s\S]*?(?=\n## |$)/) || [''])[0];
  assert.match(pf, /OLD_TOKEN[^\n]*EXPIRED/, 'expired token flagged');
  assert.match(pf, /SOON_TOKEN[^\n]*left/, 'soon-to-expire token flagged');
  assert.ok(!/FRESH_TOKEN/.test(pf), 'fresh token not warned');
});
test('session-start warns LOUDLY when no control repo resolves', () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-lonely-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-home-'));
  const r = runHook('session-start.js', [], { cwd: lonely }, { HOME: fakeHome });
  assert.equal(r.status, 0, 'never blocks the session');
  assert.match(r.stderr, /control repo NOT found/);
  const ctx = r.out.hookSpecificOutput && r.out.hookSpecificOutput.additionalContext;
  assert.match(ctx || '', /control repo NOT found/);
});
test('session-start mentions an invalid RSTAFF_HOME by value', () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-lonely2-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-home2-'));
  const r = runHook('session-start.js', [], { cwd: lonely }, { HOME: fakeHome, RSTAFF_HOME: '/nonexistent-xyz' });
  assert.match(r.stderr, /RSTAFF_HOME=\/nonexistent-xyz is invalid/);
});
test('RSTAFF_QUIET=1 restores silence', () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-lonely3-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-home3-'));
  const r = runHook('session-start.js', [], { cwd: lonely }, { HOME: fakeHome, RSTAFF_QUIET: '1' });
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
});

// --- session-start learnings injection (engineering scopes) ---------------
function writeLearnings(ctrl, body) { fs.writeFileSync(path.join(ctrl, 'LEARNINGS.md'), body); }
const L = (id, type, scope, conf, stmt, status = 'ACTIVE', date = '2026-07-01') =>
  `## ${id} — t\n- **Date:** ${date}\n- **Type:** ${type}\n- **Statement:** ${stmt}\n- **Source:** user-correction\n- **Scope:** ${scope}\n- **Confidence:** ${conf}\n- **Status:** ${status}\n- **Review by:** 2026-12-01\n`;

test('session-start does not inject ACTIVE learnings (global + eng)', () => {
  const ctrl = mkctrl('ln');
  fs.mkdirSync(path.join(ctrl, 'profiles'));
  fs.writeFileSync(path.join(ctrl, 'profiles', `${lib.slug(ctrl)}.md`), '# Fixture profile\n');
  writeLearnings(ctrl, '# LEARNINGS\n' + [
    L('L01', 'preference', 'global', 'high', 'GLOBAL always applies'),
    L('L02', 'lesson', 'eng', 'high', 'ENG applies across rstaff'),
    L('L03', 'lesson', 'repo:other', 'high', 'OTHER repo should not appear'),
    L('L05', 'lesson', 'global', 'low', 'RETIRED must not appear', 'RETIRED(2026-07-02 — x)'),
  ].join(''));
  const r = runHook('session-start.js', [], { cwd: ctrl }, { RSTAFF_HOME: ctrl });
  const ctx = r.out.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /Learnings & code preferences/);
  assert.doesNotMatch(ctx, /GLOBAL always applies/);
  assert.doesNotMatch(ctx, /ENG applies across rstaff/);
  assert.ok(!/OTHER repo/.test(ctx), 'repo:other excluded');
  assert.ok(!/RETIRED must not appear/.test(ctx), 'RETIRED excluded');
  assert.doesNotMatch(ctx, /Log durable corrections via \/learn/, 'nudge line absent');
});

test('session-start does not inject product-repo learnings', () => {
  const ctrl = mkctrl('ln2');
  const proj = path.join(ctrl, 'myapp'); fs.mkdirSync(proj);
  fs.mkdirSync(path.join(ctrl, 'profiles'));
  fs.writeFileSync(path.join(ctrl, 'profiles', 'myapp.md'), '# Fixture profile\n');
  writeLearnings(ctrl, '# LEARNINGS\n' + [
    L('L01', 'preference', 'global', 'high', 'GLOBAL applies everywhere'),
    L('L03', 'lesson', 'repo:myapp', 'medium', 'MYAPP repo pref'),
    L('L04', 'lesson', 'repo:other', 'high', 'OTHER repo excluded'),
    L('L06', 'lesson', 'eng', 'medium', 'ENG applies in product repos'),
  ].join(''));
  const r = runHook('session-start.js', [], { cwd: proj }, { RSTAFF_HOME: ctrl });
  const ctx = r.out.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /Learnings & code preferences/);
  assert.doesNotMatch(ctx, /GLOBAL applies everywhere/);
  assert.doesNotMatch(ctx, /MYAPP repo pref/);
  assert.doesNotMatch(ctx, /ENG applies in product repos/);
  assert.ok(!/OTHER repo excluded/.test(ctx), 'repo:other excluded in a product repo');
});

test('session-start stays silent when there is nothing to inject', () => {
  const ctrl = mkctrl('ln3');   // rstaff.json only: no profile, no learnings, no checkpoint
  const run = () => runHook('session-start.js', [], { cwd: ctrl }, { RSTAFF_HOME: ctrl });
  let r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'missing backlog emits no context');

  fs.mkdirSync(path.join(ctrl, 'backlog'));
  r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'empty backlog emits no context');

  fs.writeFileSync(path.join(ctrl, 'backlog', 'alpha.md'),
    backlogSection('DONE-001', { status: 'done', pri: 'P0' }));
  r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'backlog with no open tickets emits no context');
});

test('session-start adds only a bounded backlog count and /cockpit pointer', () => {
  const ctrl = mkctrl('backlog-count');
  fs.mkdirSync(path.join(ctrl, 'profiles'));
  fs.writeFileSync(path.join(ctrl, 'profiles', `${lib.slug(ctrl)}.md`),
    '# Fixture profile\n**Verify:** `make verify`\n');

  const withoutBacklog = runHook('session-start.js', [], { cwd: ctrl }, { RSTAFF_HOME: ctrl });
  assert.equal(withoutBacklog.status, 0);
  const baseline = additionalContext(withoutBacklog, 'profile fixture must establish baseline context');

  fs.mkdirSync(path.join(ctrl, 'backlog'));
  fs.writeFileSync(path.join(ctrl, 'backlog', 'alpha.md'),
    backlogSection('ALPHA-001', { pri: 'P0' })
    + backlogSection('ALPHA-002', { pri: 'P2', status: 'done' })
    + backlogSection('ALPHA-003', { pri: 'P2' }));
  fs.writeFileSync(path.join(ctrl, 'backlog', 'beta.md'),
    backlogSection('BETA-001', { pri: 'P0' }));
  fs.writeFileSync(path.join(ctrl, 'backlog', 'gamma.md'),
    backlogSection('GAMMA-001', { pri: 'P1' })
    + backlogSection('GAMMA-002', { pri: 'P0', status: 'blocked' }));

  const withBacklog = runHook('session-start.js', [], { cwd: ctrl }, { RSTAFF_HOME: ctrl });
  assert.equal(withBacklog.status, 0);
  const context = additionalContext(withBacklog, 'profile and backlog fixture must emit context');
  assert.deepEqual(context.split('\n').filter((line) => line.includes('/rstaff-backlog:cockpit')),
    ['2 P0 · 4 open across 3 repos — /rstaff-backlog:cockpit']);

  const delta = Buffer.byteLength(context) - Buffer.byteLength(baseline);
  assert.ok(delta > 0, `backlog line must add bytes, got ${delta}`);
  assert.ok(delta <= 200, `backlog line must add <=200 bytes, got ${delta}`);

  const source = fs.readFileSync(path.join(HOOKS, 'session-start.js'), 'utf8');
  const backlogPart = (source.match(/\/\/ Backlog stays pull-only[\s\S]*?\} catch \(_\) \{\}/) || [''])[0];
  assert.match(backlogPart, /\.parseDir\(home\)/, 'count comes from parseDir(home)');
  assert.doesNotMatch(backlogPart, /\brank\b/, 'SessionStart count must not rank the queue');
});

test('session-start backlog failure never blocks or hides other sections', () => {
  const ctrl = mkctrl('backlog-failure');
  fs.mkdirSync(path.join(ctrl, 'profiles'));
  fs.writeFileSync(path.join(ctrl, 'profiles', `${lib.slug(ctrl)}.md`),
    '# Still visible\n**Verify:** `node --test`\n');
  const preload = path.join(ctrl, 'throwing-backlog.js');
  fs.writeFileSync(preload,
    "const Module = require('node:module');\n"
    + 'const original = Module._load;\n'
    + 'Module._load = function (request, parent, isMain) {\n'
    + "  if (request.endsWith('/scripts/lib-backlog.js')) return { parseDir() { throw new Error('unreadable backlog'); } };\n"
    + '  return original.call(this, request, parent, isMain);\n'
    + '};\n');

  const r = runHook('session-start.js', [], { cwd: ctrl }, {
    RSTAFF_HOME: ctrl,
    NODE_OPTIONS: `--require=${preload}`,
  });
  assert.equal(r.status, 0, 'backlog read failure never blocks the session');
  const context = additionalContext(r, 'profile must remain visible after backlog failure');
  assert.match(context, /Still visible/);
  assert.doesNotMatch(context, /\/rstaff-backlog:cockpit/);
});

test('session-start adds no always-on rule or always-loaded skill', () => {
  const plugin = path.join(HOOKS, '..');
  const expectedRules = [
    'review-severity.md',
    'security.md',
  ];
  const actualRules = fs.readdirSync(path.join(plugin, 'rules'), { withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  assert.ok(actualRules.length > 0, 'rules listing must not pass vacuously');
  assert.deepEqual(actualRules, expectedRules, 'always-on rule surface is an explicit contract');
  assert.ok(fs.existsSync(path.join(plugin, '..', 'rstaff-engineer', 'rules', 'superpowers-precedence.md')),
    'composition precedence belongs to the engineer role');

  const hooks = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  const sessionStartHooks = JSON.stringify(hooks.hooks.SessionStart || []);
  const sessionStartSource = fs.readFileSync(path.join(HOOKS, 'session-start.js'), 'utf8');
  assert.doesNotMatch(sessionStartHooks + sessionStartSource, /(?:skills[\\/]|SKILL\.md)/,
    'SessionStart must not load a skill body; skills stay invocation-only');
});

test('session-start does not inject per-project session checkpoints', () => {
  const ctrl = mkctrl('cpn');
  const proj = path.join(ctrl, 'myapp');
  fs.mkdirSync(proj);
  const sessions = path.join(ctrl, 'var', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'myapp.md'),
    '# Session log — myapp\n\n---\n### 2026-10-04T00:00:00.000Z — retro\n' +
    '- what changed: CHECKPOINT_SENTINEL_MUST_NOT_BE_INJECTED\n');

  const r = runHook('session-start.js', [], { cwd: proj }, { RSTAFF_HOME: ctrl });
  const ctx = (r.out.hookSpecificOutput || {}).additionalContext || '';
  assert.doesNotMatch(ctx, /CHECKPOINT_SENTINEL_MUST_NOT_BE_INJECTED/,
    'per-project checkpoint files are not injected');
});

// --- failure-mode coverage -----------------------------------------------
// Each older hook's failure mode is the one SECURITY.md states. A throwing
// dependency is injected with a --require preload, as in the backlog test above.
function throwingPreload(dir, request, message) {
  const file = path.join(dir, `throw-${request.replace(/[^\w]/g, '_')}.js`);
  fs.writeFileSync(file,
    "const Module = require('node:module');\n"
    + 'const original = Module._load;\n'
    + 'Module._load = function (request, parent, isMain) {\n'
    + `  if (request === ${JSON.stringify(request)} || request.endsWith('/' + ${JSON.stringify(request)})) throw new Error(${JSON.stringify(message)});\n`
    + '  return original.call(this, request, parent, isMain);\n'
    + '};\n');
  return `--require=${file}`;
}

test('a crashing guard-bash asks, naming the error', () => {
  const dir = mkctrl('crash-bash');
  const env = { NODE_OPTIONS: throwingPreload(dir, './lib', 'synthetic lib failure') };
  const r = runHook('guard-bash.js', [], bash('ls'), env);
  assert.equal(r.status, 0, 'a crash must not exit non-zero (Claude Code would run the tool)');
  assert.equal(decision(r), 'ask');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /internal error.*synthetic lib failure/);
  const control = runHook('guard-bash.js', [], bash('ls'));
  assert.equal(control.stdout, '', 'without the crash the same command passes silently');
});

test('a crashing secret-scan asks in file mode and warns and passes in prompt mode', () => {
  const dir = mkctrl('crash-secret');
  const env = { NODE_OPTIONS: throwingPreload(dir, './lib', 'synthetic lib failure') };
  const file = runHook('secret-scan.js', ['file'], { tool_name: 'Write', tool_input: { content: 'hello' } }, env);
  assert.equal(file.status, 0);
  assert.equal(decision(file), 'ask');
  assert.match(file.out.hookSpecificOutput.permissionDecisionReason, /internal error.*synthetic lib failure/);
  const prompt = runHook('secret-scan.js', ['prompt'], { prompt: 'hello' }, env);
  assert.equal(prompt.status, 0, 'prompt mode cannot ask; a crash must not block the operator');
  assert.equal(prompt.stdout, '');
  assert.match(prompt.stderr, /secret-scan.*synthetic lib failure/);
  const control = runHook('secret-scan.js', ['file'], { tool_name: 'Write', tool_input: { content: 'hello' } });
  assert.equal(control.stdout, '', 'without the crash the same write passes silently');
});

test('guard-bash route check fails open when route.js cannot load', () => {
  const ctrl = withLedger('route-unloadable', LEDGER);
  const cmd = dispatch('demo-repo/feat/T1/implement');
  assert.equal(decision(runHook('guard-bash.js', [], bash(cmd), { RSTAFF_HOME: ctrl })), 'deny',
    'positive control: the unrouted task denies when route.js loads');
  const r = runHook('guard-bash.js', [], bash(cmd), {
    RSTAFF_HOME: ctrl, NODE_OPTIONS: throwingPreload(ctrl, 'route.js', 'synthetic route failure'),
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'an unloadable router passes silently');
});

test('guard-context is silent on non-JSON stdin and still warns when tier state cannot be written', () => {
  const quiet = runHookRaw('guard-context.js', [], 'not json at all');
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
  const ctrl = mkctrl('ctx-unwritable');
  fs.mkdirSync(path.join(ctrl, 'var'));
  fs.writeFileSync(path.join(ctrl, 'var', 'sessions'), 'a file where the state dir should be');
  const transcript = path.join(ctrl, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 250000 } },
  }) + '\n');
  const r = runHook('guard-context.js', [], { cwd: ctrl, transcript_path: transcript, session_id: `p115${process.pid}` },
    { RSTAFF_HOME: ctrl });
  assert.equal(r.status, 0);
  assert.match(additionalContext(r, 'warning survives an unwritable state file'), /context ceiling/);
  assert.match(r.stderr, /cannot write/);
});

test('session-start keeps the profile on non-JSON stdin and on a throwing install check', () => {
  const ctrl = mkctrl('ss-fail');
  fs.mkdirSync(path.join(ctrl, 'profiles'));
  fs.writeFileSync(path.join(ctrl, 'profiles', `${lib.slug(ctrl)}.md`), '# Still visible\n');
  const bad = runHookRaw('session-start.js', [], 'not json at all', { RSTAFF_HOME: ctrl }, ctrl);
  assert.equal(bad.status, 0);
  assert.match(additionalContext(bad, 'profile after non-JSON stdin'), /Still visible/);
  fs.mkdirSync(path.join(ctrl, 'plugins', 'rstaff', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(ctrl, 'plugins', 'rstaff', '.claude-plugin', 'plugin.json'), '{}');
  fs.mkdirSync(path.join(ctrl, 'maintainer'));
  fs.writeFileSync(path.join(ctrl, 'maintainer', 'lib-install.js'), '');
  const r = runHook('session-start.js', [], { cwd: ctrl }, {
    RSTAFF_HOME: ctrl, NODE_OPTIONS: throwingPreload(ctrl, 'lib-install.js', 'synthetic install failure'),
  });
  assert.equal(r.status, 0, 'an install-check failure never blocks the session');
  assert.match(additionalContext(r, 'profile after install-check failure'), /Still visible/);
});
