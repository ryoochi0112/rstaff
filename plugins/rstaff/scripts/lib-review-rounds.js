// Review-round memory — Node built-ins only, zero dependencies.
// The review loop once spent 13 rounds across 9 sessions without a durable
// stopping signal, so this file keeps the counter separate from any session.
// Task-mode verdicts stay visible as evidence, but do not share the whole-branch
// streak: task work already has its own three-attempt rail and must not trip this
// breaker during ordinary dispatch.
'use strict';
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const lib = require(path.join(__dirname, '..', 'hooks', 'lib.js'));
const usageRoot = require('./locate.js').locate('rstaff-usage');
const usage = usageRoot ? require(path.join(usageRoot, 'scripts', 'usage.js')) : null;
const fs = lib.fs;

const COMMANDS = new Set(['status', 'record', 'reset']);
const MODES = new Set(['whole', 'task']);
const VERDICTS = new Set(['pass', 'block']);
const MEMO_PLACEHOLDERS = Object.freeze({
  goal: "<restate from the spec's acceptance criteria>",
  why: '<name the single structural gap these rounds keep circling>',
});
const MEMO_FLAGS = Object.freeze({
  '--goal': 'goal',
  '--why': 'why',
});
const CLI_FLAGS = Object.freeze({
  '--repo': 'repo', '--branch': 'branch', '--mode': 'mode', '--verdict': 'verdict',
  '--p0': 'p0', '--p1': 'p1', '--reason': 'reason', '--home': 'home', '--cwd': 'cwd',
  '--label': 'label', '--attempt': 'attempt',
  ...MEMO_FLAGS,
});

function branchKey(branch) {
  // Encode the complete branch string so every segment survives without
  // allowing branch separators or dot segments to become path syntax.
  return Buffer.from(String(branch || 'project'), 'utf8').toString('hex');
}

function statePath(home, repo, branch) {
  return path.join(home, 'var', 'review-rounds', lib.slug(repo), `${branchKey(branch)}.json`);
}

function zeroState(repo, branch) {
  return { repo, branch, rounds: [], streak: 0, tripped: false };
}

// A missing counter is normal on the first review, while a malformed one is a
// recoverable local-state problem. Both must leave /review usable; silently
// swallowing either case would make the breaker look more reliable than it is.
function read(home, repo, branch) {
  const file = statePath(home, repo, branch);
  const legacy = path.join(path.dirname(file), `${lib.slug(branch)}.json`);
  const source = fs.existsSync(file) ? file : fs.existsSync(legacy) ? legacy : null;
  if (!source) return zeroState(repo, branch);
  const raw = lib.safeRead(source);
  if (!raw.trim()) {
    lib.warn(`review-round state unavailable at ${source}; using zero state`);
    return zeroState(repo, branch);
  }
  try {
    const state = JSON.parse(raw);
    if (!state || Array.isArray(state) || !Array.isArray(state.rounds)
      || !Number.isSafeInteger(state.streak) || state.streak < 0
      || typeof state.tripped !== 'boolean') {
      throw new Error('invalid state shape');
    }
    if (source === file) return state;
    const migrated = write(state, home, repo, branch);
    try {
      // Once the full-key rewrite succeeds, leave one authoritative counter.
      // A failed cleanup is non-fatal: the new state is still usable, and the
      // warning makes the duplicate visible for a later operator cleanup.
      fs.unlinkSync(source);
    } catch (e) {
      lib.warn(`cannot remove migrated review-round state ${source}: ${e.message}`);
    }
    return migrated;
  } catch (e) {
    lib.warn(`cannot read review-round state ${source}: ${e.message}`);
    return zeroState(repo, branch);
  }
}

function write(state, home, repo, branch) {
  state.repo = repo;
  state.branch = branch;
  const file = statePath(home, repo, branch);
  lib.ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  return state;
}

