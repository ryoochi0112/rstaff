'use strict';
// `rstaff run <repo> <ticket> [--home DIR] [--job FILE]` — the bare runner's command line.
const fs = require('node:fs');
const path = require('node:path');

const USAGE = `usage: rstaff run <repo> <ticket> [--home <control repo>] [--job <job.md>]
       rstaff job <repo> <ticket> [--home <control repo>]

job: a read-only author turns the backlog ticket into var/jobs/<repo>/<ticket>/job.md, then a pre-flight
runs the job's checks on untouched main and lists files coupled to the allowed paths. Exit 0 ready,
2 needs a look (the job is written; read the report), 1 error.
run: runs one ticket alone: a headless worker edits a fresh worktree of the product repo, the runner
itself runs the profile's test command and the job's checks, a fresh read-only referee accepts or
rejects, and an accepted change becomes a draft PR. Writes var/jobs/<repo>/<ticket>/{run.jsonl,receipts/}.
Stops at once when var/.STOP exists or the job's time or money cap is hit.
exit codes: 0 accepted · 1 error · 2 rejected after the last round · 3 var/.STOP · 4 time cap · 5 money cap`;

function resolveHome(explicit, env, binDir) {
  for (const candidate of [explicit, env.RSTAFF_HOME, path.resolve(binDir, '..')]) {
    if (candidate && fs.existsSync(path.join(candidate, 'rstaff.json'))) return candidate;
  }
  throw new Error('cannot find the control repo: pass --home or set RSTAFF_HOME to a directory with rstaff.json');
}
function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home' || argv[i] === '--job') { options[argv[i].slice(2)] = argv[++i]; continue; }
    if (argv[i] === '-h' || argv[i] === '--help') { options.help = true; continue; }
    if (argv[i].startsWith('-')) throw new Error(`unknown option ${argv[i]}`);
    positional.push(argv[i]);
  }
  return { positional, options };
}
async function main(argv, { env = process.env, binDir = __dirname, out = process.stdout, err = process.stderr } = {}) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (error) { err.write(`rstaff: ${error.message}\n${USAGE}\n`); return 64; }
  const { positional, options } = parsed;
  const command = positional[0];
  if (options.help || !['run', 'job'].includes(command) || positional.length !== 3) { (options.help ? out : err).write(`${USAGE}\n`); return options.help ? 0 : 64; }
  const [, repo, ticket] = positional;
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || !/^[A-Za-z0-9._-]+$/.test(ticket)) { err.write('rstaff: repo and ticket must be plain names (letters, digits, . _ -)\n'); return 64; }
  let home;
  try { home = resolveHome(options.home, env, binDir); } catch (error) { err.write(`rstaff: ${error.message}\n`); return 64; }
  if (command === 'job') {
    const { authorJob, EXIT } = require('./author.js');
    const result = await authorJob({ home, repo, ticket, env, out: (line) => out.write(`${line}\n`) });
    const kind = Object.keys(EXIT).find((k) => EXIT[k] === result.exit);
    if (result.exit !== EXIT.error) out.write(`rstaff job ${repo} ${ticket}: ${kind === 'look' ? 'needs a look' : kind} — ${result.detail}\n`);
    return result.exit;
  }
  const { run } = require('./run.js');
  const result = await run({ home, repo, ticket, jobFile: options.job, env, out: (line) => out.write(`${line}\n`) });
  out.write(`rstaff run ${repo} ${ticket}: ${result.kind}${result.detail ? ` — ${typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail)}` : ''} (see ${path.join(result.dir, 'run.jsonl')})\n`);
  return result.exit;
}

module.exports = { main, parseArgs, resolveHome, USAGE };
