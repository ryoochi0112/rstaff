#!/usr/bin/env node
// Stand-in for `claude -p` in runner tests. Records every call; acts per STUB_* env.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
// `claude auth status`: logged in unless the test says otherwise.
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: !process.env.STUB_LOGGED_OUT, authMethod: process.env.STUB_LOGGED_OUT ? 'none' : 'claude.ai' }));
  process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
const calls = fs.readdirSync(dir).filter((f) => /^call-\d+\.json$/.test(f)).length;
const author = prompt.startsWith('You write the job for one ticket');
const referee = !author && args.includes('--tools');
const role = author ? 'author' : referee ? 'referee' : 'worker';
const priorAuthorCalls = fs.readdirSync(dir).filter((f) => /^call-\d+\.json$/.test(f))
  .filter((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).role === 'author').length;
fs.writeFileSync(path.join(dir, `call-${calls + 1}.json`), JSON.stringify({ role, args, prompt, cwd: process.cwd() }));
const cost = Number(process.env.STUB_COST || '0.5');
const base = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 12, total_cost_usd: cost, session_id: `stub-${calls + 1}`, permission_denials: [], modelUsage: { 'claude-stub-1': {} } };
if (process.env.STUB_AUTH_ERROR) {
  process.stdout.write(JSON.stringify({ ...base, is_error: true, num_turns: 1, total_cost_usd: 0, result: 'Failed to authenticate: OAuth session expired' }));
  process.exit(1);
}
if (author) {
  // First pass answers STUB_AUTHOR_FIRST when set; every later pass answers STUB_JOB_TEXT.
  const text = priorAuthorCalls === 0 && process.env.STUB_AUTHOR_FIRST ? process.env.STUB_AUTHOR_FIRST : (process.env.STUB_JOB_TEXT || '');
  process.stdout.write(JSON.stringify({ ...base, result: text }));
  process.exit(0);
}
if (referee) {
  const file = path.join(dir, 'verdicts.json');
  const verdicts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = verdicts.shift() || { verdict: 'accept', reasons: ['default accept'] };
  fs.writeFileSync(file, JSON.stringify(verdicts));
  if (next.garbage) process.stdout.write(JSON.stringify({ ...base, result: 'I cannot decide.' }));
  else process.stdout.write(JSON.stringify({ ...base, result: JSON.stringify(next), structured_output: next }));
  process.exit(0);
}
const action = process.env.STUB_WORKER_ACTION || 'write-done';
if (action !== 'noop') fs.writeFileSync('done.txt', 'done\n');
if (action === 'touch-forbidden') fs.writeFileSync(path.join('src', 'keep.txt'), 'changed\n');
if (action === 'write-extra') fs.writeFileSync('extra.txt', 'extra\n');
if (action === 'break-verify') fs.writeFileSync('broken.txt', 'x\n');
if (process.env.STUB_SLEEP_MS) { const until = Date.now() + Number(process.env.STUB_SLEEP_MS); while (Date.now() < until) { /* spin */ } }
process.stdout.write(JSON.stringify({ ...base, result: `worker finished (${action})` }));
