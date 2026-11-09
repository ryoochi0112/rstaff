'use strict';
// rstaff run <repo> <ticket>: one worker, the runner's own checks, one fresh referee, a draft PR.
// Everything it does is written to var/jobs/<repo>/<ticket>/ (run.jsonl, receipts/, pr-body.md).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readJob, forbiddenTouched, outsideAllowed } = require('./job.js');
const { readProfile } = require('./profile.js');
const g = require('./git.js');
const c = require('./claude.js');

const EXIT = { accepted: 0, error: 1, rejected: 2, stop: 3, time: 4, money: 5 };
const PROGRESS_AFTER_MS = 60 * 60 * 1000;
class Stop extends Error {
  constructor(kind, detail) { super(detail); this.kind = kind; }
}
const round2 = (n) => Math.round(n * 100) / 100;
// The kill switch fails closed: a file we cannot stat for any reason other than "not there" counts as present.
function stopRequested(file) {
  try { fs.statSync(file); return 'present'; }
  catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : `unreadable (${error.code || error.message})`; }
}
const tail = (text, n = 40) => (text || '').trim().split('\n').slice(-n).join('\n');

async function run({ home, repo, ticket, jobFile, now = Date.now, env = process.env, out = (line) => process.stdout.write(`${line}\n`) }) {
  const dir = path.join(home, 'var', 'jobs', repo, ticket);
  const receiptsDir = path.join(dir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const state = { start: now(), cost: 0, round: 0, progressed: false };
  const logFile = path.join(dir, 'run.jsonl');
  const line = (step, result, detail) => {
    const record = { ts: new Date(now()).toISOString(), step, result, costUsd: round2(state.cost),
      elapsedMin: round2((now() - state.start) / 60000), round: state.round, ...(detail === undefined ? {} : { detail }) };
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
    out(`[${record.ts}] ${step}: ${result}${detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`} ($${record.costUsd}, ${record.elapsedMin} min)`);
  };
  const finish = (kind, detail) => { line('end', kind, detail); return { exit: EXIT[kind], kind, detail, cost: state.cost, dir }; };

  let job;
  let profile;
  try {
    job = readJob(jobFile || path.join(dir, 'job.md'));
    if (job.repo !== repo || job.ticket !== ticket) throw new Error(`job.md is for ${job.repo} ${job.ticket}, not ${repo} ${ticket}`);
    profile = readProfile(home, repo);
    if (!profile.verify) throw new Error(`profile ${profile.file} declares no verify command`);
    if (!fs.existsSync(profile.repoPath)) throw new Error(`repo checkout missing: ${profile.repoPath}`);
    // Twice in one day the CLI had logged itself out and a run died at its first model call; check before the worktree.
    if (!c.authStatus(env.RSTAFF_CLAUDE_BIN || 'claude', env).loggedIn) throw new Error('claude is not logged in on this machine: run `claude auth login`');
    // Same reason as the login check: a commit with no identity would fail only after the worker and referee were paid.
    if (!g.hasIdentity(profile.repoPath, env)) throw new Error('git has no committer identity here; set user.name and user.email (git config --global ...) before a run');
  } catch (error) {
    line('setup', 'error', error.message);
    return finish('error', error.message);
  }
  const capMs = job.caps.timeMinutes * 60000;
  const stopFile = path.join(home, 'var', '.STOP');
  const stopReason = (stop) => `var/.STOP ${stop === 'present' ? 'exists' : stop}`;
  const gate = (step) => {
    const stop = stopRequested(stopFile);
    if (stop) throw new Stop('stop', `${stopReason(stop)}; stopped before ${step}`);
    if (now() - state.start >= capMs) throw new Stop('time', `time cap ${job.caps.timeMinutes} min reached before ${step}`);
    if (state.cost >= job.caps.moneyUsd) throw new Stop('money', `money cap ${job.caps.moneyUsd} USD reached before ${step}`);
  };
  const remainingMs = () => Math.max(1000, capMs - (now() - state.start));
  const remainingUsd = () => job.caps.moneyUsd - state.cost;
  const tree = path.join(dir, 'tree');
  const workCwd = () => path.join(tree, profile.cwd);
  const receipt = (name, data, output) => {
    const file = path.join(receiptsDir, `r${state.round}-${name}`);
    const record = { ...data, head: g.head(tree), tree: g.treeHash(tree), recordedAt: new Date(now()).toISOString() };
    fs.writeFileSync(`${file}.json`, `${JSON.stringify(record, null, 2)}\n`);
    if (output !== undefined) fs.writeFileSync(`${file}.out`, output);
    return record;
  };
  const runCommand = (name, command, { cwd = workCwd(), expected = 0, contains = null, extra = {} } = {}) => {
    const started = now();
    const r = spawnSync(command, { shell: true, cwd, env, encoding: 'utf8', timeout: remainingMs(), maxBuffer: 256 * 1024 * 1024 });
    const output = `${r.stdout || ''}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''}`;
    const exit = r.status === null ? -1 : r.status;
    const containsOk = contains === null || output.includes(contains);
    const ok = !r.error && exit === expected && containsOk;
    const rec = receipt(name, { command, cwd: path.relative(tree, cwd) || '.', exit, expected, contains, ok, durationMs: now() - started,
      ...(r.signal ? { signal: r.signal } : {}), ...extra, tail: tail(output) }, output);
    return rec;
  };

  try {
    gate('prepare');
    const base = g.defaultBranch(profile.repoPath);
    const start = g.addWorktree(profile.repoPath, tree, job.branch, base);
    line('prepare', 'worktree', { tree, branch: job.branch, from: start });
    const install = profile.install(tree);
    if (install) {
      gate('install');
      const rec = runCommand('install', install);
      line('install', rec.ok ? 'ok' : 'failed', { command: install, exit: rec.exit });
      if (!rec.ok) return finish('error', `install failed: ${install} exited ${rec.exit}`);
    }
    let reasons = [];
    for (state.round = 1; state.round <= job.caps.rounds; state.round++) {
      gate('worker');
      const prompt = c.workerPrompt(job, { branch: job.branch, verify: profile.verify, reasons });
      fs.writeFileSync(path.join(receiptsDir, `r${state.round}-worker-prompt.md`), prompt);
      const w = await c.runClaude({ bin: env.RSTAFF_CLAUDE_BIN || 'claude', args: c.workerArgs({ maxTurns: job.caps.workerTurns, budgetUsd: remainingUsd() }),
        prompt, cwd: workCwd(), timeoutMs: remainingMs(), env, shouldStop: () => stopRequested(stopFile) });
      state.cost += w.costUsd;
      receipt('worker', { role: 'worker', ok: w.ok, stopped: !!w.stopped, turns: w.turns, costUsd: w.costUsd, durationMs: w.durationMs, denials: w.denials, sessionId: w.sessionId, status: w.status, text: tail(w.text, 20) }, `${w.text}\n--- stderr ---\n${w.stderr}`);
      line('worker', w.stopped ? 'stopped' : w.ok ? 'done' : (w.timedOut ? 'timed out' : 'error'), { turns: w.turns, costUsd: round2(w.costUsd), denials: w.denials });
      if (w.stopped) throw new Stop('stop', `${stopReason(w.stopped)}; the worker was ended`);
      if (w.timedOut) throw new Stop('time', 'worker hit the time cap');

      const staged = g.stageAll(tree);
      fs.writeFileSync(path.join(receiptsDir, `r${state.round}-diff.patch`), staged.patch);
      if (!staged.paths.length) {
        // An error with nothing changed is a worker that could not run (auth, API); retrying buys nothing.
        if (!w.ok) return finish('error', `worker could not run: ${tail(w.text || w.stderr, 5)}`);
        reasons = ['the worker changed nothing in the worktree'];
        line('checks', 'skipped', 'no changes');
        continue;
      }
      const receipts = [];
      gate('verify');
      // A red test command is run once more before it is held against the worker: the first demo's
      // only red came from load on the machine, not from the change. Both receipts stay on record.
      let verify = runCommand('verify', profile.verify);
      let firstExit;
      if (!verify.ok) {
        firstExit = verify.exit;
        gate('verify re-run');
        verify = runCommand('verify-rerun', profile.verify, { extra: { attempt: 2 } });
      }
      receipts.push(verify);
      line('verify', verify.ok ? (firstExit === undefined ? 'green' : 'green after re-run') : 'red',
        { command: profile.verify, exit: verify.exit, ...(firstExit === undefined ? {} : { firstExit }) });
      gate('checks');
      job.checks.forEach((check, i) => {
        receipts.push(runCommand(`check-${i + 1}`, check.command, { expected: check.exit, contains: check.contains }));
      });
      const redChecks = receipts.slice(1).filter((r) => !r.ok);
      line('checks', redChecks.length ? 'red' : 'green', { total: job.checks.length, red: redChecks.length });
      const touched = forbiddenTouched(job.forbidden, staged.paths);
      // The job's `## Files` list is enforced here, from the diff: the first demo's referee accepted an
      // unrelated test edit the checks never covered.
      const outside = outsideAllowed(job.allowed, staged.paths);
      if (job.allowed.length) line('files', outside.length ? 'outside' : 'ok', { outside, allowed: job.allowed });
      reasons = [
        ...(verify.ok ? [] : [`the test command \`${profile.verify}\` exited ${firstExit}, and ${verify.exit} again on a re-run:\n${tail(verify.tail, 25)}`]),
        ...redChecks.map((r) => `check \`${r.command}\` exited ${r.exit}, expected ${r.expected}${r.contains !== null ? ` with output containing "${r.contains}"` : ''}:\n${tail(r.tail, 15)}`),
        ...touched.map((p) => `the worker changed a path the job forbids: ${p}`),
        ...outside.map((p) => `the worker changed a file the job does not list: ${p} (the job allows: ${job.allowed.join(', ')})`),
      ];
      if (reasons.length) {
        line('referee', 'skipped', 'red receipts go straight back to the worker');
        continue;
      }
      if (!state.progressed && now() - state.start >= Number(env.RSTAFF_RUNNER_PROGRESS_AFTER_MS || PROGRESS_AFTER_MS)) {
        state.progressed = true;
        const note = `First working version after ${round2((now() - state.start) / 60000)} min on ${job.ticket}.\n`
          + `Open: the worktree ${tree} (branch ${job.branch}) or the patch ${path.join(receiptsDir, `r${state.round}-diff.patch`)}.\n`
          + `Test command and all ${job.checks.length} checks are green; the referee runs next. Cost so far: $${round2(state.cost)}.\n`;
        fs.writeFileSync(path.join(dir, 'progress.md'), note);
        line('progress', 'note', path.join(dir, 'progress.md'));
      }
      gate('referee');
      const refereePrompt = c.refereePrompt(job, { patch: staged.patch, receipts });
      fs.writeFileSync(path.join(receiptsDir, `r${state.round}-referee-prompt.md`), refereePrompt);
      const ref = await c.runClaude({ bin: env.RSTAFF_CLAUDE_BIN || 'claude', args: c.refereeArgs({ maxTurns: 30, budgetUsd: remainingUsd() }),
        prompt: refereePrompt, cwd: workCwd(), timeoutMs: remainingMs(), env, shouldStop: () => stopRequested(stopFile) });
      state.cost += ref.costUsd;
      const verdict = c.verdictOf(ref);
      receipt('referee', { role: 'referee', ok: ref.ok, stopped: !!ref.stopped, turns: ref.turns, costUsd: ref.costUsd, durationMs: ref.durationMs, denials: ref.denials, sessionId: ref.sessionId, ...verdict }, `${ref.text}\n--- stderr ---\n${ref.stderr}`);
      line('referee', ref.stopped ? 'stopped' : verdict.verdict, { reasons: verdict.reasons, costUsd: round2(ref.costUsd) });
      if (ref.stopped) throw new Stop('stop', `${stopReason(ref.stopped)}; the referee was ended`);
      if (ref.timedOut) throw new Stop('time', 'referee hit the time cap');
      if (verdict.verdict !== 'accept') { reasons = verdict.reasons; continue; }

      gate('commit');
      const model = ref.json && ref.json.modelUsage ? Object.keys(ref.json.modelUsage)[0] : null;
      const sha = g.commit(tree, `${job.ticket}: ${job.summary}\n\nrstaff run ${repo} ${ticket}: a headless worker made this change; the runner ran the test command and the job's checks, and a fresh referee accepted it. Job, receipts and verdict are in the PR body.\n\nCo-Authored-By: Claude${model ? ` (${model})` : ''} <noreply@anthropic.com>\n`, env);
      line('commit', sha.slice(0, 7));
      const body = prBody(job, receipts, verdict, state, now);
      fs.writeFileSync(path.join(dir, 'pr-body.md'), body);
      let pr = null;
      if (g.hasRemote(profile.repoPath)) {
        gate('push');
        const pushed = g.push(tree, job.branch, env);
        line('push', pushed.status === 0 ? 'ok' : 'failed', pushed.status === 0 ? job.branch : tail(pushed.stderr, 5));
        if (pushed.status !== 0) return finish('error', `push failed: ${tail(pushed.stderr, 3)}`);
        gate('pr');
        const gh = spawnSync(env.RSTAFF_GH_BIN || 'gh', ['pr', 'create', '--draft', '--base', base, '--head', job.branch,
          '--title', `${job.ticket}: ${job.summary}`, '--body-file', path.join(dir, 'pr-body.md')],
        { cwd: tree, env, encoding: 'utf8' });
        pr = gh.status === 0 ? gh.stdout.trim().split('\n').pop() : null;
        line('pr', pr ? 'draft' : 'failed', pr || tail(`${gh.stdout}\n${gh.stderr}`, 5));
        if (!pr) return finish('error', `gh pr create failed: ${tail(gh.stderr || gh.stdout, 3)}`);
      } else {
        line('pr', 'skipped', 'no origin remote; the commit is on the branch');
      }
      fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify({ ticket, repo, branch: job.branch, sha, pr, verdict, costUsd: round2(state.cost), elapsedMin: round2((now() - state.start) / 60000), rounds: state.round }, null, 2)}\n`);
      return finish('accepted', { pr, sha: sha.slice(0, 7), branch: job.branch });
    }
    state.round = job.caps.rounds;
    return finish('rejected', { rounds: job.caps.rounds, reasons });
  } catch (error) {
    if (error instanceof Stop) return finish(error.kind, error.message);
    line('error', 'crash', error.stack || error.message);
    return finish('error', error.message);
  }
}

// Short and structured, for a human who scans: what changed, the verdict line, short reasons.
// Receipts and the job text stay in the body for the record, folded away.
function prBody(job, receipts, verdict, state, now) {
  const rows = receipts.map((r) => `| \`${r.command}\` | ${r.cwd} | ${r.exit}${r.expected === undefined ? '' : ` (expected ${r.expected})`}${r.attempt === 2 ? ' — second attempt; the first was red' : ''} | ${r.head.slice(0, 7)} | ${r.tree.slice(0, 7)} |`);
  const minutes = round2((now() - state.start) / 60000);
  return [
    '> [!NOTE]', `> **What changed:** ${verdict.summary || job.summary}`, '',
    `**Referee:** ${verdict.verdict} · ${state.round} round${state.round === 1 ? '' : 's'} · ${minutes} min · $${round2(state.cost)}`,
    '', 'Why it passed:', ...verdict.reasons.map((r) => `- ${r}`),
    '', `<details><summary>Receipts (${receipts.length} commands the runner ran)</summary>`, '',
    '| command | cwd | exit | head | tree |', '|---|---|---|---|---|', ...rows, '', '</details>',
    '', '<details><summary>Job</summary>', '', job.text.trim(), '', '</details>',
    '', `Made by \`rstaff run ${job.repo} ${job.ticket}\`: a headless worker wrote the change, the runner ran the commands above itself, and a fresh read-only referee accepted. Nobody has merged anything.`,
    '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)', '',
  ].join('\n');
}

module.exports = { run, prBody, EXIT, Stop, PROGRESS_AFTER_MS, stopRequested };
