'use strict';
// One headless `claude -p` call per role. The worker may edit its worktree; the referee may only read.
const { spawn, spawnSync } = require('node:child_process');

const REFEREE_SCHEMA = {
  type: 'object',
  properties: { verdict: { enum: ['accept', 'reject'] }, reasons: { type: 'array', items: { type: 'string' } } },
  required: ['verdict', 'reasons'],
  additionalProperties: false,
};
// Bash the referee may run: read-only inspection only.
const READ_ONLY_BASH = ['git diff', 'git log', 'git show', 'git status', 'git blame', 'cat', 'ls', 'head', 'tail',
  'wc', 'grep', 'rg', 'find', 'sed -n', 'diff', 'stat'].map((prefix) => `Bash(${prefix}:*)`);
// Both roles see the product repo as any engineer would (its project settings) and nothing else: no
// rstaff hooks, and no MCP servers. Measured 2026-11-09: without --strict-mcp-config the operator's
// claude.ai connectors attach mid-run and push a 1.3M-character tool catalog into the context each turn.
const HARNESS = ['--setting-sources', 'project', '--strict-mcp-config'];

function money(usd) { return Math.max(0.01, usd).toFixed(2); }
function workerArgs({ maxTurns, budgetUsd }) {
  return ['-p', '--output-format', 'json', '--max-turns', String(maxTurns), '--max-budget-usd', money(budgetUsd),
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--allowedTools', 'Bash', ...HARNESS];
}
// The referee's tool set has no Write or Edit at all (`--tools` names only read tools), and Bash is
// limited to the read-only allowlist under dontAsk. Measured 2026-11-09: `--disallowedTools` and
// `--json-schema` each defeat prompt caching (a 3-turn referee cost $12), so the verdict is asked
// for in the prompt and parsed from the reply instead.
const REFEREE_TOOLS = 'Read,Glob,Grep,Bash';
function refereeArgs({ maxTurns, budgetUsd }) {
  return ['-p', '--output-format', 'json',
    '--max-turns', String(maxTurns), '--max-budget-usd', money(budgetUsd),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--tools', REFEREE_TOOLS,
    '--allowedTools', ...READ_ONLY_BASH, ...HARNESS];
}

// The job author reads the product repo and writes nothing: the referee's tool set.
function authorArgs(opts) { return refereeArgs(opts); }
// `claude auth status` as the runner reads it; anything unreadable counts as logged out.
function authStatus(bin = 'claude', env = process.env) {
  const r = spawnSync(bin, ['auth', 'status'], { env, encoding: 'utf8', timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { json = null; }
  return { loggedIn: !!(json && json.loggedIn === true), method: json && json.authMethod, raw: (r.stdout || r.stderr || '').slice(0, 300) };
}
function workerPrompt(job, { branch, verify, reasons = [] }) {
  const frame = [
    `You are a software engineer working alone on one ticket. Your working directory is a git worktree on branch ${branch}; it is yours to edit.`,
    `Below is the job in the operator's words. Make every check true, keep the repo's test command (${verify}) green, and do not touch the listed paths.`,
    'Do not commit: the runner commits for you after it has run the checks itself. When you are done, stop.',
  ];
  if (job.allowed && job.allowed.length) frame.push(`Change only these files: ${job.allowed.join(', ')}. A change anywhere else is sent back to you.`);
  if (reasons.length) frame.push('', 'A referee rejected the previous attempt. Fix these reasons first:', ...reasons.map((r) => `- ${r}`));
  return `${frame.join('\n')}\n\n---\n\n${job.text}`;
}
const PATCH_LIMIT = 200_000;
function refereePrompt(job, { patch, receipts }) {
  const lines = [
    'You are the referee for one job. You may read files and run read-only git commands; you cannot edit anything.',
    'Decide whether this change should become a draft pull request. Accept only when the diff does what the job asks,',
    'every receipt below exited as expected, and the diff touches nothing the job forbids. Reject otherwise, with reasons a worker can act on.',
    'The receipts were produced by the runner, not by the worker. Your whole final answer must be one JSON object and nothing else: {"verdict": "accept" | "reject", "summary": "...", "reasons": ["..."]}.',
    'summary: one sentence a non-engineer can read, saying what a user gets from this change. reasons: at most five, each one sentence under 25 words, the facts you checked.',
    '', '## Job', '', job.text, '', '## Receipts', '',
  ];
  for (const r of receipts) {
    lines.push(`- \`${r.command}\` (cwd ${r.cwd}) → exit ${r.exit}${r.expected === undefined ? '' : ` (expected ${r.expected})`}${r.attempt === 2 ? ' — second attempt; the first was red' : ''} · head ${r.head.slice(0, 7)} · tree ${r.tree.slice(0, 7)}`);
    if (r.tail) lines.push('  ```', ...r.tail.split('\n').map((l) => `  ${l}`), '  ```');
  }
  const body = patch.length > PATCH_LIMIT ? `${patch.slice(0, PATCH_LIMIT)}\n… (diff truncated at ${PATCH_LIMIT} characters; read the worktree for the rest)` : patch;
  lines.push('', '## Diff', '', '```diff', body, '```');
  return lines.join('\n');
}

// Run claude; resolve to what the runner records. Rejects only on a missing binary, never on a model error.
// `shouldStop` is polled while the child runs (the kill switch): a truthy answer ends the child at once and
// comes back as `stopped`, so a stop never waits for a worker to finish on its own.
function runClaude({ bin = 'claude', args, prompt, cwd, timeoutMs, env = process.env, shouldStop = null, pollMs = null }) {
  const started = Date.now();
  const every = pollMs || Number(env.RSTAFF_RUNNER_STOP_POLL_MS) || 2000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    let child;
    try { child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { return settle(reject, error); }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopped = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, Math.max(1, timeoutMs));
    const poll = shouldStop ? setInterval(() => {
      let reason = null;
      try { reason = shouldStop(); } catch (error) { reason = `unreadable (${error.code || error.message})`; }
      if (reason && !stopped) { stopped = reason; child.kill('SIGTERM'); }
    }, every) : null;
    const done = () => { clearTimeout(timer); if (poll) clearInterval(poll); };
    child.on('error', (error) => {
      done();
      if (error.code === 'ENOENT') return settle(reject, new Error(`cannot run ${bin}: not found on PATH`));
      stderr += `\n${error.message}`;
    });
    child.on('close', (status, signal) => {
      done();
      let json = null;
      try { json = JSON.parse(stdout); } catch (_) { json = null; }
      const structured = json && typeof json.structured_output === 'object' ? json.structured_output : parseLooseJson(json && json.result);
      settle(resolve, {
        ok: !!json && !json.is_error && status === 0 && !stopped,
        timedOut: timedOut && !stopped,
        stopped,
        costUsd: json && typeof json.total_cost_usd === 'number' ? json.total_cost_usd : 0,
        turns: json && typeof json.num_turns === 'number' ? json.num_turns : null,
        durationMs: Date.now() - started,
        text: json && typeof json.result === 'string' ? json.result : stdout.slice(-2000),
        structured,
        sessionId: json && json.session_id,
        denials: json && Array.isArray(json.permission_denials) ? json.permission_denials.length : null,
        status: signal ? null : status,
        signal: signal || null,
        stderr: stderr.slice(-4000),
        json,
      });
    });
    child.stdin.on('error', () => { /* the child may exit before reading the prompt */ });
    child.stdin.end(prompt);
  });
}
function parseLooseJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
}
// A verdict the runner can act on; anything else is a reject (fail closed).
function verdictOf(result) {
  const s = result.structured;
  if (s && (s.verdict === 'accept' || s.verdict === 'reject') && Array.isArray(s.reasons)) {
    return { verdict: s.verdict, reasons: s.reasons.map(String), summary: typeof s.summary === 'string' && s.summary.trim() ? s.summary.trim() : null };
  }
  return { verdict: 'reject', reasons: [`referee gave no valid verdict: ${(result.text || result.stderr || '').slice(0, 300)}`] };
}

module.exports = { REFEREE_SCHEMA, REFEREE_TOOLS, READ_ONLY_BASH, workerArgs, refereeArgs, authorArgs, authStatus, workerPrompt, refereePrompt, runClaude, verdictOf };
