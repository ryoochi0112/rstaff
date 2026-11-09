'use strict';

// The sealed v3–v5 leg order with its gates and probes. Every `claude` call goes
// through ctx.spawn (default: spawnSync on PATH), so tests can shim it.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fromPluginEval } = require('./adapters.js');
const { gate1, gate2, backgroundOf } = require('./lib-adjudicate.js');

const PROBE_ARMS = ['full', 'placebo', 'null', 'known-fail'];
// [seq, arm, runs]: K, then stage 1 (gate 1 before it, gate 2 after it), then stage 2.
const K_LEG = [1, 'known-fail', 5];
const STAGE1 = [['null', 5], ['full', 5], ['full', 5], ['null', 5], ['null', 5], ['full', 5], ['full', 5], ['null', 5]]
  .map(([arm, n], i) => [i + 2, arm, n]);
const STAGE2 = [['placebo', 5], ['full', 3], ['placebo', 5], ['placebo', 5], ['full', 3], ['placebo', 5]]
  .map(([arm, n], i) => [i + 10, arm, n]);
const LEGS = [K_LEG, ...STAGE1, ...STAGE2];

const defaultSpawn = (args, opts) => spawnSync('claude', args, { maxBuffer: 64 * 1024 * 1024, ...opts });

function probeArgv(armDir, model) {
  return ['-p', 'reply OK', '--model', model, '--plugin-dir', armDir, '--output-format', 'stream-json', '--verbose', '--max-turns', '1'];
}

function legArgv(armDir, n, caseName, legDir, model) {
  return ['plugin', 'eval', armDir, '--ablation', 'none', '--model', model, '--runs', String(n), '--case', caseName,
    '--no-publish', '--trust-plugin', '--output-dir', `${legDir}/`];
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// Reduce a probe's stream-json to {models, plugins, armPath}; paths are realpath'd so they compare exactly.
function parseProbe(stdout, armDir) {
  const armPath = real(armDir);
  const init = String(stdout || '').split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((e) => e && e.type === 'system' && e.subtype === 'init');
  if (!init) return { models: [], plugins: [], armPath, error: 'no init event' };
  const plugins = (Array.isArray(init.plugins) ? init.plugins : []).map((p) => ({
    name: p?.name, source: p?.source, path: typeof p?.path === 'string' && path.isAbsolute(p.path) ? real(p.path) : p?.path,
  }));
  return { models: typeof init.model === 'string' && init.model ? [init.model] : [], plugins, armPath };
}

function runProbe(ctx, phase, arm) {
  const armDir = ctx.arms[arm].dir;
  const res = ctx.spawn(probeArgv(armDir, 'haiku'), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ctx.env });
  fs.writeFileSync(path.join(ctx.rawDir, `probe-${phase}-${arm}.jsonl`), res.stdout || '');
  return parseProbe(res.stdout, armDir);
}

// One leg, re-run once in place if its JSON is missing or unparseable; null after a second miss.
function runLeg(ctx, seq, arm, n) {
  const legDir = path.join(ctx.rawDir, `${seq}-${arm}`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    fs.rmSync(legDir, { recursive: true, force: true });
    fs.mkdirSync(legDir, { recursive: true });
    ctx.spawn(legArgv(ctx.arms[arm].dir, n, ctx.caseName, legDir, 'haiku'), { stdio: ['ignore', 'inherit', 'inherit'], env: ctx.env });
    try {
      const leg = fromPluginEval(JSON.parse(fs.readFileSync(path.join(legDir, 'aggregate-result.json'), 'utf8')), { seq, arm, caseName: ctx.caseName });
      // A partial result counts its missing runs as errors, never as passes.
      while (leg.runs.length < n) leg.runs.push({ judgePass: false, error: true, subjectText: null });
      return leg;
    } catch (err) {
      ctx.log(`leg ${seq}-${arm} attempt ${attempt}: missing or unparseable aggregate-result.json (${err.message})`);
    }
  }
  return null;
}

function runLegs(ctx, outcome, legs) {
  for (const [seq, arm, n] of legs) {
    const leg = runLeg(ctx, seq, arm, n);
    if (!leg) {
      outcome.stopped = { gate: 'harness', failing: [`leg ${seq}-${arm}: missing or unparseable result after one re-run`] };
      return false;
    }
    outcome.legs.push(leg);
  }
  return true;
}

function stopAt(outcome, name, result) {
  if (result.pass) return false;
  outcome.stopped = { gate: name, failing: result.failing };
  return true;
}

// ctx: {arms:{arm:{dir}}, caseName, owner, rawDir, env?, spawn?, log?, onBackground?(keys)}
function runSequence(ctx) {
  const c = { spawn: defaultSpawn, log: (m) => process.stderr.write(`ablate: ${m}\n`), env: process.env, ...ctx };
  fs.mkdirSync(c.rawDir, { recursive: true });
  const outcome = { legacy: false, owner: c.owner, backgroundPlugins: null, probes: { pre: {}, post: {} }, legs: [], stopped: null };
  for (const arm of PROBE_ARMS) outcome.probes.pre[arm] = runProbe(c, 'pre', arm);
  outcome.backgroundPlugins = backgroundOf(outcome.probes.pre[PROBE_ARMS[0]]);
  if (c.onBackground) c.onBackground(outcome.backgroundPlugins);
  if (!runLegs(c, outcome, [K_LEG]) || stopAt(outcome, 'gate1', gate1(outcome))) return outcome;
  if (!runLegs(c, outcome, STAGE1) || stopAt(outcome, 'gate2', gate2(outcome))) return outcome;
  if (!runLegs(c, outcome, STAGE2)) return outcome;
  outcome.probes.post.full = runProbe(c, 'post', 'full');
  return outcome;
}

// Shakeout: pre probes, then F3 and N3, ungraded by the rule; go needs F >= 2/3 and F - N >= 2.
function runShakeout(ctx) {
  const c = { spawn: defaultSpawn, log: (m) => process.stderr.write(`ablate: ${m}\n`), env: process.env, ...ctx };
  fs.mkdirSync(c.rawDir, { recursive: true });
  const probes = {};
  for (const arm of PROBE_ARMS) probes[arm] = runProbe(c, 'pre', arm);
  const passes = {};
  for (const [seq, arm] of [[1, 'full'], [2, 'null']]) {
    const leg = runLeg(c, seq, arm, 3);
    passes[arm] = leg ? leg.runs.filter((r) => r.judgePass === true && r.error === false).length : null;
  }
  const go = passes.full !== null && passes.null !== null && passes.full >= 2 && passes.full - passes.null >= 2;
  return { probes, backgroundPlugins: backgroundOf(probes.full), F: passes.full, N: passes.null, go };
}

module.exports = { runSequence, runShakeout, parseProbe, probeArgv, legArgv, LEGS, PROBE_ARMS };
