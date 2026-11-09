'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./arms.js');

function writeTicket(ctx, frozen) {
  const ticketPath = path.join(ctx.outDir, 'ticket.md');
  const certificatePath = path.join(ctx.outDir, 'certificate.json');
  const fields = {
    hypothesis: 'The skill body is load-bearing versus placebo.',
    null: 'The skill body is not load-bearing versus placebo.',
    primary_metric: 'Judge-only pass rate on the designated case; errors never pass.',
    estimand: 'P versus F (P minus F passes at 20 trials each); bridge excluded from primary metric.',
    practical_threshold: 'ACCEPT P >= F - 2; REJECT P <= F - 6; otherwise INCONCLUSIVE, after validity checks.',
    guardrails: 'Rule, case files, command and arm hashes must remain unchanged; any change is a breach.',
    control: { arm: 'full', tree_hash: frozen.arms.full.treeHash },
    candidate: { arm: 'placebo', tree_hash: frozen.arms.placebo.treeHash },
    intervention_surface: 'SKILL.md body only for F versus P; identical frontmatter and remaining plugin files. K replaces the body; N removes the skill directory as instrument controls.',
    sample_plan: { N_cases: 1, case: ctx.case, N_trials_per_case: { K: 5, N: 20, F: 20, 'F-bridge': 6, P: 20 } },
    pairing: 'Same case and batch, sealed interleaving: K5 N5 F5 F5 N5 N5 F5 F5 N5 P5 F3 P5 P5 F3 P5. F stage-1 controls and F bridges accompany P in this batch.',
    error_policy: 'Terminal errors stay in denominators: K <= 1/5, N <= 2/20, F <= 2/26, P <= 2/20. Missing/unparseable leg JSON gets one in-place re-run; second miss stops INVALID-HARNESS. Partial missing runs are errors, never excluded.',
    stopping_rule: 'Gate 1 after K checks C1; gate 2 after stage 1 checks C2/C3/C5. Failed gate stops INVALID-HARNESS; planned later runs are absent only under these gates or the missing-leg policy. No top-ups.',
    holdout_exposure: 'Public case; arms were built before the runs. No hidden-holdout claim.',
    adjudicator: 'rstaff-ai:experiment-analyst, fresh read-only context; change author is not adjudicator.',
    harness_certificate_id: certificatePath,
    rule_hash: frozen.rule_hash,
    registered_at: frozen.registered_at,
    bound_hashes: frozen,
    evidence: { outcomes: path.join(ctx.outDir, 'outcomes.json'), raw: path.join(ctx.outDir, 'raw'), grades: path.join(ctx.outDir, 'grades.json') },
  };
  // Hash the exact UTF-8 bytes excluding the entire registration_hash line,
  // including the final newline. Appending that line avoids a self-reference.
  const content = `# Frozen ablation ticket\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\`\n\n${fs.readFileSync(ctx.rulePath, 'utf8')}`;
  const registrationHash = sha256(content);
  fs.writeFileSync(ticketPath, `${content}registration_hash: ${registrationHash}\n`, { flag: 'wx' });
  return { ticketPath, certificatePath, registrationHash };
}

function writeCertificate(outDir, frozen, registration, outcome, result) {
  const failing = Object.entries(result.checks).filter(([id, c]) => id !== 'C8' && c.status !== 'PASS').map(([id]) => id);
  if (outcome.guardrailsBreached) failing.push('guardrails');
  const fixtureResults = {};
  for (const [id, arm, bridge] of [['K', 'known-fail', false], ['N', 'null', false], ['F', 'full', false], ['F-bridge', 'full', true]]) {
    const runs = outcome.legs.filter(l => l.arm === arm && (arm !== 'full' || (l.seq > 9) === bridge)).flatMap(l => l.runs);
    fixtureResults[id] = { passes: runs.filter(r => r.judgePass && !r.error).length, total: runs.length, errors: runs.filter(r => r.error !== false).length };
  }
  // Native plugin eval has aggregate-result.json rather than grades.json.
  // This receipt binds the normalized evidence and the frozen case/grader config.
  const grades = { hashes: { grader: frozen.case_hash, cases: frozen.case_hash },
    registration_hash: registration.registrationHash, registered_at: frozen.registered_at,
    run_started_at: outcome.run_started_at, run_completed_at: outcome.run_completed_at,
    raw_hashes: Object.fromEntries(fs.readdirSync(path.join(outDir, 'raw'), { recursive: true }).filter(file => fs.statSync(path.join(outDir, 'raw', file)).isFile()).sort().map(file => [file, sha256(fs.readFileSync(path.join(outDir, 'raw', file)))])),
    outcomes_hash: sha256(fs.readFileSync(path.join(outDir, 'outcomes.json'))) };
  fs.writeFileSync(path.join(outDir, 'grades.json'), JSON.stringify(grades, null, 2) + '\n');
  const cert = {
    id: registration.certificatePath, status: failing.length ? 'invalid' : 'valid', failing_ids: failing,
    certified_at: new Date().toISOString(), registered_at: frozen.registered_at, registration_hash: registration.registrationHash,
    rule_hash: frozen.rule_hash, cases_manifest_hash: frozen.case_hash, case_files: frozen.case_files,
    command_hash: frozen.command_hash, arms: frozen.arms,
    graders: [{ impl_hash: frozen.case_hash, definition: frozen.case_path, hash_scope: 'Native plugin-eval grader configuration in the bound case file; runner normalization bound by command_hash.' }],
    judge: { model: 'haiku', prompt_and_decoding: 'Native plugin-eval LLM graders from bound case files; default decoding.' },
    subject_model_id: outcome.probes.pre.full?.models?.[0] ?? null,
    tool_env_mirror: 'Arm plugin trees and frozen non-arm probe background', background_plugins: outcome.backgroundPlugins,
    runtime: { command_hash: frozen.command_hash, node: process.version },
    fixture_results: fixtureResults, checks: result.checks, guardrails: outcome.guardrails, evidence: grades,
  };
  fs.writeFileSync(registration.certificatePath, JSON.stringify(cert, null, 2) + '\n');
}

module.exports = { writeTicket, writeCertificate };
