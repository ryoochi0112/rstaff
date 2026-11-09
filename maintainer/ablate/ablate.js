'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildArms, resolveSkill, sha256, treeHash } = require('./arms.js');
const { runSequence, runShakeout, parseProbe } = require('./sequence.js');
const { runSmoke } = require('./smoke.js');
const { writeTicket, writeCertificate } = require('./ticket.js');
const { fromLegacyRunner } = require('./adapters.js');
const { runAnalyst } = require('./analyst.js');
const { adjudicate } = require('./lib-adjudicate.js');

function parseArgs(argv) {
  const usage = 'usage: ablate.js --skill <s> [--out <dir>] [--stop-after freeze | --shakeout | --contract-smoke | --analyst-check <outcomes.json|raw-dir> --legacy] | --replay <outcomes.json|raw-dir> --legacy';
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (opts[flag] !== undefined) throw new Error(usage);
    if (['--shakeout', '--contract-smoke', '--legacy'].includes(flag)) { opts[flag] = true; i += 1; continue; }
    if (!['--skill', '--out', '--stop-after', '--replay', '--analyst-check'].includes(flag) || argv[i + 1] === undefined) throw new Error(usage);
    opts[flag] = argv[i + 1];
    i += 2;
  }
  if (opts['--replay']) {
    if (!opts['--legacy'] || Object.keys(opts).some(k => !['--replay', '--legacy'].includes(k))) throw new Error('--replay requires --legacy and is exclusive');
    return { replay: opts['--replay'], legacy: true };
  }
  if (opts['--analyst-check'] !== undefined) {
    if (!opts['--analyst-check'] || !opts['--legacy']) throw new Error('--analyst-check requires a non-empty input and --legacy');
    if (opts['--contract-smoke'] || opts['--shakeout'] || opts['--stop-after'] !== undefined) throw new Error('--analyst-check is exclusive with --contract-smoke, --shakeout and --stop-after');
  } else if (opts['--legacy']) throw new Error('--legacy requires --replay or --analyst-check');
  if (!opts['--skill']) throw new Error('--skill is required');
  if (opts['--contract-smoke'] && (opts['--shakeout'] || opts['--stop-after'] !== undefined)) throw new Error('--contract-smoke is exclusive with --shakeout and --stop-after');
  if (opts['--stop-after'] !== undefined && opts['--stop-after'] !== 'freeze') throw new Error('--stop-after must be freeze');
  if (opts['--stop-after'] !== undefined && opts['--shakeout']) throw new Error('--stop-after and --shakeout are exclusive');
  if (opts['--out'] === '') throw new Error('--out must be non-empty');
  return { skill: opts['--skill'], out: opts['--out'], stopAfter: opts['--stop-after'], shakeout: Boolean(opts['--shakeout']), contractSmoke: Boolean(opts['--contract-smoke']), analystCheck: opts['--analyst-check'] };
}

