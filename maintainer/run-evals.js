'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildEvalCopy, removeEvalCopy } = require('./lib-eval-copy.js');

// Runs `claude plugin eval` per owner plugin against a dependency-free copy.
// Results land under var/evals/, never inside plugins/.

let activeRun = null; // per-plugin run dir that holds the live copy

function cleanupActive() {
  if (!activeRun) return;
  const dir = activeRun;
  activeRun = null;
  removeEvalCopy(dir);
}

function signalExitCode(signal) {
  return 128 + (os.constants.signals[signal] || 0);
}

function onSignal(signal) {
  cleanupActive();
  process.exit(signalExitCode(signal));
}

function parseArgs(argv) {
  const opts = { skill: '', case: '', runs: '', 'keep-temp': '' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in opts) || argv[i] === key) return null;
    opts[key] = argv[i + 1] === undefined ? '' : argv[i + 1];
  }
  return opts;
}

function timestamp(now) {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

// Atomic mkdir; a same-second collision gets -2, -3, ...
function makeResultsDir(base, ts) {
  fs.mkdirSync(base, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = path.join(base, n === 1 ? ts : `${ts}-${n}`);
    try { fs.mkdirSync(dir); return dir; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
}

function main(argv, env = process.env) {
  const opts = parseArgs(argv);
  if (!opts) { console.error('usage: run-evals.js [--skill s] [--case g] [--runs n] [--keep-temp v]'); return 2; }
  if (opts.case && !opts.skill) { console.error('--case requires --skill'); return 2; }
  if (opts.runs && !/^[1-9][0-9]*$/.test(opts.runs)) { console.error('--runs must be a positive integer'); return 2; }

  const cwd = process.cwd();
  const tmpRoot = path.resolve(env.RSTAFF_EVALS_TMP || path.join(cwd, 'var', 'evals', 'tmp'));
  const outRoot = path.resolve(env.RSTAFF_EVALS_OUT || path.join(cwd, 'var', 'evals'));
  const plugins = fs.existsSync(path.join(cwd, 'plugins'))
    ? fs.readdirSync(path.join(cwd, 'plugins')).sort() : [];
  const owners = plugins.filter((p) => {
    const dir = path.join(cwd, 'plugins', p);
    return fs.existsSync(path.join(dir, 'evals'))
      && (!opts.skill || fs.existsSync(path.join(dir, 'skills', opts.skill)));
  });
  if (opts.skill && owners.length === 0) { console.error(`No eval owner for skill: ${opts.skill}`); return 1; }

  const keep = Boolean(opts['keep-temp']);
  const caseGlob = opts.case || (opts.skill ? `${opts.skill}-*` : '');
  fs.mkdirSync(tmpRoot, { recursive: true });
  console.log(`eval copy root: ${tmpRoot}`);

  const sigs = ['SIGINT', 'SIGTERM'];
  const handlers = sigs.map((s) => [s, () => onSignal(s)]);
  for (const [s, h] of handlers) process.on(s, h);
  try {
    for (const p of owners) {
      // Own run dir per plugin, so a build that throws after mkdtemp cannot leak.
      activeRun = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
      try {
        const { pluginDir } = buildEvalCopy(path.join(cwd, 'plugins', p), activeRun);
        const outDir = makeResultsDir(path.join(outRoot, p), timestamp(new Date()));
        console.log(`eval results: ${outDir}`);
        const args = ['plugin', 'eval', pluginDir, '--ablation', 'none', '--no-publish', '--trust-plugin', '--threshold', '0.6'];
        if (caseGlob) args.push('--case', caseGlob);
        if (opts.runs) args.push('--runs', opts.runs);
        if (keep) args.push('--keep-temp');
        args.push('--output-dir', `${outDir}/`, '--report', path.join(outDir, 'report.html'));
        const res = spawnSync('claude', args, { stdio: 'inherit', env });
        if (res.error) { console.error(`claude: ${res.error.message}`); return 127; }
        const code = res.status === null ? signalExitCode(res.signal) : res.status;
        if (code !== 0) return code;
      } finally {
        if (keep) { console.log(`eval copy kept: ${activeRun}`); activeRun = null; } else cleanupActive();
      }
    }
    return 0;
  } finally {
    for (const [s, h] of handlers) process.removeListener(s, h);
  }
}

module.exports = { main, cleanupActive, signalExitCode, onSignal, _setActive: (d) => { activeRun = d; } };

if (require.main === module) process.exitCode = main(process.argv.slice(2), process.env);