function validateRound({ mode, verdict, p0, p1 }) {
  if (!MODES.has(mode)) throw new Error(`invalid mode: ${mode}; expected whole or task`);
  if (!VERDICTS.has(verdict)) throw new Error(`invalid verdict: ${verdict}; expected pass or block`);
  for (const [name, value] of [['p0', p0], ['p1', p1]]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be an integer >= 0`);
    }
  }
}

function fingerprint(cwd) {
  let tempDir;
  let result = null;
  let failure;
  try {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    const git = (top, args, overrides) => spawnSync('git', ['-C', top, ...args], {
      encoding: 'utf8', env: { ...env, ...overrides },
    });
    const checked = (output) => {
      if (output.status !== 0) throw new Error(output.error?.message || output.stderr.trim() || 'git failed');
      return output.stdout.trim();
    };
    const top = checked(git(cwd, ['rev-parse', '--show-toplevel']));
    const headResult = git(top, ['rev-parse', 'HEAD']);
    let head = null;
    let tree = null;
    if (headResult.status === 0) {
      head = checked(headResult);
      tree = checked(git(top, ['rev-parse', 'HEAD^{tree}']));
    } else {
      // Only an unborn branch may lack HEAD; other git failures are fatal.
      const ref = checked(git(top, ['symbolic-ref', 'HEAD']));
      const exists = git(top, ['show-ref', '--verify', '--quiet', ref]);
      if (exists.status !== 1) checked(headResult);
    }
    const index = path.resolve(top, checked(git(top, ['rev-parse', '--git-path', 'index'])));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-review-index-'));
    const tempIndex = path.join(tempDir, 'index');
    // Leave the path absent for an unborn repo: git rejects a zero-byte index.
    if (fs.existsSync(index)) fs.copyFileSync(index, tempIndex);
    const indexEnv = { GIT_INDEX_FILE: tempIndex };
    checked(git(top, ['add', '-A'], indexEnv));
    const wtree = checked(git(top, ['write-tree'], indexEnv));
    if (!/^[0-9a-f]{40}$/.test(wtree)) throw new Error('invalid working-tree hash');
    const status = checked(git(top, ['status', '--porcelain'], { GIT_OPTIONAL_LOCKS: '0' }));
    const dirty = status.split('\n').filter((line) => line.trim()).length;
    result = { head, tree, wtree, dirty };
  } catch (e) {
    failure = e;
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); }
      catch (e) { failure = failure || e; }
    }
  }
  if (failure) {
    lib.warn(`cannot fingerprint review tree: ${failure.message.replace(/\s+/g, ' ')}`);
    return null;
  }
  return result;
}

function currency(state, cwd) {
  const round = state.rounds.findLast((round) => round.mode === 'whole' && round.verdict);
  if (!round) {
    return { round: 0, verdict: null, current: null, moved: null, reason: 'no whole-branch review recorded' };
  }
  const result = { round: round.n, verdict: round.verdict, current: null, moved: null };
  const stored = round.tree;
  if (!stored || !stored.wtree) {
    return { ...result, reason: `round ${round.n} has no tree stamp; re-run /review` };
  }
  const now = fingerprint(cwd);
  if (!now) return { ...result, reason: 'cwd is not a git repo' };
  const current = stored.wtree === now.wtree;
  if (current) {
    return { ...result, current, moved: [], reason: `working tree matches round ${round.n}` };
  }
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
  const diff = top.status === 0
    ? spawnSync('git', ['-C', top.stdout.trim(), 'diff', '--name-only', stored.wtree, now.wtree], { encoding: 'utf8', env })
    : top;
  if (diff.status !== 0) {
    return { ...result, current, reason: 'stored tree object unavailable; re-run /review' };
  }
  const moved = diff.stdout.split('\n').filter((line) => line.length);
  return { ...result, current, moved, reason: `working tree changed since round ${round.n}` };
}

// A task verdict carries the writer's delegate label and
// ledger attempt, so /rstaff-usage:spend can join it to the writer row and report pass rate per
// model@effort. Both or neither; untagged records behave exactly as before.
function verdictTag({ mode, label, attempt }) {
  const hasLabel = label !== undefined && label !== null;
  const hasAttempt = attempt !== undefined && attempt !== null;
  if (!hasLabel && !hasAttempt) return null;
  if (!hasLabel || !hasAttempt) throw new Error('--label and --attempt must be given together');
  if (mode !== 'task') throw new Error('--label/--attempt apply only to --mode task');
  if (typeof label !== 'string' || !label.trim()) throw new Error('--label must be a non-empty string');
  const n = typeof attempt === 'string' && /^\d+$/.test(attempt) ? Number(attempt) : attempt;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('--attempt must be an integer >= 1');
  return { label: label.trim(), attempt: n };
}

function record(home, repo, branch, details, options = {}) {
  const { mode, verdict, p0, p1 } = details || {};
  validateRound({ mode, verdict, p0, p1 });
  let tag;
  try {
    tag = verdictTag(details || {});
  } catch (e) {
    // The CLI is the review gate's evidence step: a bad telemetry tag must not
    // lose the verdict, so it falls back to an untagged round with a warning.
    if (!options.lenientTag) throw e;
    lib.warn(`review verdict recorded without usage tag: ${e.message}`);
    tag = null;
  }
  const state = read(home, repo, branch);
  const round = { n: state.rounds.length + 1, mode, verdict, p0, p1, ts: new Date().toISOString() };
  if (tag) Object.assign(round, tag);
  round.tree = fingerprint(options.cwd || process.cwd());
  state.rounds.push(round);

  if (mode === 'whole' && verdict === 'block') state.streak += 1;
  if (mode === 'whole' && verdict === 'pass') state.streak = 0;
  state.tripped = state.streak >= 2;
  const written = write(state, home, repo, branch);
  // Telemetry never blocks the review gate: the round is already durable.
  if (tag && usage) {
    try {
      usage.appendRecord(path.join(home, 'var', 'usage.jsonl'), {
        id: `verdict:${tag.label}:${tag.attempt}:${round.ts}`, timestamp: round.ts,
        adapter: 'review', mode: 'verdict', model: '-', label: tag.label,
        attempt: tag.attempt, verdict, measured: false,
      });
    } catch (e) {
      lib.warn(`review verdict not appended to usage log: ${e.message}`);
    }
  }
  return written;
}

function reset(home, repo, branch, options) {
  const reason = options && options.reason;
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('reset reason is required');
  const state = read(home, repo, branch);
  state.rounds.push({ n: state.rounds.length + 1, mode: 'override', reason, ts: new Date().toISOString() });
  state.streak = 0;
  state.tripped = false;
  return write(state, home, repo, branch);
}

function roundForMemo(round) {
  const safe = round || { n: 0, verdict: 'unknown', p0: 0, p1: 0 };
  return `Round ${safe.n} verdict: ${String(safe.verdict).toUpperCase()} (${safe.p0} P0, ${safe.p1} P1)`;
}

function memo(state, options) {
  const rounds = Array.isArray(state && state.rounds) ? state.rounds : [];
  // The breaker is defined over whole-branch reviews. Select those two rounds
  // for the headline even when task evidence was recorded between them.
  const wholeRounds = rounds.filter((round) => round.mode === 'whole');
  const current = wholeRounds[wholeRounds.length - 1] || rounds[rounds.length - 1];
  const prior = wholeRounds[wholeRounds.length - 2] || rounds[rounds.length - 2] || current;
  const goal = options && options.goal !== undefined && options.goal !== null
    ? String(options.goal)
    : MEMO_PLACEHOLDERS.goal;
  const why = options && options.why !== undefined && options.why !== null
    ? String(options.why)
    : MEMO_PLACEHOLDERS.why;
  const nextRound = rounds.length + 1;
  const lines = [
    `## Review circuit breaker: ${state.streak} consecutive BLOCKs on ${state.repo}/${state.branch}`,
    `${roundForMemo(current)} — round ${prior ? prior.n : 0} was ${prior ? String(prior.verdict).toUpperCase() : 'UNKNOWN'} (${prior ? prior.p0 : 0} P0, ${prior ? prior.p1 : 0} P1).`,
    `Goal (restated): ${goal}`,
    `Why convergence is failing: rounds are fixing per-surface instances of what may be ONE structural gap — ${why}.`,
    'Assumption to test: "each finding is an independent bug" — likely false.',
  ];
  const taskRounds = rounds.filter((round) => round.mode === 'task');
  if (taskRounds.length) {
    lines.push(`Task-mode evidence: ${taskRounds.length} verdicts recorded (${taskRounds.map((round) => String(round.verdict).toUpperCase()).join(', ')}).`);
  }
  lines.push(
    'Options:',
    '  A. /replan — re-derive the plan from the spec + receipts (recommended)',
    `  B. Continue round ${nextRound} as-is (override; resets nothing)`,
    '  C. Descope: accept the listed P1s as backlog tickets and ship the P0 fix only',
  );
  return lines.join('\n');
}

