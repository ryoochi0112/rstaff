#!/usr/bin/env node
'use strict';
// Test-only stand-in for `claude`, placed on PATH by the ablate tests.
// It appends one trace line per call to $RSTAFF_ABLATE_TRACE and replays the
// scripted results in the scenario JSON named by $ABLATE_SHIM_SCENARIO.
//   probe <arm> <argv-json>      for `claude -p ... --plugin-dir <armDir>`
//   leg <arm> <n> <argv-json>    for `claude plugin eval <armDir> ... --runs <n>`
// Scenario keys (all optional):
//   init.model, init.background[]   the init event (arm plugin added from --plugin-dir)
//   probes["<arm>#<k>"].addBackground[]   extra plugins in the k-th probe of <arm>
//   legs.<arm>.passes / .errors      per-leg defaults (capped at --runs)
//   seq["<seq>"].passes / .errors    per-leg overrides by output-dir sequence
//   seq["<seq>"].returned / .exit    a partial result: only <returned> runs, then exit <exit>
//   broken["<seq>"] = <k>            the first k attempts of that leg write no usable JSON
// Fidelity rule: every shape below answers to the captures in test/fixtures/ablate/real/
// (see CAPTURE.md there), and test/maintainer/ablate-shim-fidelity.test.js compares key sets.
// The shim refuses what the real CLI refuses and never echoes its input back.
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const trace = process.env.RSTAFF_ABLATE_TRACE;
const scenario = process.env.ABLATE_SHIM_SCENARIO ? JSON.parse(fs.readFileSync(process.env.ABLATE_SHIM_SCENARIO, 'utf8')) : {};
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const armOf = (dir) => path.basename(path.dirname(path.resolve(dir)));
const prior = () => (trace && fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n') : []);
const log = (line) => { if (trace) fs.appendFileSync(trace, `${line}\n`); };
const SESSION = '00000000-0000-0000-0000-000000000000';

// Keys of the real `system/init` and `result` stream events (claude 2.1.292).
function initEvent({ model, plugins, agents }) {
  return {
    type: 'system', subtype: 'init', cwd: '/work', session_id: SESSION, tools: [], mcp_servers: [], model, permissionMode: 'auto',
    slash_commands: [], terminal_slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.292', output_style: 'Concise',
    agents: agents || [], skills: [], plugins, capabilities: [], analytics_disabled: false, product_feedback_disabled: false,
    uuid: SESSION, memory_paths: {}, scratchpad_path: '/work/scratchpad', messaging_socket_path: '/work/socket',
    fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required', per_turn_effort_active: false, view_mode: 'default',
  };
}
function resultEvent(text) {
  return {
    type: 'result', subtype: 'success', is_error: false, api_error_status: null, duration_ms: 1, duration_api_ms: 0, num_turns: 1,
    result: text, stop_reason: 'end_turn', session_id: SESSION, total_cost_usd: 0,
    usage: {}, modelUsage: {}, permission_denials: [], terminal_reason: 'completed', fast_mode_state: 'off',
    fast_mode_disabled_reason: 'sdk_opt_in_required', subagent_stats: {}, safety_stops: 0, uuid: SESSION,
    queued_turn_count: 0, result_index: 0,
  };
}
const BUILTINS = ['sec-default', 'agents-md', 'telemetry', 'plugin-authoring'].map((n) => ({ name: `cc-plugin-${n}`, path: 'builtin', source: `cc-plugin-${n}@builtin` }));

function findCases(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'case.yaml') found.push({ file: full, def: JSON.parse(fs.readFileSync(full, 'utf8')) });
    }
  };
  walk(path.join(root, 'evals'));
  return found;
}

// Real -p rejects this eval-only flag before emitting any stream events (see CAPTURE.md).
if (argv[0] === '-p' && argv.includes('--judge-model')) {
  process.stderr.write("error: unknown option '--judge-model'\n");
  process.exit(1);
}

if (argv.includes('--agent')) {
  if (process.env.ABLATE_SHIM_ARGV_LOG) fs.appendFileSync(process.env.ABLATE_SHIM_ARGV_LOG, JSON.stringify(argv) + '\n');
  const prompt = argv.at(-1);
  const rawSuffix = /\.md (.*\/raw)$/.exec(prompt);
  // Paths can contain spaces: the output directory is the raw path without /raw.
  const outDir = rawSuffix ? rawSuffix[1].slice(0, -4) : null;
  if (outDir && fs.existsSync(`${outDir}.md`)) {
    fs.copyFileSync(`${outDir}.md`, path.join(outDir, 'analyst-record-snapshot.md'));
  }
  const text = scenario.analyst?.text ?? '## Experiment verdict: REJECT';
  const plugins = [{ name: 'rstaff-ai', path: flag('--plugin-dir') || '/work', source: 'rstaff-ai@inline', version: '0.0.0' }, ...BUILTINS];
  const events = [
    initEvent({ model: 'claude-haiku-shim', plugins, agents: ['rstaff-ai:experiment-analyst'] }),
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    resultEvent(text),
  ];
  process.stdout.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  process.exit(0);
}

