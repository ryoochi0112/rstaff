'use strict';
// `rstaff job <repo> <ticket>`: a read-only author turns the backlog ticket into var/jobs/<repo>/<ticket>/job.md,
// then a pre-flight baselines the job's checks on untouched main and lists repo files coupled to the allowed
// paths (a hash, a snapshot, a fixture). The human reads the report and says go; nothing here edits the product repo.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseJob, outsideAllowed } = require('./job.js');
const { readProfile } = require('./profile.js');
const g = require('./git.js');
const c = require('./claude.js');

const EXIT = { ready: 0, error: 1, look: 2 };
const AUTHOR_TURNS = 40;
const AUTHOR_BUDGET_USD = 3;
const AUTHOR_TIMEOUT_MS = 20 * 60 * 1000;
const CHECK_TIMEOUT_MS = 15 * 60 * 1000;
const PASSES = 2;
const NOT_LOGGED_IN = 'claude is not logged in on this machine: run `claude auth login`';

// One ticket block from backlog/<repo>.md: the `## ID: title` line and its `- key: value` lines.
function readTicket(home, repo, ticket) {
  const rel = `backlog/${repo}.md`;
  let text;
  try { text = fs.readFileSync(path.join(home, rel), 'utf8'); }
  catch (error) { throw new Error(`cannot read ${rel}: ${error.message}`); }
  const lines = text.split(/\r?\n/);
  const escaped = ticket.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const start = lines.findIndex((line) => new RegExp(`^## ${escaped}:\\s`).test(line));
  if (start < 0) throw new Error(`no ticket ${ticket} in ${rel}`);
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end < 0) end = lines.length;
  const block = lines.slice(start, end);
  const title = block[0].replace(new RegExp(`^## ${escaped}:\\s*`), '').trim();
  const fields = {};
  for (const line of block.slice(1)) {
    const m = line.match(/^-\s*([A-Za-z-]+):\s*(.*)$/);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
  }
  return { id: ticket, title, fields, text: `${block.join('\n').trimEnd()}\n` };
}

// Tracked files that mention one of the allowed paths and are not themselves allowed: the places a change
// to an allowed file can break without touching them (the fifth real ticket: a config file hashed into a committed report).
function coupledFiles(tree, allowed) {
  const hits = new Map();
  for (const raw of allowed) {
    const needle = raw.replace(/\/$/, '');
    if (!needle) continue;
    const r = g.git(tree, ['grep', '-l', '-I', '-F', '--', needle], { allowFail: true });
    if (r.status !== 0) continue;
    for (const file of r.stdout.split('\n').filter(Boolean)) {
      if (/(^|\/)node_modules\//.test(file) || /\.mdx?$/i.test(file) || /^docs\//.test(file) || /(^|\/)CHANGELOG/i.test(file)) continue;
      if (!outsideAllowed(allowed, [file]).length) continue;
      if (!hits.has(file)) hits.set(file, []);
      hits.get(file).push(raw);
    }
  }
  return [...hits.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, mentions]) => ({ path: file, mentions }));
}