function memoObligation({ command, mode, tripped } = {}) {
  if (!tripped) return { emits: false, requiresFilled: false };
  if (command === 'record' && mode === 'whole') {
    return { emits: true, requiresFilled: true };
  }
  if (command === 'status') return { emits: true, requiresFilled: false };
  return { emits: false, requiresFilled: false };
}

function parseArgs(argv) {
  const opts = { command: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const key = CLI_FLAGS[argv[i]];
    if (key) opts[key] = argv[++i];
  }
  return opts;
}

function invalidMemoFields(options) {
  const missing = [];
  for (const field of Object.keys(MEMO_PLACEHOLDERS)) {
    const flag = `--${field}`;
    const value = options && options[field];
    if (value === undefined || value === null
      || !String(value).trim() || String(value) === MEMO_PLACEHOLDERS[field]) {
      missing.push(flag);
    }
  }
  return missing;
}

function requireMemoFields(options) {
  const missing = invalidMemoFields(options);
  if (missing.length) {
    const fields = missing.join(' and ');
    const verb = missing.length === 1 ? 'is' : 'are';
    const noun = missing.length === 1 ? 'a placeholder' : 'placeholders';
    throw new Error(
      `refusing to emit review circuit-breaker memo: ${fields} ${verb} missing or still ${noun}`,
    );
  }
}

