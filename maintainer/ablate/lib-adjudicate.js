'use strict';

const RULE = Object.freeze({
  kRuns: 5, armRuns: 20, bridgeRuns: 6, fullTotal: 26,
  knownFailMax: 1, fullMin: 16, sensitivityMin: 6, driftSlack: 2,
  acceptMargin: 2, rejectMargin: 6, cap: 4, judge: 'haiku',
  errorBudgets: Object.freeze({'known-fail': 1, null: 2, full: 2, placebo: 2}),
});
const ARMS = Object.keys(RULE.errorBudgets);
const check = (pass, detail) => ({status: pass ? 'PASS' : 'FAIL', detail});
const count = runs => ({total: runs.length, passes: runs.filter(r => r.judgePass === true && r.error === false).length, errors: runs.filter(r => r.error !== false).length});
function groups(outcomes, stageOnly = false) {
  const legs = outcomes.legs || [];
  const runs = (arm, bridge = false) => legs.filter(l => l.arm === arm && (arm !== 'full' || (Number(l.seq) > 9) === bridge) && (!stageOnly || Number(l.seq) <= 9)).flatMap(l => l.runs || []);
  return {K: count(runs('known-fail')), N: count(runs('null')), F: count(runs('full')), P: count(runs('placebo')), B: count(runs('full', true))};
}
function primary(g) {
  return {
    C1: check(g.K.total === RULE.kRuns && g.K.passes <= RULE.knownFailMax, `K ${g.K.passes}/${g.K.total}; maximum ${RULE.knownFailMax}/${RULE.kRuns}`),
    C2: check(g.F.total === RULE.armRuns && g.F.passes >= RULE.fullMin, `F ${g.F.passes}/${g.F.total}; minimum ${RULE.fullMin}/${RULE.armRuns}`),
    C3: check(g.N.total === RULE.armRuns && g.F.total === RULE.armRuns && g.F.passes - g.N.passes >= RULE.sensitivityMin, `F − N = ${g.F.passes - g.N.passes}; minimum ${RULE.sensitivityMin}; N ${g.N.passes}/${g.N.total}`),
  };
}
function errors(g, stageOnly = false) {
  const counts = stageOnly ? {null: g.N, full: g.F} : {'known-fail': g.K, null: g.N, full: {total: g.F.total + g.B.total, errors: g.F.errors + g.B.errors}, placebo: g.P};
  const totals = {'known-fail': RULE.kRuns, null: RULE.armRuns, full: stageOnly ? RULE.armRuns : RULE.fullTotal, placebo: RULE.armRuns};
  return check(Object.entries(counts).every(([arm, c]) => c.total === totals[arm] && c.errors <= RULE.errorBudgets[arm]), Object.entries(counts).map(([arm, c]) => `${arm} ${c.errors} errors/${c.total}; budget ${RULE.errorBudgets[arm]}/${totals[arm]}`).join('; '));
}
function gate(checks, ids) {
  const failing = ids.filter(id => checks[id].status === 'FAIL');
  return {pass: failing.length === 0, failing};
}
function gate1(outcomes) { return gate(primary(groups(outcomes, true)), ['C1']); }
function gate2(outcomes) {
  const g = groups(outcomes, true);
  return gate({...primary(g), C5: errors(g, true)}, ['C2', 'C3', 'C5']);
}
// Probe plugins that are not the arm, as sorted name@source keys (paths dropped).
function backgroundOf(probe) {
  return (probe?.plugins || []).filter(p => !(typeof probe.armPath === 'string' && p?.path === probe.armPath))
    .map(p => `${p?.name}@${p?.source}`).sort();
}
// Ruling A: the arm is the sole owner-named plugin, and everything else equals the frozen background.
function probeIsolated(p, owner, frozen) {
  if (typeof owner !== 'string' || !owner || !Array.isArray(frozen) || !Array.isArray(p?.plugins)) return false;
  if (typeof p.armPath !== 'string' || !p.armPath) return false;
  const named = p.plugins.filter(x => x?.name === owner);
  if (named.length !== 1 || named[0].path !== p.armPath) return false;
  const background = backgroundOf(p);
  const expected = frozen.map(String).sort();
  return background.length === expected.length && background.every((k, i) => k === expected[i]);
}
// Legacy runner probes carry one rstaff plugin whose path ends in the arm name.
function legacyIsolated(arm, p) {
  if (p?.rstaffPlugins?.length !== 1) return false;
  const plugin = p.rstaffPlugins[0];
  if (!plugin || typeof plugin.path !== 'string') return false;
  return p.armPath ? plugin.path === p.armPath : plugin.path.replace(/\/$/, '').split('/').at(-1) === arm;
}
function adjudicate(outcomes) {
  const g = groups(outcomes);
  const pre = outcomes.probes?.pre || {};
  const post = outcomes.probes?.post || {};
  const probes = [...Object.entries(pre), ...Object.entries(post)];
  const complete = ARMS.every(arm => pre[arm]) && Boolean(post.full);
  const probeIds = [...Object.keys(pre).map(a => `pre/${a}`), ...Object.keys(post).map(a => `post/${a}`)];
  const isolated = probes.map(([arm, p]) => ARMS.includes(arm) && (outcomes.legacy === true && !Array.isArray(p?.plugins)
    ? legacyIsolated(arm, p) : probeIsolated(p, outcomes.owner, outcomes.backgroundPlugins)));
  const isolation = complete && isolated.every(Boolean);
  const notIsolated = probeIds.filter((_, i) => !isolated[i]);
  const model = pre.full?.models?.[0];
  const stable = complete && typeof model === 'string' && model.length > 0 && probes.every(([, p]) => p.models?.length === 1 && p.models[0] === model);
  const driftMin = Math.ceil(RULE.bridgeRuns * g.F.passes / RULE.armRuns) - RULE.driftSlack;
  const runs = (outcomes.legs || []).flatMap(l => l.runs || []);
  const missingText = runs.filter(r => r.error === false && (typeof r.subjectText !== 'string' || !r.subjectText.trim())).length;
  const checks = {
    ...primary(g),
    C4: outcomes.legacy === true && probes.every(([, p]) => !Array.isArray(p?.plugins))
      ? check(isolation, `${probes.length} probes; exactly one rstaff plugin from each arm required (legacy probes)`)
      : check(isolation, `${probes.length} probes; exactly one ${outcomes.owner || '(owner missing)'} plugin from its arm and a non-arm set equal to the frozen background (${Array.isArray(outcomes.backgroundPlugins) ? outcomes.backgroundPlugins.length : 'missing'}) required${complete ? '' : '; pre/post probes incomplete'}${notIsolated.length ? `; failing ${notIsolated.join(', ')}` : ''}`),
    C5: errors(g),
    C6: check(stable, `pre/post model ${model || 'missing'}; same single resolved id required`),
    C7: check(g.B.total === RULE.bridgeRuns && g.B.passes >= driftMin, `F bridge ${g.B.passes}/${g.B.total}; minimum ceil(${RULE.bridgeRuns}·${g.F.passes}/${RULE.armRuns}) − ${RULE.driftSlack} = ${driftMin}`),
    C8: outcomes.legacy === true ? {status: 'N/A', detail: 'legacy data, subject text not captured'} : check(missingText === 0, `${missingText} non-error runs missing subject reply`),
  };
  // Hash comparison belongs to the orchestrator; an explicit breach invalidates its result.
  const breached = outcomes.guardrailsBreached === true || outcomes.guardrails?.breached === true;
  const row = Object.values(checks).some(c => c.status === 'FAIL') || breached ? 1
    : g.P.passes >= g.F.passes - RULE.acceptMargin ? 2
      : g.P.passes <= g.F.passes - RULE.rejectMargin ? 3 : 4;
  return {checks, row, verdict: ['INVALID-HARNESS', 'ACCEPT', 'REJECT', 'INCONCLUSIVE'][row - 1]};
}
module.exports = {RULE, adjudicate, gate1, gate2, backgroundOf, probeIsolated};