// Each check as it stands on untouched main. A check that is already green there has nothing to prove.
function baselineChecks(job, cwd, env) {
  return job.checks.map((check) => {
    const r = spawnSync(check.command, { shell: true, cwd, env, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    const exit = r.status === null ? -1 : r.status;
    const ok = !r.error && exit === check.exit && (check.contains === null || output.includes(check.contains));
    return { command: check.command, expected: check.exit, contains: check.contains, exit, ok };
  });
}

function problemsOf(job, baseline, coupled) {
  const problems = [];
  if (baseline.every((b) => b.ok)) problems.push('every check is already green on main');
  for (const file of coupled) problems.push(`${file.path} mentions ${file.mentions.join(', ')} but is not under ## Files`);
  return problems;
}

function authorPrompt(ticket, profile, { problems = [] } = {}) {
  const lines = [
    'You write the job for one ticket. A job is half a page in plain words that a headless worker will carry out alone and a runner will check mechanically. You only read: explore the repo, then answer.',
    `Repo: ${profile.repoPath}. Your working directory is a scratch checkout of its default branch. The repo's test command is \`${profile.verify}\`; every command in the job runs from \`${profile.cwd}\` inside the repo.`,
    'Explore first: the files the ticket names, the tests next to them, the package scripts and the Makefile. Then answer with the complete job.md and nothing else, starting with `# Job:`.',
    '',
    'The job.md format, every heading exactly as written:',
    '',
    '# Job: <ID> — <what a user gets, in plain words>',
    '- repo: <repo directory name>',
    '- ticket: <ID>',
    '',
    '## What should be true when done',
    'One to three paragraphs in plain words: exact file paths, how to recognise the right place, what must still hold afterwards. Name the test that must exist and say its name must contain the ticket id.',
    '',
    '## Checks',
    'Three to six checks, one per numbered line, each `N. \`<shell command>\` → exit <code>` or `N. \`<shell command>\` → exit <code>, output contains "<text>"`. Use the repo\'s real commands (package scripts, make targets). At least one check must be red on today\'s main and green when the job is done (the test named after the ticket); the others keep the repo green (that test file as a whole, typecheck, lint).',
    '',
    '## Files',
    'Only the paths the worker may change, one `- path` per line; a directory ends with `/`. Include generated files that must be regenerated, and any file that pins one of these paths (a hash, a snapshot, a fixture, a schema export): search the repo for each path you list and add what you find, or say in the text why it is not needed.',
    '',
    '## Do not touch',
    'Paths the worker must leave alone, one `- path` per line.',
    '',
    '## Caps',
    '- time: N minutes, - money: N USD, - worker turns: N, - rounds: 3. Small change: 60 minutes, 6 USD, 40 turns. Medium: 90, 10, 60. Large: 150, 12, 80.',
    '',
    'Rules: every path must exist today or be the file the job creates; no network, no credentials, nothing outside the ticket; plain words, one idea per sentence.',
    '',
    `## Ticket (from backlog/${profile.repo}.md)`,
    '',
    ticket.text.trimEnd(),
  ];
  if (problems.length) {
    lines.push('', '## Your previous answer had these problems', '', ...problems.map((p) => `- ${p}`), '', 'Fix them and answer again with the whole file.');
  }
  return `${lines.join('\n')}\n`;
}

function stripFences(text) {
  const t = (text || '').trim();
  const m = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  return m ? m[1].trim() : t;
}

async function authorJob({ home, repo, ticket, env = process.env, out = (line) => process.stdout.write(`${line}\n`), now = Date.now }) {
  const dir = path.join(home, 'var', 'jobs', repo, ticket);
  const authorDir = path.join(dir, 'author');
  fs.mkdirSync(authorDir, { recursive: true });
  const bin = env.RSTAFF_CLAUDE_BIN || 'claude';
  const fail = (detail) => { out(`rstaff job ${repo} ${ticket}: error — ${detail}`); return { exit: EXIT.error, detail, dir }; };
  let tk;
  let profile;
  try {
    tk = readTicket(home, repo, ticket);
    profile = readProfile(home, repo);
    profile.repo = repo;
    if (!profile.verify) throw new Error(`profile ${profile.file} declares no verify command`);
    if (!fs.existsSync(profile.repoPath)) throw new Error(`repo checkout missing: ${profile.repoPath}`);
  } catch (error) {
    return fail(error.message);
  }
  const auth = c.authStatus(bin, env);
  if (!auth.loggedIn) return fail(NOT_LOGGED_IN);

  const tree = path.join(dir, 'author-tree');
  const cwd = () => path.join(tree, profile.cwd);
  let base;
  try {
    base = g.defaultBranch(profile.repoPath);
    g.addScratchWorktree(profile.repoPath, tree, base);
  } catch (error) {
    return fail(error.message);
  }
  const started = now();
  let cost = 0;
  try {
    const install = profile.install(tree);
    if (install) {
      const r = spawnSync(install, { shell: true, cwd: cwd(), env, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
      if (r.error || r.status !== 0) return fail(`install failed on untouched ${base}: ${install} exited ${r.status}`);
    }
    let problems = [];
    let job = null;
    let text = '';
    let preflight = null;
    let passes = 0;
    for (let pass = 1; pass <= PASSES; pass++) {
      passes = pass;
      const prompt = authorPrompt(tk, profile, { problems });
      fs.writeFileSync(path.join(authorDir, `a${pass}-prompt.md`), prompt);
      const r = await c.runClaude({ bin, args: c.authorArgs({ maxTurns: AUTHOR_TURNS, budgetUsd: Number(env.RSTAFF_JOB_BUDGET_USD) || AUTHOR_BUDGET_USD }),
        prompt, cwd: cwd(), timeoutMs: AUTHOR_TIMEOUT_MS, env });
      cost += r.costUsd;
      fs.writeFileSync(path.join(authorDir, `a${pass}-author.json`), `${JSON.stringify({ pass, ok: r.ok, turns: r.turns, costUsd: r.costUsd, durationMs: r.durationMs, status: r.status }, null, 2)}\n`);
      fs.writeFileSync(path.join(authorDir, `a${pass}-author.out`), `${r.text}\n--- stderr ---\n${r.stderr}`);
      text = stripFences(r.text);
      if (!r.ok && !text) { problems = [`the author could not run: ${(r.stderr || r.text || '').trim().split('\n').slice(-3).join(' ')}`]; job = null; continue; }
      try { job = parseJob(text); }
      catch (error) { problems = error.message.replace(/^job\.md:\s*/, '').split('; '); job = null; continue; }
      if (job.repo !== repo || job.ticket !== ticket) { problems = [`the job must say \`- repo: ${repo}\` and \`- ticket: ${ticket}\``]; job = null; continue; }
      const baseline = baselineChecks(job, cwd(), env);
      const coupled = coupledFiles(tree, job.allowed);
      problems = problemsOf(job, baseline, coupled);
      preflight = { verdict: problems.length ? 'needs a look' : 'ready', problems, baseline, coupled, auth: { loggedIn: true }, base, passes: pass, costUsd: Math.round(cost * 100) / 100 };
      if (!problems.length) break;
    }
    if (!job) return fail(`the author could not produce a runnable job: ${problems.join('; ')}`);
    fs.writeFileSync(path.join(dir, 'job.md'), `${text}\n`);
    preflight.elapsedMin = Math.round((now() - started) / 600) / 100;
    fs.writeFileSync(path.join(dir, 'preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`);
    out(`job: ${job.ticket} — ${job.summary}`);
    preflight.baseline.forEach((b, i) => out(`check ${i + 1}: \`${b.command}\` → ${b.ok ? 'green on main' : 'red on main (expected: turns green)'}`));
    out(`files: ${job.allowed.length ? job.allowed.join(', ') : 'no list (any file but the do-not-touch paths)'}`);
    out(`coupled files outside the list: ${preflight.coupled.length ? preflight.coupled.map((f) => `${f.path} (mentions ${f.mentions.join(', ')})`).join('; ') : 'none'}`);
    out(`caps: ${job.caps.timeMinutes} min, ${job.caps.moneyUsd} USD, ${job.caps.workerTurns} turns, ${job.caps.rounds} rounds`);
    out(`author: ${passes} pass${passes === 1 ? '' : 'es'}, $${preflight.costUsd}, ${preflight.elapsedMin} min`);
    out(`pre-flight: ${preflight.verdict}${problems.length ? ` — ${problems.join('; ')}` : ''}`);
    return { exit: problems.length ? EXIT.look : EXIT.ready, dir, job, preflight, cost, detail: path.join(dir, 'job.md') };
  } finally {
    g.removeWorktree(profile.repoPath, tree);
  }
}

module.exports = { authorJob, readTicket, coupledFiles, baselineChecks, authorPrompt, EXIT, NOT_LOGGED_IN };