function cliCount(value, name) {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer >= 0`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(`${name} must be an integer >= 0`);
  return count;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!COMMANDS.has(opts.command) || !opts.repo || !opts.branch) {
      throw new Error('usage: lib-review-rounds.js <status|record|reset> --repo <r> --branch <b> [--cwd <dir>] [options]');
    }
    const home = opts.home || lib.resolveHome(process.cwd());
    const memoOptions = Object.fromEntries(
      Object.keys(MEMO_PLACEHOLDERS).map((field) => [field, opts[field]]),
    );
    let state;
    if (opts.command === 'status') {
      state = read(home, opts.repo, opts.branch);
      state = { ...state, reviewed: currency(state, opts.cwd || process.cwd()) };
    } else if (opts.command === 'record') {
      if (opts.mode === undefined || opts.verdict === undefined) {
        throw new Error('record requires --mode whole|task and --verdict pass|block');
      }
      const details = {
        mode: opts.mode,
        verdict: opts.verdict,
        p0: cliCount(opts.p0, '--p0'),
        p1: cliCount(opts.p1, '--p1'),
        label: opts.label,
        attempt: opts.attempt,
      };
      state = record(home, opts.repo, opts.branch, details, { cwd: opts.cwd || process.cwd(), lenientTag: true });
    } else {
      state = reset(home, opts.repo, opts.branch, { reason: opts.reason });
    }
    const obligation = memoObligation({
      command: opts.command,
      mode: opts.mode,
      tripped: state.tripped,
    });
    let memoText = null;
    if (obligation.emits && obligation.requiresFilled) {
      try {
        requireMemoFields(memoOptions);
      } catch (e) {
        const statusFields = Object.keys(MEMO_PLACEHOLDERS)
          .map((field) => `--${field} <filled ${field}>`)
          .join(' ');
        throw new Error(
          `round was recorded, but ${e.message}; re-run status --repo ${opts.repo} `
          + `--branch ${opts.branch} ${statusFields}`,
        );
      }
      memoText = memo(state, memoOptions);
    } else if (obligation.emits && invalidMemoFields(memoOptions).length === 0) {
      memoText = memo(state, memoOptions);
    }
    process.stdout.write(JSON.stringify(state, null, 2));
    if (memoText) {
      process.stdout.write(`\n\n${memoText}\n`);
    } else {
      process.stdout.write('\n');
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  fingerprint,
  currency,
  statePath,
  read,
  record,
  reset,
  memo,
  memoObligation,
  parseArgs,
  COMMANDS,
  MODES,
  VERDICTS,
  MEMO_PLACEHOLDERS,
  MEMO_FLAGS,
};
