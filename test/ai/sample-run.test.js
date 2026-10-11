'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const SAMPLE = path.resolve(__dirname, '../../plugins/rstaff-ai/samples/label-task');
const { parseArgs, shuffledPairs, callClaude } = require(path.join(SAMPLE, 'run.js'));
const rows = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);

function snapshot(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const file = path.join(dir, entry.name);
      const name = prefix + entry.name;
      return entry.isDirectory() ? [[name, 'directory'], ...snapshot(file, `${name}/`)] :
        [[name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
    });
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sample-run-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sample = path.join(root, 'sample');
  const bin = path.join(root, 'bin');
  fs.cpSync(SAMPLE, sample, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.at(-1);
const log = value => fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify(value) + '\\n');
log({event: 'start', pid: process.pid, argv: args, keyPresent: Boolean(process.env.ANTHROPIC_API_KEY)});
// SHIM_BARRIER=n holds each call until n calls have overlapped since it started
// (or 3s pass), so the peak-concurrency assertion does not depend on host load.
const barrier = Number(process.env.SHIM_BARRIER || 0);
const deadline = Date.now() + 3000;
const overlapped = () => {
  let active = 0;
  let seen = false;
  for (const line of fs.readFileSync(process.env.SHIM_LOG, 'utf8').trim().split('\\n')) {
    const event = JSON.parse(line);
    active += event.event === 'start' ? 1 : -1;
    if (event.pid === process.pid && event.event === 'start') seen = true;
    if (seen && active >= barrier) return true;
  }
  return false;
};
const finish = () => {
  log({event: 'end', pid: process.pid});
  if (input === process.env.SHIM_FAIL_INPUT) {
    process.stdout.write('discard this stdout\\n');
    process.stderr.write('x'.repeat(2100) + 'call failed');
    process.exitCode = 1;
  } else process.stdout.write(process.env.SHIM_REPLY || 'positive\\n');
};
const wait = () => (!barrier || overlapped() || Date.now() > deadline ? setTimeout(finish, 80) : setTimeout(wait, 10));
wait();
`, { mode: 0o755 });
  const log = path.join(root, 'calls.jsonl');
  const out = path.join(root, 'replies.jsonl');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SHIM_LOG: log };
  delete env.ANTHROPIC_API_KEY;
  delete env.RSTAFF_SAMPLE_MODEL;
  delete env.RSTAFF_SAMPLE_CONCURRENCY;
  const run = (args = [], extraEnv = {}) => childProcess.spawnSync(process.execPath, [
    'run.js', '--cases', 'cases.jsonl', '--split', 'confirm', '--arm', 'control', '--out', out, ...args,
  ], { cwd: sample, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
  return { root, sample, bin, log, out, env, run };
}

function peakConcurrency(events) {
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.event === 'start' ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.equal(active, 0);
  return peak;
}

test('control confirm runs 12 login calls with exact argv, default model/concurrency and no sample writes', t => {
  const f = fixture(t);
  const before = snapshot(f.sample);
  const result = f.run([], { SHIM_BARRIER: '4' });
  assert.equal(result.status, 0, result.stderr);
  const events = rows(f.log);
  const calls = events.filter(event => event.event === 'start');
  const cases = rows(path.join(f.sample, 'cases.jsonl')).filter(item => item.split === 'confirm');
  assert.equal(calls.length, 12);
  assert.deepEqual(calls.map(call => call.argv.at(-1)).sort(), cases.map(item => item.input).sort());
  for (const call of calls) {
    assert.deepEqual(call.argv, ['-p', '--model', 'claude-haiku-4-5-20251001',
      '--system-prompt-file', path.join(f.sample, 'prompts/control.md'), '--tools', '',
      '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
      '--disable-slash-commands', call.argv.at(-1)]);
    assert.equal(call.keyPresent, false);
  }
  assert.equal(peakConcurrency(events), 4);
  const replies = rows(f.out);
  assert.equal(replies.length, 12);
  for (const row of replies) {
    assert.deepEqual(Object.keys(row).sort(), ['arm', 'exit', 'id', 'model', 'ms', 'reply']);
    assert.equal(row.arm, 'control');
    assert.equal(row.reply, 'positive');
    assert.equal(row.exit, 0);
    assert.equal(row.model, 'claude-haiku-4-5-20251001');
    assert.ok(Number.isInteger(row.ms) && row.ms >= 0);
  }
  assert.deepEqual(snapshot(f.sample), before);
});

test('both arms are complete, shuffled together and repeatable by seed, with model and concurrency overrides', t => {
  const f = fixture(t);
  function run(seed) {
    fs.rmSync(f.log, { force: true });
    const result = childProcess.spawnSync(process.execPath, ['run.js', '--cases', 'cases.jsonl',
      '--split', 'confirm', '--arm', 'both', '--seed', seed, '--out', f.out], {
      cwd: f.sample, env: { ...f.env, RSTAFF_SAMPLE_MODEL: 'test-pinned-model', RSTAFF_SAMPLE_CONCURRENCY: '2', SHIM_BARRIER: '2' },
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const events = rows(f.log);
    const calls = events.filter(event => event.event === 'start');
    assert.equal(calls.length, 24);
    assert.equal(peakConcurrency(events), 2);
    const replies = rows(f.out);
    assert.equal(replies.length, 24);
    for (const row of replies) {
      assert.equal(row.model, 'test-pinned-model');
      assert.equal(row.reply, 'positive');
      assert.equal(row.exit, 0);
    }
    for (const arm of ['control', 'candidate']) {
      const cases = rows(path.join(f.sample, 'cases.jsonl')).filter(item => item.split === 'confirm');
      assert.deepEqual(replies.filter(row => row.arm === arm).map(row => row.id).sort(), cases.map(row => row.id).sort());
      assert.equal(calls.filter(call => call.argv[4] === path.join(f.sample, `prompts/${arm}.md`)).length, 12);
    }
    assert.ok(replies.slice(1).filter((row, i) => row.arm !== replies[i].arm).length > 1);
    return replies.map(row => `${row.id}:${row.arm}`);
  }
  assert.deepEqual(run('repeatable'), run('repeatable'));
  assert.notDeepEqual(run('different'), run('repeatable'));
  const cases = rows(path.join(f.sample, 'cases.jsonl')).filter(item => item.split === 'confirm');
  fs.rmSync(f.log);
  assert.equal(childProcess.spawnSync(process.execPath, ['run.js', '--cases', 'cases.jsonl',
    '--split', 'confirm', '--arm', 'both', '--out', f.out], { cwd: f.sample, env: f.env }).status, 0);
  assert.deepEqual(rows(f.out).map(row => `${row.id}:${row.arm}`),
    shuffledPairs(cases, 'both', 'sample-label-prompt').map(row => `${row.id}:${row.arm}`));
});

test('one nonzero call becomes a null reply with stderr tail, keeps all rows and exits 1', t => {
  const f = fixture(t);
  const item = rows(path.join(f.sample, 'cases.jsonl')).find(row => row.id === 'c01');
  const result = f.run([], { SHIM_FAIL_INPUT: item.input });
  assert.equal(result.status, 1, result.stderr);
  const replies = rows(f.out);
  assert.equal(replies.length, 12);
  assert.equal(rows(f.log).filter(row => row.event === 'start').length, 12);
  assert.equal(replies.filter(row => row.reply === null).length, 1);
  const failed = replies.find(row => row.id === item.id);
  assert.equal(failed.reply, null);
  assert.equal(failed.exit, 1);
  assert.equal(failed.stderr.length, 2000);
  assert.ok(failed.stderr.endsWith('call failed'));
});

test('candidate dev preserves every whitespace character except exactly one final newline', t => {
  const f = fixture(t);
  for (const reply of ['positive\n', ' positive \n', 'positive\n\n', 'positive\r\n', 'positive\t', 'positive']) {
    const result = childProcess.spawnSync(process.execPath, ['run.js', '--cases', 'cases.jsonl',
      '--split', 'dev', '--arm', 'candidate', '--out', f.out], {
      cwd: f.sample, env: { ...f.env, SHIM_REPLY: reply, RSTAFF_SAMPLE_CONCURRENCY: '10' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const replies = rows(f.out);
    assert.deepEqual(replies.map(row => row.id).sort(), ['d01', 'd02', 'd03']);
    for (const row of replies) {
      assert.equal(row.reply, reply.endsWith('\n') ? reply.slice(0, -1) : reply);
      assert.equal(row.arm, 'candidate');
    }
  }
});

test('spawn ignores stdin, has a 90 second timeout and records launch errors or signals', async t => {
  const item = { id: 'c01', arm: 'control', input: 'review' };
  for (const mode of ['signal', 'error', 'launch', 'empty']) {
    t.mock.method(childProcess, 'spawn', (command, argv, options) => {
      assert.equal(command, 'claude');
      assert.equal(argv.at(-1), item.input);
      assert.deepEqual(options, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        if (mode === 'error' || mode === 'launch') child.emit('error', new Error('launch failed'));
        child.emit('close', mode === 'launch' ? null : 0,
          mode === 'signal' ? 'SIGTERM' : null);
      });
      return child;
    });
    const row = await callClaude(item, 'pinned');
    assert.equal(row.reply, mode === 'empty' ? '' : null);
    assert.equal(row.exit, mode === 'launch' ? null : 0);
    if (mode !== 'empty') assert.equal(row.stderr, mode === 'signal' ? 'SIGTERM' : 'launch failed');
    t.mock.restoreAll();
  }
});

test('bad arguments, concurrency, input data and output paths fail before a successful run', t => {
  const f = fixture(t);
  const valid = ['--cases', 'cases.jsonl', '--split', 'confirm', '--arm', 'control', '--out', f.out];
  for (const [args, message] of [[[], /required argument missing/],
    [['--unknown', 'value'], /unknown argument/], [['--cases'], /missing value/],
    [['--cases', '--split'], /missing value/], [['--cases', ''], /missing value/],
    [[...valid, '--seed'], /missing value/], [[...valid, '--arm', 'control'], /duplicate argument/],
    [valid.map(value => value === 'control' ? 'other' : value), /--arm must be/]]) {
    assert.throws(() => parseArgs(args), message);
  }
  for (const flag of ['--cases', '--split', '--arm', '--out']) {
    const i = valid.indexOf(flag);
    assert.throws(() => parseArgs([...valid.slice(0, i), ...valid.slice(i + 2)]), /required argument missing/);
  }
  assert.deepEqual(parseArgs([...valid, '--seed', 'fixed']), {
    '--cases': 'cases.jsonl', '--split': 'confirm', '--arm': 'control', '--out': f.out, '--seed': 'fixed',
  });
  for (const concurrency of ['0', '-1', '1.5', 'bad']) {
    assert.equal(f.run([], { RSTAFF_SAMPLE_CONCURRENCY: concurrency }).status, 2);
  }
  const caseFile = path.join(f.sample, 'cases.jsonl');
  for (const data of ['{bad json\n', '', JSON.stringify({ id: 'x', split: 'dev', input: 'hi' }),
    JSON.stringify({ id: 1, split: 'confirm', input: 'hi' }),
    JSON.stringify({ id: 'x', split: 'confirm', input: null }),
    [1, 2].map(() => JSON.stringify({ id: 'x', split: 'confirm', input: 'hi' })).join('\n')]) {
    fs.writeFileSync(caseFile, data);
    const result = f.run();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /run:/);
  }
  fs.rmSync(caseFile);
  assert.equal(f.run().status, 2);
  assert.equal(fs.existsSync(f.log), false);
  assert.equal(fs.existsSync(f.out), false);
  fs.copyFileSync(path.join(SAMPLE, 'cases.jsonl'), caseFile);
  const result = childProcess.spawnSync(process.execPath, ['run.js', '--cases', 'cases.jsonl',
    '--split', 'dev', '--arm', 'candidate', '--out', path.join(f.root, 'absent/replies.jsonl')], {
    cwd: f.sample, env: f.env, encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ENOENT/);
});

test('adapter declaration exactly matches the portable sample contract', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(SAMPLE, 'rstaff-adapter.json'), 'utf8')), {
    'label-exact-match': {
      default: true, grader: 'code', certify: 'node certify.js --out {cert}',
      run: 'node run.js --cases cases.jsonl --split {split} --arm both --seed {slug} --out {replies}',
      grade: 'node grade.js --cases cases.jsonl --split {split} --replies {replies} --json {grades}',
      cases: 'cases.jsonl', dev: 'split=dev', holdout: 'split=confirm',
      arms: { control: 'prompts/control.md', candidate: 'prompts/candidate.md' },
      minScore: 0.8, ticket: 'ticket.md', judge: 'rstaff-ai:experiment-analyst',
    },
  });
});

test('ticket declares the frozen fields, exposure, paired threshold, guardrail and error policy', () => {
  const ticket = fs.readFileSync(path.join(SAMPLE, 'ticket.md'), 'utf8');
  const template = fs.readFileSync(path.join(SAMPLE, '../../templates/experiment-record.md'), 'utf8');
  const block = template.match(/```yaml\n([\s\S]*?)```/)[1];
  const fields = [...block.matchAll(/^([\w/]+):/gm)].map(match => match[1]);
  assert.ok(fields.length > 20);
  for (const field of fields) assert.ok(ticket.includes(`\n${field}:`), field);
  for (const text of ['slug: sample-label-prompt', 'status: draft', 'lane: confirm',
    'primary_metric: Exact-match rate on split=confirm.',
    'estimand: Paired candidate minus control exact-match rate, in percentage points.',
    'practical_threshold: +15 pts', 'breach_condition: Cases control passes and candidate fails >= 1.',
    'N_cases: 12', 'N_trials_per_case: 1', 'Errors count as fail, stay in the denominator, and are never dropped',
    '> 2 errored calls of 24 -> INCONCLUSIVE', 'stopping_rule: One fixed batch of 24 calls; no retries or early stopping.',
    'holdout_exposure: public demonstration sample; the candidate prompt was written before the cases',
    'model_id: claude-haiku-4-5-20251001', '--seed equal to the ticket slug',
    'declared_intervention_surface: System-prompt file only.', 'control: prompts/control.md',
    'candidate: prompts/candidate.md', 'record that resolved model id']) {
    assert.ok(ticket.includes(text), text);
  }
});
