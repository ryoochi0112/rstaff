#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const delegate = require('./delegate.js');
const consultLedger = require('./consult-ledger.js');
const { parseCodexVersion } = require('./route.js');

const ASTRA_MODEL = 'gpt-6-astra';
const ASTRA_MIN_CODEX = '0.159.0';
const ASTRA_EFFORTS = ['high', 'xhigh', 'max'];
const ASTRA_DEFAULT_EFFORT = 'high';
const ASTRA_TIMEOUT_SEC = 3600;
const FRAMING = 'Research first with web search; cite every external claim with a URL. Give 2–4 options with trade-offs, a recommendation, explicit uncertainty, and what evidence would change the recommendation. Read-only: you may read the working repo, but never modify files.';

function checkPreconditions({ versionText, effort }) {
  const version = parseCodexVersion(versionText);
  const floor = parseCodexVersion(ASTRA_MIN_CODEX);
  const parts = ['major', 'minor', 'patch'];
  const differing = version && parts.find(key => version[key] !== floor[key]);
  if (!version || (differing && version[differing] < floor[differing])) {
    return { ok: false, refused: `astra requires codex >= ${ASTRA_MIN_CODEX}; version is missing, unparseable, or below the floor` };
  }
  if (!ASTRA_EFFORTS.includes(effort)) {
    return { ok: false, refused: `astra effort must be ${ASTRA_EFFORTS.join('|')}; received ${effort}` };
  }
  return { ok: true };
}

function consult({ ledgerText, prompt, effort = ASTRA_DEFAULT_EFFORT, cwd,
  timeoutSec = ASTRA_TIMEOUT_SEC, runner = delegate.run, versionText }) {
  const preconditions = checkPreconditions({ versionText, effort });
  if (!preconditions.ok) return preconditions;
  const { header } = consultLedger.splitLedger(ledgerText);
  // readField currently splits a complete ledger itself; give it only the header
  // plus an empty log so user text in the existing log cannot supply fields.
  const field = key => consultLedger.readField(header + '\n## Log\n', key);
  const thread = field('thread');
  const scope = field('scope') || '_new';
  const topic = /^# Consult: ([^\r\n]*)/m.exec(header)?.[1] || 'consult';
  const label = `${scope}/consult-astra/${consultLedger.slugTopic(topic)}`;
  const safePrompt = prompt.startsWith('-') ? `Question: ${prompt}` : prompt;
  const common = { adapter: 'codex', search: true, model: ASTRA_MODEL,
    reasoningEffort: effort, cwd, timeoutSec, label };
  const invoke = opts => {
    try { return runner(opts); }
    catch (error) { return { ok: false, text: error.message, timedOut: false }; }
  };
  const fresh = () => invoke({ ...common, mode: 'advise', sandbox: 'read-only',
    prompt: FRAMING + '\n\n' + header + '\n\n' + safePrompt });
  let result;
  let continuity;
  if (thread && thread !== '-') {
    result = invoke({ ...common, mode: 'resume', threadId: thread, prompt: safePrompt });
    continuity = 'resumed';
    if (!result.ok && !result.timedOut) {
      result = fresh();
      continuity = 'reseeded';
    }
  } else {
    result = fresh();
    continuity = 'new';
  }
  return { ok: result.ok, text: result.text, threadId: result.sessionId,
    continuity, usage: result.usage, effort, timedOut: result.timedOut, refused: result.refused };
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'run') throw new Error('expected run');
  const flags = { '--ledger': 'ledger', '--prompt-file': 'promptFile',
    '--effort': 'effort', '--timeout': 'timeoutSec', '--cwd': 'cwd' };
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (!key) throw new Error(`unknown flag: ${rest[i]}`);
    if (i + 1 === rest.length) throw new Error(`missing value for ${rest[i]}`);
    opts[key] = rest[++i];
  }
  if (!opts.ledger || !opts.promptFile) throw new Error('run requires --ledger and --prompt-file');
  if (opts.timeoutSec !== undefined) {
    opts.timeoutSec = Number(opts.timeoutSec);
    if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0) throw new Error('--timeout must be a positive number');
  }
  return opts;
}

if (require.main === module) {
  let result;
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    const version = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 10000 });
    result = consult({ ...opts, ledgerText: fs.readFileSync(opts.ledger, 'utf8'),
      prompt: fs.readFileSync(opts.promptFile, 'utf8'),
      versionText: version.status === 0 ? version.stdout : '' });
  } catch (error) {
    result = { ok: false, refused: error.message };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { ASTRA_MODEL, ASTRA_MIN_CODEX, ASTRA_EFFORTS, ASTRA_DEFAULT_EFFORT,
  ASTRA_TIMEOUT_SEC, FRAMING, checkPreconditions, consult };