function preflight(skill, outDir, repoRoot = process.cwd()) {
  // lstat also refuses a dangling symlink at the requested output path.
  for (const target of [outDir, `${outDir}.md`]) {
    try {
      fs.lstatSync(target);
      throw new Error(`Output path already exists: ${target}`);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  const info = resolveSkill(skill, repoRoot);
  const rulePath = path.join(repoRoot, 'maintainer', 'ablate', 'rule.md');
  const ruleHash = sha256(fs.readFileSync(rulePath));
  return { ...info, rulePath, ruleHash };
}

function commandHash(dir = __dirname) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  return sha256(files.map((f) => `${sha256(fs.readFileSync(path.join(dir, f)))}  ${f}\n`).join(''));
}

function recheckGuardrails(frozen) {
  const changed = [];
  const compare = (name, read, expected) => {
    try { if (read() !== expected) changed.push(name); }
    catch { changed.push(name); }
  };
  compare('rule', () => sha256(fs.readFileSync(frozen.rule_path)), frozen.rule_hash);
  compare('command', () => commandHash(path.dirname(frozen.command_path)), frozen.command_hash);
  for (const [dir, hash] of Object.entries(frozen.case_files)) compare(`case ${dir}`, () => treeHash(dir), hash);
  for (const [arm, data] of Object.entries(frozen.arms)) compare(`arm ${arm}`, () => treeHash(data.dir), data.treeHash);
  return { breached: changed.length > 0, changed };
}

function freezeRecord(ctx, env = process.env) {
  const recordPath = `${ctx.outDir}.md`;
  const commandPath = __filename;
  const caseDirs = [path.dirname(path.join(ctx.pluginDir, ctx.caseRel)),
    ...Object.values(ctx.arms).map((a) => path.dirname(path.join(a.dir, ctx.caseRel)))];
  const frozen = {
    registered_at: new Date().toISOString(),
    ...(ctx.mode ? { mode: ctx.mode } : {}),
    skill: ctx.skill,
    case: ctx.case,
    model: 'haiku',
    cap: 4,
    judge: 'haiku',
    rule_path: ctx.rulePath,
    rule_hash: ctx.ruleHash,
    case_path: ctx.caseRel,
    case_hash: ctx.caseHash,
    command_path: commandPath,
    command_hash: commandHash(path.dirname(commandPath)),
    case_files: Object.fromEntries(caseDirs.map((dir) => [dir, treeHash(dir)])),
    arms: ctx.arms,
  };
  const registration = writeTicket(ctx, frozen);
  fs.writeFileSync(recordPath, `# Ablation: ${ctx.skill}\n\nstatus: FROZEN\n${ctx.mode ? `mode: ${ctx.mode}\n` : ''}ticket: ${registration.ticketPath}\nharness_certificate: ${registration.certificatePath}\nregistration_hash: ${registration.registrationHash}\n\n\`\`\`json\n${JSON.stringify(frozen, null, 2)}\n\`\`\`\n`, { flag: 'wx' });
  if (env.RSTAFF_ABLATE_TRACE) fs.appendFileSync(env.RSTAFF_ABLATE_TRACE, 'record-frozen\n');
  return { recordPath, frozen, registration };
}

function ownerName(armDir) {
  try { return JSON.parse(fs.readFileSync(path.join(armDir, '.claude-plugin', 'plugin.json'), 'utf8')).name || path.basename(armDir); }
  catch { return path.basename(armDir); }
}

function counts(outcome) {
  const passes = (pred) => {
    const runs = outcome.legs.filter(pred).flatMap((l) => l.runs);
    return { p: runs.filter((r) => r.judgePass === true && r.error === false).length, t: runs.length };
  };
  const k = passes((l) => l.arm === 'known-fail');
  const n = passes((l) => l.arm === 'null');
  const f = passes((l) => l.arm === 'full' && l.seq <= 9);
  const b = passes((l) => l.arm === 'full' && l.seq > 9);
  const p = passes((l) => l.arm === 'placebo');
  const diff = p.p - f.p;
  return `K ${k.p}/${k.t} · N ${n.p}/${n.t} · F ${f.p}/${f.t} · F-bridge ${b.p}/${b.t} · P ${p.p}/${p.t} · P−F = ${diff < 0 ? `−${-diff}` : diff}`;
}

// Save counts and instrument evidence before the fresh analyst reads the record.
function writeResult(recordPath, outcome) {
  const result = adjudicate(outcome);
  const lines = ['', '## Run result', ''];
  if (outcome.stopped) {
    lines.push(`stopped: ${outcome.stopped.gate}`, `failing: ${outcome.stopped.failing.join(', ')}`);
  } else {
    lines.push('stopped: no');
  }
  lines.push(counts(outcome), `guardrails: ${JSON.stringify(outcome.guardrails)}`);
  for (const [id, c] of Object.entries(result.checks)) lines.push(`${id} ${c.status} · ${c.detail}`);
  fs.appendFileSync(recordPath, lines.join('\n') + '\n');
  return result;
}

function shakeout(opts, outDir, repoRoot) {
  const info = preflight(opts.skill, outDir, repoRoot);
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.mkdirSync(outDir);
  const built = buildArms(opts.skill, outDir, { repoRoot });
  const r = runShakeout({ arms: built.arms, case: info.case, caseName: info.caseName, owner: ownerName(built.arms.full.dir), rawDir: path.join(outDir, 'raw') });
  const show = (v) => (v === null ? 'missing' : `${v}/3`);
  const diff = r.F === null || r.N === null ? 'n/a' : r.F - r.N;
  console.log(`shakeout ${opts.skill} · F ${show(r.F)} · N ${show(r.N)} · F − N = ${diff} · ${r.go ? 'go' : 'no-go'}`);
  console.log(`background: ${r.backgroundPlugins.length} non-arm plugins; raw: ${path.join(outDir, 'raw')}`);
  return r.go ? 0 : 1;
}

function contractSmoke(opts, outDir, repoRoot, env) {
  try {
    const info = preflight(opts.skill, outDir, repoRoot);
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.mkdirSync(outDir);
    const built = buildArms(opts.skill, outDir, { repoRoot });
    return runSmoke({ arms: built.arms, caseName: info.caseName, owner: ownerName(built.arms.full.dir),
      rawDir: path.join(outDir, 'raw'), env }) ? 0 : 1;
  } catch (err) {
    console.error(`ablate: contract smoke FAIL · ${err.message}`);
    return 1;
  }
}

function loadLegacyOutcomes(input) {
  let outcome;
  if (fs.statSync(input).isDirectory()) {
    const legs = fs.readdirSync(input).flatMap(file => {
      const match = file.match(/^(\d+)-(known-fail|null|full|placebo)\.json$/);
      return match ? [fromLegacyRunner(JSON.parse(fs.readFileSync(path.join(input, file))), { seq: Number(match[1]), arm: match[2] })] : [];
    }).sort((a, b) => a.seq - b.seq);
    const probes = { pre: {}, post: {} };
    for (const file of fs.readdirSync(input)) {
      const match = file.match(/^probe-(pre|post)-(known-fail|null|full|placebo)\.jsonl$/);
      if (!match) continue;
      const armPath = `arms/${match[2]}`;
      const probe = parseProbe(fs.readFileSync(path.join(input, file), 'utf8'), armPath);
      probes[match[1]][match[2]] = { models: probe.models,
        rstaffPlugins: probe.plugins.filter(p => /^rstaff(?:-|$)/.test(p.name)),
      };
    }
    outcome = { legacy: true, legs, probes };
  } else outcome = { ...JSON.parse(fs.readFileSync(input)), legacy: true };
  return outcome;
}

function replay(input) {
  const outcome = loadLegacyOutcomes(input);
  const result = adjudicate(outcome);
  const passed = arm => outcome.legs.filter(l => l.arm === arm && (arm !== 'full' || l.seq <= 9)).flatMap(l => l.runs).filter(r => r.judgePass && !r.error).length;
  const f = passed('full'), p = passed('placebo');
  const reasons = ['any check fails, or any guardrail is breached', `${p} >= ${f}-2`, `${p} <= ${f}-6`, `${f}-6 < ${p} < ${f}-2`];
  console.log(counts(outcome));
  console.log(Object.entries(result.checks).map(([id, c]) => `${id} ${c.status}`).join(' · '));
  console.log(`verdict: ${result.verdict} (row ${result.row}: ${reasons[result.row - 1]})`);
  return 0;
}

function finalize(ctx, record, outcome) {
  const { outDir } = ctx;
  outcome.registration_hash = record.registration.registrationHash;
  outcome.registered_at = record.frozen.registered_at;
  outcome.guardrails = recheckGuardrails(record.frozen);
  outcome.guardrailsBreached = outcome.guardrails.breached;
  fs.writeFileSync(path.join(outDir, 'outcomes.json'), JSON.stringify(outcome, null, 2) + '\n');
  const result = writeResult(record.recordPath, outcome);
  writeCertificate(outDir, record.frozen, record.registration, outcome, result);
  const analyst = runAnalyst(record.recordPath, path.join(outDir, 'raw'), outDir);
  const verdict = analyst.verdict === 'NO-VERDICT' ? 'NO-VERDICT'
    : analyst.verdict === result.verdict ? analyst.verdict : 'MISMATCH';
  fs.appendFileSync(record.recordPath, `\n## Final adjudication\n\nproposed_verdict: ${result.verdict}\nproposed_row: ${result.row}\nadjudicated_by: rstaff-ai:experiment-analyst\nanalyst_transcript: ${analyst.transcriptPath}\nmatched_row: ${result.row}\nanalyst_verdict: ${analyst.verdict}\nverdict: ${verdict}\n`);
  const passes = (arm) => outcome.legs.filter((l) => l.arm === arm && (arm !== 'full' || l.seq <= 9))
    .flatMap((l) => l.runs).filter((r) => r.judgePass === true && r.error === false).length;
  const f = passes('full'), p = passes('placebo');
  const reasons = ['any check fails, or any guardrail is breached', `${p} >= ${f}-2`, `${p} <= ${f}-6`, `${f}-6 < ${p} < ${f}-2`];
  const gloss = { 'INVALID-HARNESS': 'instrument invalid; repair harness', ACCEPT: 'body does not beat placebo on haiku; cut candidate',
    REJECT: 'body load-bearing on haiku; keep', INCONCLUSIVE: 'body effect inconclusive on haiku',
    MISMATCH: 'analyst and core disagree; human decides', 'NO-VERDICT': 'analyst returned no verdict; human decides' };
  console.log(`ablate ${ctx.skill} · haiku · case ${ctx.case} · rule ${ctx.ruleHash.slice(0, 8)}`);
  console.log(counts(outcome));
  console.log(Object.entries(result.checks).map(([id, c]) => `${id} ${c.status}`).join(' · '));
  console.log(`verdict: ${verdict} (row ${result.row}: ${reasons[result.row - 1]}) — ${gloss[verdict]}`);
  console.log('adjudicated_by: experiment-analyst (fresh context)');
  console.log(`record: ${record.recordPath}`);
  return ['MISMATCH', 'NO-VERDICT'].includes(verdict) ? 3 : verdict === 'INVALID-HARNESS' && !ctx.mode ? 1 : 0;
}

function main(argv, env = process.env) {
  try {
    const opts = parseArgs(argv);
    if (opts.replay) return replay(opts.replay);
    const repoRoot = process.cwd();
    const prefix = opts.analystCheck ? 'analyst-check' : 'body-ablation';
    const outDir = path.resolve(opts.out || path.join(repoRoot, 'var', 'experiments', 'rstaff', `${prefix}-${opts.skill}-${new Date().toISOString().slice(0, 10)}`));
    if (opts.contractSmoke) return contractSmoke(opts, `${outDir}-smoke`, repoRoot, env);
    if (opts.shakeout) return shakeout(opts, `${outDir}-shakeout`, repoRoot);
    const info = preflight(opts.skill, outDir, repoRoot);
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    // Reserve atomically: a competing invocation must not reuse these arms.
    fs.mkdirSync(outDir);
    const built = buildArms(opts.skill, outDir, { repoRoot });
    const ctx = { ...info, ...built, skill: opts.skill, outDir,
      ...(opts.analystCheck ? { mode: 'analyst-contract-check (replayed legacy evidence; not a live registration)' } : {}) };
    const record = freezeRecord(ctx, env);
    console.log(`ablate ${opts.skill} · haiku · case ${info.case} · rule ${info.ruleHash.slice(0, 8)}`);
    console.log(`record: ${record.recordPath}`);
    if (opts.stopAfter === 'freeze') return 0;
    if (opts.analystCheck) {
      const input = path.resolve(opts.analystCheck);
      const outcome = loadLegacyOutcomes(input);
      const rawDir = path.join(outDir, 'raw');
      fs.mkdirSync(rawDir);
      fs.cpSync(input, fs.statSync(input).isDirectory() ? rawDir : path.join(rawDir, path.basename(input)), { recursive: true });
      return module.exports.finalize(ctx, record, outcome);
    }
    const runStartedAt = new Date().toISOString();
    const outcome = runSequence({
      arms: built.arms, case: info.case, caseName: info.caseName, owner: ownerName(built.arms.full.dir), rawDir: path.join(outDir, 'raw'), env,
      // Ruling A: the pre-probe background is frozen into the record before the first leg.
      onBackground: (keys) => fs.appendFileSync(record.recordPath,
        `\n## Probe background (frozen at pre probe)\n\nbackground_plugins:\n\`\`\`json\n${JSON.stringify(keys, null, 2)}\n\`\`\`\n`),
    });
    outcome.run_started_at = runStartedAt;
    outcome.run_completed_at = new Date().toISOString();
    return module.exports.finalize(ctx, record, outcome);
  } catch (err) {
    console.error(`ablate: ${err.message}`);
    return 2;
  }
}

module.exports = { main, parseArgs, preflight, freezeRecord, commandHash, recheckGuardrails, finalize };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
