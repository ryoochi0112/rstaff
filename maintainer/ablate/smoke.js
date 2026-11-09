'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PROBE_ARMS, probeArgv, legArgv, parseProbe } = require('./sequence.js');
const { fromPluginEval } = require('./adapters.js');

const SMOKE_MODEL = 'invalid-model-ablate-smoke';
const show = (value) => JSON.stringify(value) ?? 'missing';

function runSmoke(ctx) {
  const { arms, caseName, owner, rawDir, env = process.env, log = console.log,
    spawn = (argv, opts) => spawnSync('claude', argv, { maxBuffer: 64 * 1024 * 1024, ...opts }) } = ctx;
  fs.mkdirSync(rawDir, { recursive: true });
  let pass = true;
  for (const [i, arm] of PROBE_ARMS.entries()) {
    const armDir = arms[arm].dir;
    const check = (name, ok, detail) => {
      if (!ok) pass = false;
      log(`${arm} ${ok ? 'PASS' : 'FAIL'} ${name} · ${detail}`);
    };
    const invoke = (argv, stdoutPath, stderrPath) => {
      const res = spawn(argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
      fs.writeFileSync(stdoutPath, res.stdout || '');
      fs.writeFileSync(stderrPath, res.stderr || res.error?.message || '');
      return res;
    };
    const probeResult = invoke(probeArgv(armDir, SMOKE_MODEL),
      path.join(rawDir, `probe-${arm}.jsonl`), path.join(rawDir, `probe-${arm}.stderr`));
    const probe = parseProbe(probeResult.stdout, armDir);
    const owners = probe.plugins.filter((p) => p.name === owner);
    check('probe init owner plugin', !probe.error && owners.length === 1 &&
      owners[0].source === `${owner}@inline` && owners[0].path === probe.armPath,
    probe.error || `expected one ${owner}@inline at ${probe.armPath}; got ${show(owners)}`);

    const legDir = path.join(rawDir, `${i + 1}-${arm}`);
    fs.mkdirSync(legDir);
    // Invalid models intentionally exit nonzero. Validate the resulting contract instead.
    // Eval legs need an invalid judge too; probes refuse --judge-model.
    invoke([...legArgv(armDir, 1, caseName, legDir, SMOKE_MODEL), '--judge-model', SMOKE_MODEL],
      path.join(legDir, 'stdout.txt'), path.join(legDir, 'stderr.txt'));
    const aggregatePath = path.join(legDir, 'aggregate-result.json');
    check('aggregate exists', fs.existsSync(aggregatePath), aggregatePath);
    let aggregate, parseError;
    try { aggregate = JSON.parse(fs.readFileSync(aggregatePath, 'utf8')); }
    catch (err) { parseError = err.message; }
    const cases = aggregate?.cases;
    check('cases.length === 1', Array.isArray(cases) && cases.length === 1, show(cases?.length));
    check('cases[0].name === caseName', cases?.[0]?.name === caseName, `expected ${caseName}; got ${show(cases?.[0]?.name)}`);
    // buildArms patches this designated case to the frozen rule's cap, including in smoke.
    check('cases[0].maxTurns === 4', cases?.[0]?.maxTurns === 4, show(cases?.[0]?.maxTurns));
    const plugins = aggregate?.suite?.plugins;
    check('suite.plugins owner and arm path', Array.isArray(plugins) && plugins.length === 1 &&
      plugins[0]?.name === owner && plugins[0]?.path === armDir,
    `expected only ${owner} at ${armDir}; got ${show(plugins)}`);
    check('costUsd === 0', aggregate?.costUsd === 0, `costUsd: ${show(aggregate?.costUsd)}`);
    let leg;
    try { leg = fromPluginEval(aggregate, { seq: i + 1, arm, caseName }); }
    catch (err) { parseError = parseError || err.message; }
    check('fromPluginEval parses aggregate', Boolean(leg), parseError || `${leg.runs.length} run(s)`);
    check('every run has error: true', Boolean(leg) && leg.runs.every((r) => r.error === true),
      leg ? show(leg.runs.map((r) => ({ error: r.error }))) : 'no parsed runs');
  }
  return pass;
}

module.exports = { SMOKE_MODEL, runSmoke };