if (argv[0] === 'plugin' && argv[1] === 'eval') {
  const armDir = argv[2];
  const arm = armOf(armDir);
  const n = Number(flag('--runs'));
  const outDir = flag('--output-dir');
  const seq = path.basename(path.resolve(outDir)).split('-')[0];
  const attempt = prior().filter((l) => l.startsWith('leg ') && JSON.parse(l.slice(l.indexOf('['))).includes(outDir)).length + 1;
  if (Number(seq) === 1 && arm === 'known-fail') {
    const root = path.dirname(path.dirname(path.resolve(outDir)));
    fs.copyFileSync(path.join(root, 'ticket.md'), path.join(root, 'first-leg-ticket.md'));
  }
  log(`leg ${arm} ${n} ${JSON.stringify(argv)}`);
  // The real CLI filters --case on the case.yaml `name` only (never the directory name).
  const wanted = flag('--case');
  const all = findCases(armDir);
  const match = wanted === undefined ? all[0] : all.find((c) => c.def.name === wanted);
  if (!match) {
    process.stderr.write(`No eval cases found matching --case "${wanted}" under ${armDir}.\nRun without --case to see all cases.\n`);
    process.exit(1);
  }
  const def = match.def;
  fs.mkdirSync(outDir, { recursive: true });
  const result = path.join(outDir, 'aggregate-result.json');
  if (attempt <= (scenario.broken?.[seq] || 0)) {
    if (attempt % 2 === 0) fs.writeFileSync(result, '{"cases": [truncated');
    process.exit(1);
  }
  const spec = { ...(scenario.legs?.[arm] || {}), ...(scenario.seq?.[seq] || {}) };
  const passes = Math.min(n, spec.passes ?? n);
  const errors = Math.min(n, spec.errors ?? 0);
  const runs = Array.from({ length: Math.min(n, spec.returned ?? n) }, (_, i) => {
    const error = i >= n - errors ? 'subject timed out' : null;
    const ok = !error && i < passes;
    const graders = def.graders.map((g) => ({
      name: g.name, passed: ok, weight: 1, explanation: ok ? 'scripted pass' : `grader threw: ${error || 'scripted fail'}`, withOnly: false, scored: true,
      ...(error ? {} : { evidence: `scripted reply ${i + 1}`, judgeVotes: [ok] }),
    }));
    return { score: ok ? 1 : 0, passed: ok, turns: 1, costUsd: 0, judgeCostUsd: 0, durationSeconds: 1, startedAt: new Date(0).toISOString(),
      error, tracePath: `${outDir}/trace.jsonl`, skippedPaidGraders: false, graders };
  });
  const score = runs.length ? runs.filter((r) => r.passed).length / runs.length : 0;
  const plugin = JSON.parse(fs.readFileSync(path.join(armDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  fs.writeFileSync(result, JSON.stringify({
    schemaVersion: 1, claudeVersion: '2.1.292', startedAt: new Date(0).toISOString(), durationSeconds: 1, costUsd: 0, partial: runs.length < n,
    suite: { root: armDir, ablation: flag('--ablation') || 'none', modelOverride: flag('--model') || null, judgeModel: flag('--judge-model') || null,
      caseFilter: wanted, threshold: 1, concurrency: 1, plugins: [{ name: plugin.name, version: plugin.version || '0.0.0', path: armDir }] },
    cases: [{
      name: def.name, dir: path.relative(armDir, path.dirname(match.file)), source: 'case_yaml', promptMarkdown: def.execution?.prompt || '',
      model: flag('--model') || 'haiku', runsPerCase: n, timeoutSeconds: def.execution?.timeout_seconds ?? 120, maxTurns: def.execution?.max_turns ?? 1,
      graders: def.graders.map((g) => ({ name: g.name, type: g.type, weight: 1, graderMarkdown: g.criteria || '', config: { criteria: g.criteria || '', focus: 'last_message' } })),
      arms: { with: runs }, aggregates: { score, passRate: score },
    }],
    aggregates: { casesTotal: 1, casesPassed: score >= 1 ? 1 : 0, overallScore: score, overallPassRate: score },
  }, null, 2));
  if (scenario.mutateArm && Number(seq) === 3) {
    fs.appendFileSync(path.join(armDir, scenario.mutateArm), '\nChanged mid-run.\n');
  }
  // The real CLI exits 1 when the case score is below --threshold (default 1.0).
  process.exit(score < 1 ? 1 : 0);
}

if (argv[0] === '-p') {
  const armDir = flag('--plugin-dir');
  const arm = armOf(armDir);
  const k = prior().filter((l) => l.startsWith(`probe ${arm} `)).length + 1;
  log(`probe ${arm} ${JSON.stringify(argv)}`);
  const owner = JSON.parse(fs.readFileSync(path.join(armDir, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  const init = scenario.init || {};
  const plugins = [{ name: owner, path: armDir, source: `${owner}@inline`, version: '0.0.0' },
    ...(init.background || []), ...(scenario.probes?.[`${arm}#${k}`]?.addBackground || [])];
  const events = [
    { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' },
    initEvent({ model: init.model || 'claude-haiku-shim', plugins }),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
    resultEvent('OK'),
  ];
  process.stdout.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  process.exit(0);
}

log(`other ${JSON.stringify(argv)}`);
process.exit(64);
