'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { adjudicate, gate1, gate2, RULE, backgroundOf } = require('../../maintainer/ablate/lib-adjudicate');
const adapters = require('../../maintainer/ablate/adapters');
const arms = ['known-fail', 'null', 'full', 'placebo'];
const BACKGROUND = [
  {name: 'superpowers', source: 'superpowers@superpowers-marketplace', path: '/opt/plugins/superpowers'},
  {name: 'rstaff', source: 'rstaff@rstaff', path: '/opt/plugins/rstaff'},
  {name: 'cc-plugin-telemetry', source: 'cc-plugin-telemetry@builtin', path: 'builtin'}];
const FROZEN = ['cc-plugin-telemetry@cc-plugin-telemetry@builtin', 'rstaff@rstaff@rstaff', 'superpowers@superpowers@superpowers-marketplace'];
function sample(p = 13, f = 19, n = 5, bridge = 5) {
  const runs = (size, passes) => Array.from({length: size}, (_, i) => ({judgePass: i < passes, error: false, subjectText: 'reply'}));
  const probe = arm => ({models: ['haiku-id'], armPath: `/arms/${arm}/rstaff-pm`, plugins: [
    {name: 'rstaff-pm', source: 'rstaff-pm@inline', path: `/arms/${arm}/rstaff-pm`}, ...BACKGROUND.map(p => ({...p}))]});
  return {legacy: false, owner: 'rstaff-pm', backgroundPlugins: FROZEN.slice(), probes: {pre: Object.fromEntries(arms.map(a => [a, probe(a)])), post: {full: probe('full')}}, legs: [
    {seq: 1, arm: 'known-fail', runs: runs(5, 0)}, {seq: 2, arm: 'null', runs: runs(20, n)},
    {seq: 3, arm: 'full', runs: runs(20, f)}, {seq: 10, arm: 'placebo', runs: runs(20, p)},
    {seq: 11, arm: 'full', runs: runs(6, bridge)}]};
}
test('rule constants match every numeric threshold in frozen prose', () => {
  const rule = fs.readFileSync(path.join(__dirname, '../../maintainer/ablate/rule.md'), 'utf8');
  const match = re => {const m = rule.match(re); assert.ok(m, String(re)); return m.slice(1).map(Number);};
  assert.deepEqual(match(/K passes ≤ (\d+)\/(\d+)/), [RULE.knownFailMax, RULE.kRuns]);
  assert.deepEqual(match(/F ≥ (\d+)\/(\d+)/), [RULE.fullMin, RULE.armRuns]);
  assert.deepEqual(match(/F − N ≥ (\d+)/), [RULE.sensitivityMin]);
  assert.deepEqual(match(/K (\d+)\/5, N (\d+)\/20, F (\d+)\/(\d+), P (\d+)\/20/), [RULE.errorBudgets['known-fail'], RULE.errorBudgets.null, RULE.errorBudgets.full, RULE.fullTotal, RULE.errorBudgets.placebo]);
  assert.deepEqual(match(/ceil\((\d+)·F\/(\d+)\) − (\d+)/), [RULE.bridgeRuns, RULE.armRuns, RULE.driftSlack]);
  assert.deepEqual(match(/P ≥ F − (\d+)/), [RULE.acceptMargin]);
  assert.deepEqual(match(/P ≤ F − (\d+)/), [RULE.rejectMargin]);
  assert.deepEqual(match(/cap: (\d+)/), [RULE.cap]); assert.match(rule, new RegExp(`judge: ${RULE.judge}`));
});
for (const [p, row, verdict] of [[17, 2, 'ACCEPT'], [13, 3, 'REJECT'], [16, 4, 'INCONCLUSIVE'], [14, 4, 'INCONCLUSIVE']]) {
  test(`decision boundary P=${p}`, () => {const result = adjudicate(sample(p)); assert.equal(result.row, row); assert.equal(result.verdict, verdict);});
}
const failures = {
  C1: o => o.legs[0].runs.slice(0, 2).forEach(r => r.judgePass = true),
  C2: o => o.legs[2].runs.slice(15).forEach(r => r.judgePass = false),
  C3: o => o.legs[1].runs.slice(0, 14).forEach(r => r.judgePass = true),
  C4: o => o.probes.pre.null.plugins.push({name: 'rstaff-pm', source: 'rstaff-pm@rstaff', path: '/installed'}),
  C5: o => o.legs[3].runs.slice(17).forEach(r => r.error = true),
  C6: o => o.probes.post.full.models = ['different'],
  C7: o => o.legs[4].runs.slice(3).forEach(r => r.judgePass = false),
  C8: o => o.legs[0].runs[0].subjectText = null,
};
for (const [id, mutate] of Object.entries(failures)) test(`${id} fails row 1`, () => {
  const o = sample(); mutate(o); const r = adjudicate(o); assert.equal(r.checks[id].status, 'FAIL'); assert.equal(r.row, 1); assert.equal(r.verdict, 'INVALID-HARNESS');
});
test('C7 ceiling boundary and primary F excludes bridge', () => {
  assert.equal(adjudicate(sample(13, 17, 5, 4)).checks.C7.status, 'PASS');
  assert.equal(adjudicate(sample(13, 17, 5, 3)).checks.C7.status, 'FAIL');
});
for (const [arm, budget] of [['known-fail', 1], ['null', 2], ['full', 2], ['placebo', 2]]) test(`C5 ${arm} budget`, () => {
  const o = sample(); const runs = o.legs.filter(l => l.arm === arm).flatMap(l => l.runs).reverse();
  runs.slice(0, budget).forEach(r => r.error = true); assert.equal(adjudicate(o).checks.C5.status, 'PASS');
  runs[budget].error = true; assert.equal(adjudicate(o).checks.C5.status, 'FAIL');
});
test('gates inspect only their checks and stage-1 F/N errors', () => {
  const o = sample(); o.legs = o.legs.filter(l => l.seq <= 9); o.probes = {};
  assert.deepEqual(gate1(o), {pass: true, failing: []}); assert.deepEqual(gate2(o), {pass: true, failing: []});
  failures.C1(o); assert.deepEqual(gate1(o), {pass: false, failing: ['C1']});
  failures.C2(o); assert.deepEqual(gate2(o), {pass: false, failing: ['C2']});
  o.legs[1].runs.slice(17).forEach(r => r.error = true); assert.ok(gate2(o).failing.includes('C5'));
});
test('missing runs, probes, wrong arm paths and empty text fail closed', () => {
  for (const mutate of [o => o.legs = [], o => o.probes.pre = {}, o => o.probes.post = {}, o => o.probes.pre.full.plugins[0].path = '/arms/null/rstaff-pm', o => o.legs[0].runs[0].subjectText = '  ']) {
    const o = sample(); mutate(o); assert.equal(adjudicate(o).verdict, 'INVALID-HARNESS');
  }
});
test('legacy replay uses only checked-in fixture', () => {
  const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/ablate/v3-outcomes.json'), 'utf8');
  assert.equal(fixture.includes('/' + 'Users/'), false, 'fixture must not contain absolute home paths');
  const o = JSON.parse(fixture);
  const before = JSON.stringify(o); const r = adjudicate(o);
  assert.equal(r.verdict, 'REJECT'); assert.equal(r.row, 3);
  for (let i = 1; i <= 7; i++) assert.equal(r.checks[`C${i}`].status, 'PASS');
  assert.equal(r.checks.C8.status, 'N/A'); assert.equal(JSON.stringify(o), before);
  delete o.legacy; assert.equal(adjudicate(o).checks.C8.status, 'FAIL');
});
test('legacy adapter ignores predicate and aggregate verdict, counts terminal errors', () => {
  const json = {passed: false, cases: [{runs: [
    {status: 'failed', assertions: [{method: 'judge', passed: true}, {method: 'predicate', passed: false}]},
    {status: 'error', assertions: [{method: 'judge', passed: true}]},
    {status: 'passed', assertions: []}]}]};
  const leg = adapters.fromLegacyRunner(json, {seq: 2, arm: 'null'});
  assert.equal(leg.seq, 2); assert.equal(leg.arm, 'null');
  assert.deepEqual(leg.runs.map(r => [r.judgePass, r.error, r.subjectText]), [[true, false, null], [false, true, null], [false, false, null]]);
});
test('plugin adapter joins case grader types, uses subject evidence, fails missing judges', () => {
  const json = {cases: [{name: 'expected-case', graders: [{name: 'judge', type: 'llm'}, {name: 'regex', type: 'regex'}], arms: {with: [
    {error: null, graders: [{name: 'judge', passed: true, evidence: 'subject'}, {name: 'regex', passed: false}]},
    {error: 'timeout', graders: [{name: 'judge', passed: true}]},
    {error: null, graders: [{name: 'regex', passed: true}]},
    {error: null, graders: [{name: 'judge', passed: false}], trace: [{type: 'assistant', message: {content: [{type: 'text', text: 'traced subject'}]}}]}
  ]}}]};
  const leg = adapters.fromPluginEval(json, {seq: 10, arm: 'placebo', caseName: 'expected-case'});
  assert.deepEqual(leg.runs.map(r => r.judgePass), [true, false, false, false]);
  assert.equal(leg.runs[0].subjectText, 'subject'); assert.equal(leg.runs[3].subjectText, 'traced subject');
  assert.equal(leg.runs[1].error, true);
  assert.throws(() => adapters.fromPluginEval({cases: []}, {seq: 1, arm: 'full'}));
});
test('explicit guardrail breaches take priority over ACCEPT', () => {
  const o = sample(17); o.guardrailsBreached = true;
  assert.equal(adjudicate(o).verdict, 'INVALID-HARNESS');
  assert.equal(adjudicate(o).row, 1);
});
test('gate 2 excludes bridge and placebo and counts error runs as failures', () => {
  const o = sample(); o.legs[4].runs.forEach(r => r.error = true); o.legs[3].runs.forEach(r => r.error = true);
  assert.deepEqual(gate2(o), {pass: true, failing: []});
  o.legs[2].runs.slice(0, 4).forEach(r => r.error = true);
  assert.deepEqual(gate2(o), {pass: false, failing: ['C2', 'C5']});
});
test('C6 requires a single id in every pre and post probe', () => {
  for (const models of [[], ['haiku-id', 'haiku-id'], ['other-id']]) {
    const o = sample(); o.probes.pre.placebo.models = models;
    assert.equal(adjudicate(o).checks.C6.status, 'FAIL');
  }
});
test('C4 background: frozen set from name@source, order-free, any difference fails', () => {
  assert.deepEqual(backgroundOf(sample().probes.pre.full), FROZEN);
  const shuffled = sample(); shuffled.probes.post.full.plugins.reverse();
  assert.equal(adjudicate(shuffled).checks.C4.status, 'PASS');
  const fails = {
    added: o => o.probes.post.full.plugins.push({name: 'rstaff-ds', source: 'rstaff-ds@rstaff', path: '/opt/plugins/rstaff-ds'}),
    dropped: o => o.probes.pre.placebo.plugins.pop(),
    resourced: o => o.probes.pre['known-fail'].plugins[1].source = 'superpowers@other-marketplace',
    noFrozen: o => delete o.backgroundPlugins,
    noOwner: o => delete o.owner,
    renamedArm: o => o.probes.pre.null.plugins[0].name = 'rstaff-pm-copy',
    noArmPath: o => delete o.probes.pre.full.armPath,
    legacyShape: o => { o.probes.pre.full = {models: ['haiku-id'], rstaffPlugins: [{name: 'rstaff', path: 'arms/full'}]}; },
  };
  for (const [name, mutate] of Object.entries(fails)) {
    const o = sample(); mutate(o); const r = adjudicate(o);
    assert.equal(r.checks.C4.status, 'FAIL', name); assert.equal(r.verdict, 'INVALID-HARNESS', name);
  }
  const o = sample(); fails.added(o);
  assert.match(adjudicate(o).checks.C4.detail, /post\/full/);
  // Defects present in every probe also reach the frozen set, so only the owner and frozen guards catch them.
  const everywhere = mutate => { const x = sample(); for (const p of [...Object.values(x.probes.pre), x.probes.post.full]) mutate(p); x.backgroundPlugins = backgroundOf(x.probes.pre.full); return x; };
  const installedEverywhere = everywhere(p => p.plugins.push({name: 'rstaff-pm', source: 'rstaff-pm@rstaff', path: '/installed'}));
  assert.ok(installedEverywhere.backgroundPlugins.includes('rstaff-pm@rstaff-pm@rstaff'));
  assert.equal(adjudicate(installedEverywhere).checks.C4.status, 'FAIL', 'second owner copy in every probe');
  const ownerElsewhere = everywhere(p => { p.plugins[0].path = '/installed/rstaff-pm'; });
  assert.equal(adjudicate(ownerElsewhere).checks.C4.status, 'FAIL', 'owner loaded from outside the arm in every probe');
  const nothingFrozen = everywhere(p => { p.plugins = p.plugins.slice(0, 1); }); delete nothingFrozen.backgroundPlugins;
  assert.equal(adjudicate(nothingFrozen).checks.C4.status, 'FAIL', 'no frozen background');
});
test('rule file opens with the spec decision rule naming the frozen background', () => {
  const rule = fs.readFileSync(path.join(__dirname, '../../maintainer/ablate/rule.md'), 'utf8').split('\n');
  assert.equal(rule[0], '### Decision rule (pre-registered once; M2–M4 reuse it unchanged)');
  assert.equal(rule[8], '- **C4 isolation:** each probe shows exactly one plugin with the skill owner\'s name, loaded from its arm, and a non-arm plugin set equal to the frozen background.');
  assert.deepEqual(rule.slice(23, 26), ['', 'cap: 4', 'judge: haiku']);
});

test('plugin adapter rejects a different case name in an otherwise valid aggregate', () => {
  const json = {cases: [{name: 'other-case', graders: [{name: 'judge', type: 'llm'}],
    arms: {with: [{error: null, evidence: 'reply', graders: [{name: 'judge', passed: true}]}]}}]};
  assert.throws(() => adapters.fromPluginEval(json, {seq: 1, arm: 'full', caseName: 'expected-case'}),
    /case.*expected-case.*other-case/i);
});
