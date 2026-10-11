'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// resolveTask reads the quota brake from $RSTAFF_HOME's rstaff.json + var/usage.jsonl.
// Point it at an empty control repo (no codexQuota key => brake off) so these tests
// never depend on the real log's current weekly percentage.
process.env.RSTAFF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-route-home-'));
fs.writeFileSync(path.join(process.env.RSTAFF_HOME, 'rstaff.json'), '{}\n');
const R = require(path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'route.js'));

test('resolveRoute applies the automatic cross-provider policy', () => {
  assert.deepEqual(R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'auto', codexAvailable: true }), {
    risk: 'low', impl: 'claude', writerModel: 'sonnet', writerEffort: null,
    reviewer: 'codex', reviewerModel: 'gpt-6-luna', reviewerEffort: 'max',
    implReason: null,
    reviewReason: 'low-risk Claude-authored task uses cross-provider review',
    reason: 'low-risk Claude-authored task uses cross-provider review',
    route: 'claude/sonnet -> codex/gpt-6-luna@max',
  });
  const medium = R.resolveRoute({ risk: 'medium', impl: 'claude', reviewer: 'auto', codexAvailable: true });
  assert.equal(medium.reviewerModel, 'gpt-6.1-sol');
  assert.equal(medium.reviewerEffort, 'medium');
});

test('resolveRoute keeps high-risk and external-writer review on Claude', () => {
  assert.equal(R.resolveRoute({ risk: 'high', impl: 'claude', reviewer: 'auto', codexAvailable: true }).reviewer, 'claude');
  assert.equal(R.resolveRoute({ risk: 'low', impl: 'codex', reviewer: 'auto', codexAvailable: true }).reviewer, 'claude');
});

test('resolveRoute records automatic fallback and rejects unavailable explicit Codex', () => {
  const fallback = R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'auto', codexAvailable: false });
  assert.equal(fallback.reviewer, 'claude');
  assert.match(fallback.reason, /fallback/);
  assert.throws(() => R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'codex', codexAvailable: false }), /explicit Codex reviewer/);
});

test('resolveRoute honors explicit Claude and Codex reviewer overrides', () => {
  const claude = R.resolveRoute({
    risk: 'low', impl: 'claude', reviewer: 'claude', codexAvailable: true,
  });
  assert.equal(claude.route, 'claude/sonnet -> claude/sonnet');
  assert.match(claude.reason, /explicit reviewer override/);

  const codex = R.resolveRoute({
    risk: 'high', impl: 'claude', reviewer: 'codex', codexAvailable: true,
  });
  assert.equal(codex.route, 'claude/opus -> codex/gpt-6.1-sol@xhigh');
  assert.equal(codex.reviewerEffort, 'xhigh');
});

// The tier TABLE itself. Re-tiered 2026-09-23 to the gpt-6 luna/sol generation:
// low luna@max, medium sol@medium, high sol@xhigh. astra stays out on the
// 2026-09-16 quota measurement (rate_limits snapshots put gpt-6-astra at ~25x
// luna and ~3x sol weekly-quota per token), so high buys reasoning effort on sol
// instead of a pricier model. Pinned as one deepEqual so a partial edit reads as
// a red, not as three unrelated string diffs.
test('CODEX_TIER routes low to luna@max, medium to 6.1-sol@medium, high to 6.1-sol@xhigh', () => {
  assert.deepEqual(R.CODEX_TIER, {
    low: { model: 'gpt-6-luna', effort: 'max' },
    medium: { model: 'gpt-6.1-sol', effort: 'medium' },
    high: { model: 'gpt-6.1-sol', effort: 'xhigh' },
  });
});

// The Claude side of the ledger, 2026-09-30: the writer/reviewer sentinels
// ('sonnet', 'inherited') become a risk-banded table so a high-risk diff is read
// by the strongest independent Claude model, and feature-runner can pass
// `model:` on the Task call instead of inheriting whatever the runner runs on.
test('CLAUDE_TIER routes low and medium to sonnet, high to opus', () => {
  assert.deepEqual(R.CLAUDE_TIER, {
    low: { model: 'sonnet' },
    medium: { model: 'sonnet' },
    high: { model: 'opus' },
  });
});

test('a Claude reviewer judges at the risk band Claude tier, on either writer', () => {
  for (const [risk, model] of [['low', 'sonnet'], ['medium', 'sonnet'], ['high', 'opus']]) {
    const codexWritten = R.resolveRoute({ risk, impl: 'auto', reviewer: 'auto', codexAvailable: true });
    assert.equal(codexWritten.reviewer, 'claude');
    assert.equal(codexWritten.reviewerModel, model, `${risk}: Codex-written diff is read by ${model}`);
    assert.equal(codexWritten.reviewerEffort, null);
    const claudeWritten = R.resolveRoute({ risk, impl: 'claude', reviewer: 'claude', codexAvailable: true });
    assert.equal(claudeWritten.writerModel, model, `${risk}: a pinned Claude writer is ${model}`);
    assert.equal(claudeWritten.reviewerModel, model);
  }
  assert.equal(R.resolveRoute({ risk: 'high', impl: 'auto', reviewer: 'auto', codexAvailable: true }).route,
    'codex/gpt-6.1-sol@xhigh -> claude/opus');
});

// class: docs is prose, and prose drafting is the one job Gemini is wired for
// (delegate.js `gemini draft`, read-only). The route names Gemini as the writer;
// feature-runner has a Claude implementer apply the draft, and the docs class
// still skips the per-task review gate (U11) while verify runs.
test('class: docs with impl auto drafts on Gemini and hands the apply/review to Claude', () => {
  const ledger = `# Tasks
impl: auto
reviewer: auto

## T1: Rewrite the README quickstart
- status: pending
- risk: low
- class: docs
- route: pending
`;
  const r = R.resolveTask(ledger, 'T1', { codexAvailable: true, geminiAvailable: true });
  assert.equal(r.impl, 'gemini');
  assert.equal(r.writerModel, 'gemini-3.8-flash');
  assert.equal(r.writerEffort, null);
  assert.equal(r.reviewer, 'claude');
  assert.equal(r.reviewerModel, 'sonnet');
  assert.equal(r.route, 'gemini/gemini-3.8-flash -> claude/sonnet');
  assert.equal(r.reviewRequired, false);
  assert.match(r.implReason, /docs task drafted by Gemini/);
  // A persisted gemini route is a reusable route, not an unknown backend.
  assert.deepEqual(R.parseRoute(r.route), {
    impl: 'gemini', writerModel: 'gemini-3.8-flash', writerEffort: null,
    reviewer: 'claude', reviewerModel: 'sonnet', reviewerEffort: null,
  });
  assert.equal(R.resolveTask(R.persistRoute(ledger, 'T1', r), 'T1', { codexAvailable: true, geminiAvailable: false }).reused, true);
});

test('a docs task without Gemini takes the ordinary auto policy and records the fallback', () => {
  const ledger = `# Tasks
impl: auto
reviewer: auto

## T1: Docs
- status: pending
- risk: low
- class: docs
- route: pending
`;
  const r = R.resolveTask(ledger, 'T1', { codexAvailable: true, geminiAvailable: false });
  assert.equal(r.impl, 'codex');
  assert.equal(r.route, 'codex/gpt-6-luna@max -> claude/sonnet');
  assert.match(r.implReason, /Gemini drafter unavailable/);
});

test('impl: gemini is refused on anything but a docs task', () => {
  assert.throws(
    () => R.resolveRoute({ risk: 'low', impl: 'gemini', reviewer: 'auto', codexAvailable: true, geminiAvailable: true }),
    /gemini drafts prose only.*class: docs/,
  );
  assert.throws(
    () => R.resolveRoute({ risk: 'low', class: 'config', impl: 'gemini', reviewer: 'auto', codexAvailable: true, geminiAvailable: true }),
    /gemini drafts prose only/,
  );
  // An explicit gemini pin on a docs task is allowed, and never reviews itself.
  const ok = R.resolveRoute({ risk: 'medium', class: 'docs', impl: 'gemini', reviewer: 'auto', codexAvailable: true, geminiAvailable: true });
  assert.equal(ok.route, 'gemini/gemini-3.8-flash -> claude/sonnet');
  assert.throws(
    () => R.resolveRoute({ risk: 'low', class: 'docs', impl: 'gemini', reviewer: 'gemini', codexAvailable: true, geminiAvailable: true }),
    /reviewer must be auto, claude, or codex/,
  );
});

// The dispatcher reads `writerMode` instead of inferring it from `impl`.
// Measured 2026-10-09: a docs task resolved to gemini, the dispatcher fell into the
// generic `delegate.js <impl> execute` line, and delegate.js refused it
// ("unknown mode \"execute\" for adapter \"gemini\" (known: draft)").
test('resolveTask and requireRoute name a writerMode the writer\'s adapter actually has', () => {
  const D = require(path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'delegate.js'));
  const ledger = (cls, impl) => `# Tasks
impl: auto
reviewer: auto

## T1: Task
- status: pending
- risk: low
- class: ${cls}
- impl: ${impl}
- impl-reason: test pin
- route: pending
`;
  const cases = [
    ['docs', 'auto', 'gemini', 'draft'],
    ['logic', 'auto', 'codex', 'execute'],
    ['logic', 'claude', 'claude', 'subagent'],
  ];
  for (const [cls, impl, wantImpl, wantMode] of cases) {
    const text = ledger(cls, impl);
    const r = R.resolveTask(text, 'T1', { codexAvailable: true, geminiAvailable: true });
    assert.equal(r.impl, wantImpl);
    assert.equal(r.writerMode, wantMode, `${wantImpl} writer`);
    if (wantMode !== 'subagent') {
      assert.ok(D.ADAPTERS[wantImpl].modes[wantMode], `delegate.js ${wantImpl} has no ${wantMode} mode`);
    }
    const persisted = R.persistRoute(text, 'T1', r);
    assert.equal(R.resolveTask(persisted, 'T1', { codexAvailable: true, geminiAvailable: true }).writerMode, wantMode);
    assert.equal(R.requireRoute(persisted, 'T1').writerMode, wantMode);
  }
  // A writer mode route.js names but delegate.js lacks is refused, not emitted.
  assert.throws(() => R.writerModeFor('gemini', { gemini: { modes: { advise() {} } } }), /delegate\.js has no "draft" mode for gemini/);
});

test('impl auto sends bounded low/medium work to Codex at the risk tier', () => {
  const low = R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true });
  assert.equal(low.impl, 'codex');
  assert.equal(low.writerModel, 'gpt-6-luna');
  assert.equal(low.writerEffort, 'max');
  assert.equal(low.route, 'codex/gpt-6-luna@max -> claude/sonnet');

  const medium = R.resolveRoute({ risk: 'medium', impl: 'auto', reviewer: 'auto', codexAvailable: true });
  assert.equal(medium.impl, 'codex');
  assert.equal(medium.writerModel, 'gpt-6.1-sol');
  assert.equal(medium.writerEffort, 'medium');
});

// High risk buys a higher reasoning tier, not a different provider: the writer is
// the biggest token lever, and the interlock below still forces a fresh Claude gate.
test('impl auto sends high-risk work to Codex at the high tier behind a Claude gate', () => {
  const high = R.resolveRoute({ risk: 'high', impl: 'auto', reviewer: 'auto', codexAvailable: true });
  assert.equal(high.impl, 'codex');
  assert.equal(high.writerModel, 'gpt-6.1-sol');
  assert.equal(high.writerEffort, 'xhigh');
  assert.equal(high.route, 'codex/gpt-6.1-sol@xhigh -> claude/opus');
  assert.equal(high.reviewer, 'claude');
  assert.match(high.implReason, /high-risk task delegated to the Codex writer at the high tier/);
});

test('a Codex writer always forces an independent Claude reviewer', () => {
  for (const risk of ['low', 'medium', 'high']) {
    const r = R.resolveRoute({ risk, impl: 'auto', reviewer: 'auto', codexAvailable: true });
    assert.equal(r.impl, 'codex');
    assert.equal(r.reviewer, 'claude', `${risk}: writer and reviewer must not be the same provider`);
    assert.match(r.reviewReason, /external writer requires an independent Claude reviewer/);
  }
});

test('impl auto records an unavailable-Codex fallback at every risk band', () => {
  const fallback = R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: false });
  assert.equal(fallback.impl, 'claude');
  assert.equal(fallback.reviewer, 'claude');
  assert.match(fallback.implReason, /fallback/);
  assert.match(fallback.reason, /fallback/);
  // Codex is now the ONLY external backend, so its absence must degrade to Claude
  // on every band rather than leaving a band with no writer at all.
  for (const risk of ['low', 'medium', 'high']) {
    assert.equal(
      R.resolveRoute({ risk, impl: 'auto', reviewer: 'auto', codexAvailable: false }).impl,
      'claude',
      `${risk}: no Codex must fall back to the Claude writer`,
    );
  }
});

test('an explicit impl backend is passed through untouched', () => {
  // `implPinned` marks a PER-TASK `- impl: codex` line — the one provenance that
  // keeps codex's own config default. A header `impl:` or a CLI `--impl` carries
  // the same VALUE but different provenance, and takes the risk tier instead
  // The per-task pin's provenance is shown below.
  const explicit = R.resolveRoute({ risk: 'low', impl: 'codex', reviewer: 'auto', codexAvailable: true, implPinned: true });
  assert.equal(explicit.impl, 'codex');
  assert.equal(explicit.writerModel, 'default', "a per-task pin keeps codex's own config default");
  assert.equal(explicit.writerEffort, null);
  assert.equal(explicit.implReason, null);
  // gemini is a backend, but a prose-only one: it is refused off the docs class.
  assert.throws(() => R.resolveRoute({ risk: 'low', impl: 'gemini', reviewer: 'auto', codexAvailable: true, geminiAvailable: true }), /gemini drafts prose only/);
  // cursor was removed as a backend — it must now be rejected, not passed through.
  assert.throws(() => R.resolveRoute({ risk: 'low', impl: 'cursor', reviewer: 'auto', codexAvailable: true }), /impl must be auto, claude, codex, or gemini/);
});

// --- A default sentinel belongs to a per-task pin only -----------------------
// Keying the tier table off `requestedImpl === 'auto'` collapsed three different
// provenances that all land in `impl`. /build's dispatcher writes its resolved
// backend into the ledger HEADER before the loop starts, so that turned `auto`
// into an explicit `codex` and moved every LATER task onto an unvalidated
// `codex/default` — silently, since `implPinned` is false for a header value.

test('A header impl:codex pin takes the risk tier; a per-task pin keeps codex/default', () => {
  // These two ledgers differ in exactly ONE respect: WHERE `impl: codex` sits.
  // Same value, same risk, same reviewer — so the assertions below can only be
  // satisfied by reading provenance, never by reading the value.
  const header = `# Tasks
impl: codex
reviewer: auto

## T1: One
- status: pending
- risk: medium
- route: pending
`;
  const pin = `# Tasks
impl: auto
reviewer: auto

## T1: One
- status: pending
- risk: medium
- impl: codex   # this task wants codex's own configured model
- route: pending
`;
  const viaHeader = R.resolveTask(header, 'T1', { codexAvailable: true });
  const viaPin = R.resolveTask(pin, 'T1', { codexAvailable: true });

  assert.equal(viaHeader.impl, 'codex');
  assert.equal(viaHeader.writerModel, 'gpt-6.1-sol', 'a header impl: is feature POLICY and takes the risk band tier');
  assert.equal(viaHeader.writerEffort, 'medium');
  assert.equal(viaHeader.route, 'codex/gpt-6.1-sol@medium -> claude/sonnet');

  assert.equal(viaPin.impl, 'codex');
  assert.equal(viaPin.writerModel, 'default', 'a per-task pin is the documented opt-out to codex config.toml');
  assert.equal(viaPin.writerEffort, null);
  assert.equal(viaPin.route, 'codex/default -> claude/sonnet');

  // The PAIR is the point: same backend, same risk, different model. If these
  // ever agree again, the provenance split has been collapsed back.
  assert.notEqual(viaHeader.writerModel, viaPin.writerModel,
    'header and pin must not resolve to the same writer model');
});

test('A CLI --impl override changes pin semantics, not just the backend', () => {
  const pin = `# Tasks
impl: auto
reviewer: auto

## T1: One
- status: pending
- risk: medium
- impl: codex   # this task wants codex's own configured model
- route: pending
`;
  // Same ledger, but the human typed `--impl codex` in the moment. That is a
  // run-level choice, so it takes the tier table — the same exemption the
  // explain-yourself rule already grants a CLI --impl.
  const viaCLI = R.resolveTask(pin, 'T1', { codexAvailable: true, impl: 'codex' });
  assert.equal(viaCLI.writerModel, 'gpt-6.1-sol', 'a CLI --impl is not a per-task exception');
  assert.equal(viaCLI.route, 'codex/gpt-6.1-sol@medium -> claude/sonnet');
  // ...and the very same ledger without the flag still keeps `default`.
  assert.equal(R.resolveTask(pin, 'T1', { codexAvailable: true }).writerModel, 'default');
});

test('An already-persisted codex/default route still replays verbatim', () => {
  // Routes are sticky. Narrowing which provenance PRODUCES `default` must not
  // silently migrate a route some earlier run already persisted.
  const stored = `# Tasks
impl: codex
reviewer: auto

## T1: One
- status: pending
- risk: medium
- route: codex/default -> claude/inherited
`;
  const replayed = R.resolveTask(stored, 'T1', { codexAvailable: true });
  assert.equal(replayed.reused, true);
  assert.equal(replayed.writerModel, 'default', 'a stored route wins over the new provenance rule');
  assert.equal(replayed.route, 'codex/default -> claude/inherited');
});

test('A per-task impl:auto under a header impl:codex still takes the tier', () => {
  // The `requestedImpl === 'codex'` half of pinnedToCodexDefault is load-bearing
  // on its own. `- impl: auto` is a REAL pinned value (`implPinned: true`), so a
  // guard written as `!!opts.implPinned` alone would route this task to
  // `codex/default` — a regression against the pre-fix base too, which handled
  // this input correctly. `- impl: auto` appears in live ledgers, and the
  // `impl: codex` header is written mechanically by /build and /dispatch, so the
  // combination is reachable in ordinary use, not hypothetical.
  const headerCodexTaskAuto = `# Tasks
impl: codex
reviewer: auto

## T1: One
- status: pending
- risk: medium
- impl: auto
- route: pending
`;
  const r = R.resolveTask(headerCodexTaskAuto, 'T1', { codexAvailable: true });
  assert.equal(r.impl, 'codex');
  assert.equal(r.writerModel, 'gpt-6.1-sol',
    'a pinned `auto` asks for the POLICY route — it must never mean codex config.toml');
  assert.equal(r.route, 'codex/gpt-6.1-sol@medium -> claude/sonnet');
});

test('CLI model and effort overrides still win for both routing sources', () => {
  const base = { risk: 'medium', impl: 'codex', reviewer: 'auto', codexAvailable: true };
  for (const implPinned of [true, false]) {
    const r = R.resolveRoute({ ...base, implPinned, implModel: 'gpt-5.6-terra', implEffort: 'xhigh' });
    assert.equal(r.writerModel, 'gpt-5.6-terra', `implPinned=${implPinned}: an explicit model must win`);
    assert.equal(r.writerEffort, 'xhigh', `implPinned=${implPinned}: an explicit effort must win`);
  }
});

test('--impl-model and --impl-effort override the auto tier', () => {
  const r = R.resolveRoute({
    risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true,
    implModel: 'gpt-6-astra', implEffort: 'high',
  });
  assert.equal(r.writerModel, 'gpt-6-astra');
  assert.equal(r.writerEffort, 'high');
  assert.deepEqual(R.parseArgs(['resolve', '--impl', 'auto', '--impl-effort', 'high']).implEffort, 'high');
});

// --- effort validation ------------------------------------------------------
// A mistyped effort used to be forwarded verbatim into a dispatched worker's argv
// and only surface as a dead worker — with the bad value already persisted as the
// task's sticky route. Both the table and the overrides are now guarded.

// Asserted by MUTATING the table and demanding a throw, not by re-implementing
// `CODEX_EFFORTS.has(...)` in the test — a restated predicate passes even when the
// guard it describes is deleted, which is the failure mode LEARNINGS calls out.
test('a CODEX_TIER band with an unknown effort fails when the tier is READ', () => {
  const original = { ...R.CODEX_TIER.low };
  try {
    R.CODEX_TIER.low.effort = 'hihg';
    assert.throws(
      () => R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true }),
      /CODEX_TIER\.low has unknown reasoning effort "hihg"/,
    );
    // …and the guard must NOT be a module-load throw: guard-bash.js loads route.js
    // behind a fail-OPEN try/catch, so an unloadable module would silently disable
    // the unrouted-dispatch deny for every task. requireRoute never reads the tier
    // and must keep working with the table broken.
    const ledger = '## T1: One\n- status: pending\n- risk: low\n- route: codex/gpt-5.6-luna@max -> claude/inherited\n';
    assert.equal(R.requireRoute(ledger, 'T1').writerEffort, 'max', 'the gate must survive a broken tier table');
  } finally {
    Object.assign(R.CODEX_TIER.low, original);
  }
  // Restored — the real table resolves again.
  assert.equal(R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true }).writerEffort, 'max');
});

test('resolveRoute rejects an effort override the codex CLI does not know', () => {
  const base = { risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true };
  assert.throws(() => R.resolveRoute({ ...base, implEffort: 'maxx' }), /--impl-effort "maxx" is not a codex reasoning effort/);
  assert.throws(
    () => R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'auto', codexAvailable: true, reviewEffort: 'ludicrous' }),
    /--review-effort "ludicrous" is not a codex reasoning effort/,
  );
  // xhigh/ultra are real levels rstaff's table does not currently use — they must
  // pass, or the guard would quietly become a table-only allowlist.
  assert.equal(R.resolveRoute({ ...base, implEffort: 'xhigh' }).writerEffort, 'xhigh');
});

// --- (model, effort) support against the CLI's own catalog -------------------
const levels = (...e) => e.map((effort) => ({ effort }));
const catalogFor = (efforts) => ({
  models: [...new Set(Object.values(R.CODEX_TIER).map((t) => t.model))]
    .map((slug) => ({ slug, supported_reasoning_levels: levels(...efforts) })),
});
// Real levels the tier table does NOT currently use, derived from the table
// rather than hardcoded. A catalog built from these makes EVERY band a genuine
// `unsupported`, which is what the count assertions below actually mean. A
// literal list rots the moment the table adopts one of its levels: that band
// silently becomes valid, and a count assertion that claims to cover every band
// would then pass while covering fewer.
const TIER_EFFORTS = new Set(Object.values(R.CODEX_TIER).map((t) => t.effort));
const NO_TIER_EFFORTS = [...require(path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'delegate.js')).CODEX_EFFORTS]
  .filter((e) => !TIER_EFFORTS.has(e));

test('pairSupport answers ok/unsupported/unknown, and never calls an unreadable catalog a defect', () => {
  const cat = catalogFor(['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(R.pairSupport(cat, 'gpt-6-luna', 'max').status, 'ok');
  assert.equal(R.pairSupport(cat, 'gpt-6-luna', 'ultra').status, 'unsupported',
    'a level the model does not offer is the failure this guard exists to catch');
  assert.deepEqual(R.pairSupport(cat, 'gpt-6-luna', 'ultra').levels, ['low', 'medium', 'high', 'xhigh', 'max']);

  // Every way the catalog can fail to ANSWER must be `unknown`, never `unsupported`:
  // a cache rstaff cannot read is not evidence that a route is broken.
  assert.equal(R.pairSupport(cat, 'gpt-4o', 'max').status, 'unknown', 'model absent from a stale cache');
  assert.equal(R.pairSupport({ models: [{ slug: 'gpt-6-luna', supported_reasoning_levels: [] }] }, 'gpt-6-luna', 'max').status,
    'unknown', 'model present with an EMPTY level list');
  assert.equal(R.pairSupport({ models: [{ slug: 'gpt-6-luna', supported_reasoning_levels: [{ name: 'max' }] }] }, 'gpt-6-luna', 'max').status,
    'unknown', 'a renamed level key is a schema this build does not understand, not a broken route');
  for (const empty of [null, undefined, {}, { models: 'nope' }]) {
    assert.equal(R.pairSupport(empty, 'gpt-6-luna', 'max').status, 'unknown');
  }
});

test('checkTierSupport walks every band and separates unknown from unsupported', () => {
  const ok = R.checkTierSupport(catalogFor(['low', 'medium', 'high', 'xhigh', 'max']));
  assert.equal(ok.verified, true);
  assert.deepEqual(ok.unsupported, []);
  assert.deepEqual(ok.unknown, [], 'the real table must verify clean against a catalog that offers its efforts');

  // A model that exists and offers levels, but not the band's: a real defect.
  const bad = R.checkTierSupport(catalogFor(NO_TIER_EFFORTS));
  assert.equal(bad.verified, true);
  assert.equal(bad.unsupported.length, Object.keys(R.CODEX_TIER).length);
  // Name every band's own pair, not just one string: a single hardcoded message
  // is satisfied by a walk that reports one band and drops the rest.
  for (const [band, tier] of Object.entries(R.CODEX_TIER)) {
    assert.match(
      bad.unsupported.join(' '),
      new RegExp(`${band}: ${tier.model.replace(/\./g, '\\.')} has no "${tier.effort}" \\(offers ${NO_TIER_EFFORTS.join('/')}\\)`),
      `${band} must be reported with the pair it failed on`,
    );
  }
  assert.deepEqual(bad.unknown, []);

  // Present-but-unparsable must land in unknown, NOT as `has no "max" (offers )`,
  // which would tell the operator to fix a table that is fine.
  const unparsable = R.checkTierSupport({ models: [{ slug: 'gpt-6-luna', supported_reasoning_levels: [{ name: 'max' }] }] });
  assert.deepEqual(unparsable.unsupported, []);
  assert.equal(unparsable.unknown.length, Object.keys(R.CODEX_TIER).length);

  for (const empty of [null, undefined, {}, { models: 'nope' }]) {
    assert.deepEqual(R.checkTierSupport(empty), { verified: false, unsupported: [], unknown: [] });
  }
});

// The bug this whole change exists to prevent, on the path that actually ships it:
// an override skips the tier table AND /health's check of that table.
test('a resolved override is checked against the catalog, not just the CLI enum', () => {
  const catalog = catalogFor(['low', 'medium', 'high', 'xhigh', 'max']);   // no `ultra`
  const base = { risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true, catalog };

  assert.throws(() => R.resolveRoute({ ...base, implEffort: 'ultra' }),
    /writer model gpt-6-luna does not offer reasoning effort "ultra" \(offers .*max\)/);
  assert.throws(
    () => R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'auto', codexAvailable: true, catalog, reviewEffort: 'ultra' }),
    /reviewer model gpt-6-luna does not offer reasoning effort "ultra"/,
    'the reviewer axis carries the same failure and needs the same check',
  );
  // A level the model DOES offer still resolves.
  assert.equal(R.resolveRoute({ ...base, implEffort: 'xhigh' }).writerEffort, 'xhigh');
  // An unknown model must not block: a stale catalog cannot stop a dispatch.
  assert.equal(R.resolveRoute({ ...base, implModel: 'gpt-6-unreleased', implEffort: 'ultra' }).writerModel, 'gpt-6-unreleased');
  // No catalog supplied = the pure library path, unchanged.
  assert.equal(R.resolveRoute({ ...base, catalog: null, implEffort: 'ultra' }).writerEffort, 'ultra');
  // Claude-side sentinels aren't in codex's catalog, so they answer `unknown`
  // and never block — including when a human puts an effort on a Claude axis.
  assert.doesNotThrow(() => R.resolveRoute({ risk: 'high', impl: 'claude', reviewer: 'auto', codexAvailable: true, catalog }));
  assert.doesNotThrow(() => R.resolveRoute({ risk: 'high', impl: 'claude', reviewer: 'claude', codexAvailable: true, catalog, implEffort: 'ultra' }));
});

// The operator's explicit call: the tier table is NEVER blocked at resolve time,
// because the catalog is a cache and a stale one would take down all routing.
// Asserted at the LIBRARY level so it survives without spawning anything — the
// claim in routing.md must not rest on a single CLI test.
test('a stale catalog never blocks a tier-derived pair, on either axis', () => {
  const stale = catalogFor(['low', 'medium']);   // predates the table's max/high
  const writer = R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true, catalog: stale });
  assert.equal(writer.writerEffort, 'max', 'the tier writer resolves regardless of what the cache knows');

  const reviewer = R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'auto', codexAvailable: true, catalog: stale });
  assert.equal(reviewer.reviewerEffort, 'max', 'and so does the tier reviewer');

  // The narrow case that DOES block: a human-typed override on that same cache.
  assert.throws(() => R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true, catalog: stale, implEffort: 'max' }),
    /does not offer reasoning effort "max"/);
  // …and an override on ONE axis must not drag the untouched axis into the check.
  assert.equal(
    R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'auto', codexAvailable: true, catalog: stale, implEffort: 'low' }).reviewerEffort,
    'max', 'the reviewer axis took the tier value and was never overridden',
  );
});

// A PER-TASK `- impl: codex` pin resolves to the `default` sentinel and the runner
// then omits `-m`, so the effort lands on whatever config.toml names. Skipping the
// check there left the exact failure this guard exists for reachable.
test('a pinned impl:codex is checked against the model codex config.toml actually names', () => {
  const catalog = catalogFor(['low', 'medium', 'high', 'xhigh', 'max']);   // no `ultra`
  const explicit = {
    risk: 'low', impl: 'codex', reviewer: 'auto', codexAvailable: true, catalog, implEffort: 'ultra',
    implPinned: true,
  };
  assert.throws(
    () => R.resolveRoute({ ...explicit, codexDefaultModel: 'gpt-6-luna' }),
    /writer model gpt-6-luna \(codex's config\.toml default\) does not offer reasoning effort "ultra"/,
  );
  // An effort that model DOES offer resolves, and keeps the `default` sentinel:
  // resolving the name is for the CHECK, it must not rewrite the route.
  const ok = R.resolveRoute({ ...explicit, implEffort: 'max', codexDefaultModel: 'gpt-6-luna' });
  assert.equal(ok.writerModel, 'default');
  assert.equal(ok.route, 'codex/default@max -> claude/sonnet');
  // Unreadable config.toml — cannot answer, must not block.
  assert.doesNotThrow(() => R.resolveRoute({ ...explicit, codexDefaultModel: null }));
});

test('codexDefaultModel reads the TOP-LEVEL model, not a profile section', () => {
  assert.equal(R.codexDefaultModel('model = "gpt-5.6-sol"\napproval_policy = "never"\n'), 'gpt-5.6-sol');
  assert.equal(R.codexDefaultModel("model = 'gpt-5.6-luna'\n"), 'gpt-5.6-luna');
  // A profile's model is NOT the global default — naming it would put the wrong
  // model in the error and check a pair that never runs.
  assert.equal(R.codexDefaultModel('approval_policy = "never"\n\n[profiles.deep]\nmodel = "gpt-5.6-sol"\n'), null);
  for (const empty of ['', null, undefined, 'nothing here\n']) assert.equal(R.codexDefaultModel(empty), null);
});

// --- A catalog whose version does not match the CLI --------------------------
// The incident: models_cache.json carried `client_version: 0.153.4` while the
// installed CLI was 0.146.0, so it advertised `gpt-6-astra` with every reasoning
// level while that CLI could not run it. `loadCodexCatalog` is a bare JSON.parse,
// so rstaff accepted a file codex's own loader discards outright.
//
// A follow-up measured CLI cache behavior with RUST_LOG against the
// real cache on codex-cli 0.153.2:
//   models cache: loaded cache file        cached_version=Some("0.153.4")
//   models cache: cache version mismatch   expected_version="0.153.2"
//   models cache: no usable cache entry
// The rule is EQUALITY on the version string, in both directions — not "is the
// cache newer". Everything below pins that rule and nothing else; in particular
// a model's fields are not part of it (see the `ok` test).
// /health reports this; nothing blocks on it (see catalogParity's comment).

test('parseCodexVersion reads a numeric triple and ignores any release tail', () => {
  assert.deepEqual(R.parseCodexVersion('codex-cli 0.146.0'), { major: 0, minor: 146, patch: 0 });
  assert.deepEqual(R.parseCodexVersion('0.146.0'), { major: 0, minor: 146, patch: 0 });
  // A pre-release tail must not defeat the parse. This function answers "is this
  // a version at all, and which way does it point" — the release tail belongs to
  // the identity codex matches on, so codexVersionToken keeps it and this drops it.
  assert.deepEqual(R.parseCodexVersion('0.146.0-rc1'), { major: 0, minor: 146, patch: 0 });
  assert.deepEqual(R.parseCodexVersion('codex-cli 1.2.3+build.9'), { major: 1, minor: 2, patch: 3 });
  // Anything without a triple cannot answer, and must say so rather than guess.
  for (const junk of ['', null, undefined, 'codex-cli', '0.146', 'not a version']) {
    assert.equal(R.parseCodexVersion(junk), null, `must not invent a version from ${JSON.stringify(junk)}`);
  }
});

test('codexVersionToken keeps the whole version, release tail included', () => {
  // The comparison key. codex matches this string, so the tail cannot be dropped.
  assert.equal(R.codexVersionToken('codex-cli 0.153.2'), '0.153.2');
  assert.equal(R.codexVersionToken('0.153.2-rc1'), '0.153.2-rc1');
  assert.equal(R.codexVersionToken('codex-cli 1.2.3+build.9'), '1.2.3+build.9');
  for (const junk of ['', null, undefined, 'codex-cli', '0.146', 'not a version']) {
    assert.equal(R.codexVersionToken(junk), null, `must not invent a version from ${JSON.stringify(junk)}`);
  }
});

test('catalogParity flags a cache written by a NEWER codex than the installed CLI', () => {
  // The exact signature measured on 2026-09-09.
  const incident = R.catalogParity({ client_version: '0.153.4' }, 'codex-cli 0.146.0');
  assert.equal(incident.status, 'mismatch');
  assert.equal(incident.direction, 'newer');
  assert.equal(incident.cache, '0.153.4');
  assert.equal(incident.cli, 'codex-cli 0.146.0');

  // `direction` is only for the message; each component orders it, most
  // significant first. The VERDICT does not depend on any of them.
  assert.equal(R.catalogParity({ client_version: '1.0.0' }, '0.153.4').direction, 'newer', 'major');
  assert.equal(R.catalogParity({ client_version: '0.147.0' }, '0.146.9').direction, 'newer', 'minor beats patch');
  assert.equal(R.catalogParity({ client_version: '0.146.1' }, '0.146.0').direction, 'newer', 'patch');
});

test('An older cache is discarded and is not read as ok', () => {
  // The false negative this ticket was filed on. The old check asked "is the cache
  // NEWER?", so every stale cache answered `ok` while codex was throwing it away
  // and falling back to built-in metadata. codex logs one `cache version mismatch`
  // branch, taken whenever the strings differ AT ALL — direction is not consulted.
  for (const [cache, cli, why] of [
    ['0.140.0', 'codex-cli 0.146.0', 'older minor'],
    ['0.146.0', 'codex-cli 0.146.1', 'older patch'],
    ['0.153.4', 'codex-cli 1.0.0', 'older major'],
  ]) {
    const r = R.catalogParity({ client_version: cache }, cli);
    assert.equal(r.status, 'mismatch', why);
    assert.equal(r.direction, 'older', why);
  }
});

test('catalogParity compares the version STRING, not the numeric triple', () => {
  // Measured: cache `0.153.2-rc1` against CLI `0.153.2` logs
  //   cache version mismatch expected_version="0.153.2" cached_version=Some("0.153.2-rc1")
  // so the release tail is part of the identity codex matches on. Comparing the
  // triples alone would call this pair equal and miss a cache codex refuses.
  const rc = R.catalogParity({ client_version: '0.153.2-rc1' }, 'codex-cli 0.153.2');
  assert.equal(rc.status, 'mismatch');
  assert.equal(rc.direction, null, 'same triple: neither newer nor older, just different');
});

test('catalogParity says ok ONLY on an exact match — and ignores what the models carry', () => {
  assert.equal(R.catalogParity({ client_version: '0.146.0' }, 'codex-cli 0.146.0').status, 'ok', 'equal');
  assert.equal(R.catalogParity({ client_version: '0.146.0' }, 'codex-cli 0.146.0').direction, null);

  // The second check (axis b) was measured and rejected. `base_instructions` is not a
  // loadability signal on codex-cli 0.153.2: a cache whose models ALL lack the
  // field still logs `cache hit` -> `cache entry applied` once the version
  // matches, and the catalog the API returns today carries it on 0 of 7 models.
  // The missing-field error came from an older
  // codex's schema requirement, not an invariant — so parity must NOT read it.
  // Asserting a warn here would pin a belief the installed CLI contradicts.
  const noBaseInstructions = {
    client_version: '0.153.2',
    models: [{ slug: 'gpt-5.6-sol', supported_reasoning_levels: [{ effort: 'high' }] }],
  };
  assert.equal(R.catalogParity(noBaseInstructions, 'codex-cli 0.153.2').status, 'ok');
});

test('catalogParity answers `unknown` whenever it cannot compare, never a verdict', () => {
  // Same rule pairSupport follows: a cache rstaff can't read is not evidence.
  for (const [catalog, cli, why] of [
    [null, 'codex-cli 0.146.0', 'no catalog'],
    [{}, 'codex-cli 0.146.0', 'catalog without client_version'],
    [{ client_version: 42 }, 'codex-cli 0.146.0', 'non-string client_version'],
    [{ client_version: 'unreleased' }, 'codex-cli 0.146.0', 'unparsable client_version'],
    [{ client_version: '0.153.4' }, '', 'codex --version returned nothing'],
    [{ client_version: '0.153.4' }, null, 'codex --version failed'],
    [{ client_version: '0.153.4' }, 'command not found', 'unparsable CLI version'],
  ]) {
    assert.equal(R.catalogParity(catalog, cli).status, 'unknown', why);
  }
  // `unknown` still reports whatever it DID read, so /health can name it.
  assert.equal(R.catalogParity({ client_version: '0.153.4' }, 'junk').cache, '0.153.4');
});

test('Catalog parity is the only signal that separates the two model states', () => {
  // The load-bearing fact, pinned so it cannot be quietly forgotten: a catalog
  // check does not discriminate here. `gpt-6-astra` (refused at spawn) and
  // `gpt-5.6-sol` (ran fine) BOTH answer `ok` against the real cache's shape,
  // because the cache lists them both with the same reasoning levels.
  const asShipped = {
    client_version: '0.153.4',
    models: [
      { slug: 'gpt-6-astra', supported_reasoning_levels: [{ effort: 'medium' }] },
      { slug: 'gpt-5.6-sol', supported_reasoning_levels: [{ effort: 'medium' }] },
    ],
  };
  assert.equal(R.pairSupport(asShipped, 'gpt-6-astra', 'medium').status, 'ok');
  assert.equal(R.pairSupport(asShipped, 'gpt-5.6-sol', 'medium').status, 'ok');
  // Only the version mismatch tells the operator anything is wrong.
  assert.equal(R.catalogParity(asShipped, 'codex-cli 0.146.0').status, 'mismatch');
});

// --- the CLI: where the guard is actually ARMED ------------------------------
// resolveRoute only checks pairs when handed a catalog, and the `route.js resolve`
// entrypoint is the sole thing that loads one. Without a spawn test, deleting the
// two loader lines from the CLI block leaves the whole suite green while the guard
// is inert in production — so drive the real binary, not the library.
// PATH is SYNTHESIZED, never inherited. `impl: auto` resolves through the real
// isAvailable('codex'), so inheriting the host PATH would make the assertion mean
// "this developer has codex installed": on CI (no codex) the route falls back to
// claude/sonnet, the pair is never checked, and the test fails for a reason that
// has nothing to do with the guard. A stub binary makes availability deterministic
// in both directions. /bin stays on PATH because isAvailable shells out to `sh`.
function mkCodexStub() {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-stub-'));
  fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, 'codex'), 0o755);
  return dir;
}
function routeCLI(args, codexHome) {
  const { spawnSync } = require('node:child_process');
  return spawnSync(process.execPath, [path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'route.js'), ...args], {
    encoding: 'utf8',
    env: { PATH: `${mkCodexStub()}:/usr/bin:/bin`, RSTAFF_CODEX_HOME: codexHome, RSTAFF_HOME: process.env.RSTAFF_HOME },
  });
}
function mkLedger(tag) {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-${tag}-`));
  const file = path.join(dir, 'feat.tasks.md');
  fs.writeFileSync(file, '# Tasks\nimpl: auto\nreviewer: auto\n\n## T1: One\n- status: pending\n- risk: low\n- route: pending\n');
  return file;
}

test('route.js resolve loads the catalog and refuses an unsupported override', () => {
  const home = mkCodexHome('cli-cat', catalogFor(['low', 'medium', 'high', 'xhigh', 'max']));   // no `ultra`
  const ledger = mkLedger('cli-bad');
  const bad = routeCLI(['resolve', '--ledger', ledger, '--task', 'T1', '--impl-effort', 'ultra', '--write'], home);
  assert.equal(bad.status, 1, `expected exit 1; got ${bad.status}: ${bad.stdout}${bad.stderr}`);
  assert.match(bad.stderr, /does not offer reasoning effort "ultra"/);
  assert.match(fs.readFileSync(ledger, 'utf8'), /- route: pending/, 'a refused route must never be persisted');

  // An effort the model offers still resolves and persists.
  const ok = routeCLI(['resolve', '--ledger', ledger, '--task', 'T1', '--impl-effort', 'xhigh', '--write'], home);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(fs.readFileSync(ledger, 'utf8'), /- route: codex\/gpt-6-luna@xhigh/);
});

test('route.js resolve is unblocked by a missing or stale catalog', () => {
  // No catalog: the guard cannot answer and must not stop the dispatch.
  const blind = routeCLI(['resolve', '--ledger', mkLedger('cli-blind'), '--task', 'T1', '--impl-effort', 'ultra'], mkCodexHome('cli-none', null));
  assert.equal(blind.status, 0, `a missing catalog must not block: ${blind.stderr}`);

  // A catalog that PREDATES the tier's level is a stale cache, not a broken
  // route: the no-override path must still resolve. /health reports it instead.
  const stale = mkCodexHome('cli-stale', catalogFor(['low', 'medium']));
  const plain = routeCLI(['resolve', '--ledger', mkLedger('cli-plain'), '--task', 'T1', '--write'], stale);
  assert.equal(plain.status, 0, `an old cache must not take down all routing: ${plain.stderr}`);
  assert.match(plain.stdout, /"route": "codex\/gpt-6-luna@max/);
  // …while an override against that same cache is still refused.
  assert.equal(routeCLI(['resolve', '--ledger', mkLedger('cli-ovr'), '--task', 'T1', '--impl-effort', 'max'], stale).status, 1);
});

// --- /health wiring ----------------------------------------------------------
// The check lives in health's FULL (non-static) block because it reads the codex
// home, so `make verify`'s `health --static` never reaches it. Exercised here by
// spawning health with a synthetic $RSTAFF_CODEX_HOME to exercise its dedicated
// home through the spawned CLI — otherwise the check's PASS/WARN/FAIL result
// is code no test has ever run.
function healthCheck(name, codexHome, opts = {}) {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const ROOT = path.join(__dirname, '../..');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'rstaff', 'scripts', 'health.js'), '--json'], {
    encoding: 'utf8',
    env: {
      // A SCOPED PATH — node + /bin for health's `sh` probes, and nothing else.
      // Full health shells out to `gh auth status` and `claude plugin list`; with
      // the host PATH those are real network round trips inside a test, and on a
      // host with unreachable DNS each one burns health's 10s timeout — four
      // spawns of dead time bolted onto the DoD gate. Nothing here asserts on
      // those checks, so they can simply be absent.
      PATH: codexStubPath(opts.codexVersion),
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ch-')),
      RSTAFF_HOME: ROOT,
      RSTAFF_CODEX_HOME: codexHome,
      // The operator's own home. delegate.run() symlinks its config.toml into the
      // dedicated home before spawning, so it is what codex reads whenever the
      // dedicated home has not been seeded yet.
      ...(opts.sharedHome ? { CODEX_HOME: opts.sharedHome } : {}),
    },
  });
  return JSON.parse(r.stdout).results.find((x) => x.check === name);
}
const healthTierCheck = (codexHome) => healthCheck('codex tier support', codexHome);
function mkCodexHome(tag, catalog, configModel) {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-${tag}-`));
  if (catalog) fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify(catalog));
  if (configModel) fs.writeFileSync(path.join(dir, 'config.toml'), `model = "${configModel}"\n`);
  return dir;
}
// The scoped PATH deliberately excludes the real codex. A check that shells
// `codex --version` is therefore unreachable past `command -v codex` without a
// stub, so supply one whose output the test controls.
function codexStubPath(version) {
  const base = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
  if (version === undefined) return base;
  const os = require('node:os');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-bin-'));
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(version)}\n`, { mode: 0o755 });
  return `${bin}:${base}`;
}

test('health reports the tier as PASS against a catalog that offers every band effort', () => {
  const c = healthTierCheck(mkCodexHome('tier-ok', catalogFor(['low', 'medium', 'high', 'xhigh', 'max'])));
  assert.ok(c, 'health must report the codex tier check at all');
  assert.equal(c.status, 'PASS', `${c.status}: ${c.note}`);
  for (const [band, tier] of Object.entries(R.CODEX_TIER)) {
    assert.match(c.note, new RegExp(`${band}=${tier.model.replace(/\./g, '\\.')}@${tier.effort}`),
      'the PASS note must name the pair it verified, or it proves nothing');
  }
});

test('health FAILs a band whose model does not offer the tier effort, and WARNs when it cannot tell', () => {
  const bad = healthTierCheck(mkCodexHome('tier-bad', catalogFor(['low', 'medium'])));
  assert.equal(bad.status, 'FAIL', `${bad.status}: ${bad.note}`);
  assert.match(bad.note, /has no "max"/);
  assert.match(bad.note, /route\.js/, 'a FAIL must carry the fix');

  // No catalog at all — unverifiable, and NEVER a FAIL.
  const absent = healthTierCheck(mkCodexHome('tier-none', null));
  assert.equal(absent.status, 'WARN', `${absent.status}: ${absent.note}`);
  assert.match(absent.note, /models_cache\.json/);

  // Catalog readable but silent about these models — also WARN, not FAIL.
  const stale = healthTierCheck(mkCodexHome('tier-stale', { models: [{ slug: 'gpt-4o', supported_reasoning_levels: levels('low') }] }));
  assert.equal(stale.status, 'WARN', `${stale.status}: ${stale.note}`);
});

test('persistRoute records the auto-resolved writer and fails loudly with no anchor', () => {
  const ledger = `# Tasks — demo
impl: auto
reviewer: auto

## T1: One
- status: pending
- risk: low
- files: a.ts
`;
  const task = R.parseTask(ledger, 'T1');
  assert.equal(task.impl, 'auto');
  const resolved = R.resolveRoute({ ...task, codexAvailable: true });
  const updated = R.persistRoute(ledger, 'T1', resolved);
  assert.match(updated, /- route: codex\/gpt-6-luna@max -> claude\/sonnet/);
  assert.match(updated, /- route-reason: low-risk bounded task delegated to the Codex writer; external writer/);
  assert.equal(R.parseTask(updated, 'T1').route, resolved.route);

  assert.throws(
    () => R.persistRoute('# t\n\n## T9: Nine\nprose only, no fields\n', 'T9', resolved),
    /no - status:\/- risk:\/- reviewer:\/- route: line to anchor/,
  );
});

test('an external writer is refused as its own reviewer', () => {
  assert.throws(
    () => R.resolveRoute({ risk: 'low', impl: 'codex', reviewer: 'codex', codexAvailable: true }),
    /codex cannot review its own diff/,
  );
  // Claude/Claude is NOT a violation — the reviewer is a fresh, independent context.
  assert.equal(
    R.resolveRoute({ risk: 'high', impl: 'claude', reviewer: 'claude', codexAvailable: true }).reviewer,
    'claude',
  );
});

test('formatRoute/parseRoute round-trip the resolved route including effort', () => {
  const resolved = R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true });
  assert.deepEqual(R.parseRoute(resolved.route), {
    impl: 'codex', writerModel: 'gpt-6-luna', writerEffort: 'max',
    reviewer: 'claude', reviewerModel: 'sonnet', reviewerEffort: null,
  });
  assert.equal(R.parseRoute('pending'), null);
  assert.equal(R.parseRoute('-'), null);
  assert.equal(R.parseRoute('cursor/x -> claude/y'), null, 'unknown backend is not a reusable route');
  assert.equal(R.parseRoute('claude/sonnet -> gemini/x'), null, 'gemini never reviews');
  // Routes persisted before CLAUDE_TIER carry the old `inherited` sentinel and replay verbatim.
  assert.equal(R.parseRoute('codex/gpt-6-luna@max -> claude/inherited').reviewerModel, 'inherited');
});

// The catalog must never reach a route the task will not run, and never
// invalidate one it already has.
test('a catalog does not fail a task pinned away from codex, nor a reused route', () => {
  const catalog = catalogFor(['low', 'medium']);   // the tier's `max`/`high` are gone

  // A pin to the Claude writer resolves to claude/opus -> claude/opus (high band):
  // zero codex. The `impl: auto` probe behind the explain-yourself rule must not
  // validate its hypothetical codex pair and kill the task on catalog drift.
  const pinned = `# Tasks
impl: auto
reviewer: auto

## T1: One
- status: pending
- risk: high
- impl: claude   # needs repo-wide context, not raw reasoning
- route: pending
`;
  // `implEffort` is what ARMS the per-axis gate — without an override the gate
  // skips the pair check and this case would pass with or without the probe's
  // `catalog: null`, i.e. pin nothing. With it, the probe's hypothetical
  // codex/gpt-6-astra@high is exactly the pair the stale catalog rejects.
  const r = R.resolveTask(pinned, 'T1', { codexAvailable: true, catalog, implEffort: 'high' });
  assert.equal(r.route, 'claude/opus@high -> claude/opus');

  // A route persisted BEFORE the catalog changed must still replay verbatim —
  // the same stickiness that keeps a Codex-unavailable fallback from flipping
  // mid-feature. Pinned here so a future refactor cannot hoist the pair check
  // above the reuse early-return without a test failing.
  const stored = `# Tasks
impl: auto
reviewer: auto

## T1: One
- status: pending
- risk: low
- route: codex/gpt-5.6-luna@max -> claude/inherited
`;
  const replayed = R.resolveTask(stored, 'T1', { codexAvailable: true, catalog });
  assert.equal(replayed.reused, true);
  assert.equal(replayed.route, 'codex/gpt-5.6-luna@max -> claude/inherited');
  assert.equal(replayed.writerEffort, 'max');
});

test('resolveTask reuses a persisted route instead of re-deriving it', () => {
  // Persisted while Codex was unavailable. Re-resolving with Codex back would
  // silently flip the writer mid-feature — the ledger must win.
  const ledger = `# Tasks
impl: auto
reviewer: auto

## T1: One
- status: pending
- risk: low
- route: claude/sonnet -> claude/inherited
- route-reason: automatic Codex writer unavailable; recorded fallback to Claude
`;
  const reused = R.resolveTask(ledger, 'T1', { codexAvailable: true });
  assert.equal(reused.reused, true);
  assert.equal(reused.impl, 'claude');
  assert.equal(reused.route, 'claude/sonnet -> claude/inherited');

  // An explicit override or --reroute is the only way to change a stored route.
  const rerouted = R.resolveTask(ledger, 'T1', { codexAvailable: true, reroute: true });
  assert.equal(rerouted.reused, false);
  assert.equal(rerouted.impl, 'codex');
  assert.equal(R.resolveTask(ledger, 'T1', { codexAvailable: true, impl: 'codex' }).impl, 'codex');

  // `pending` is not a route, so a fresh task still resolves.
  const pending = ledger.replace(/- route: .*/, '- route: pending');
  assert.equal(R.resolveTask(pending, 'T1', { codexAvailable: true }).reused, false);
});

test('resolveTask replays a reused Codex route with its persisted effort', () => {
  const ledger = `# Tasks
impl: auto
reviewer: auto

## T1: One
- status: pending
- risk: low
- route: codex/gpt-5.6-sol@high -> claude/inherited
`;
  const reused = R.resolveTask(ledger, 'T1', { codexAvailable: true });
  assert.equal(reused.reused, true);
  assert.equal(reused.writerModel, 'gpt-5.6-sol');
  assert.equal(reused.writerEffort, 'high', 'effort must survive the round-trip, not fall back to the tier default');
});

test('parseTask and persistRoute make route resumable in the ledger', () => {
  const ledger = `# Tasks — demo
impl: claude
reviewer: auto

## T1: One
- status: pending
- risk: low
- impl: -
- reviewer: -
- route: pending
- route-reason: -

## T2: Two
- status: pending
- risk: high
- impl: codex
- reviewer: -
- route: pending
`;
  const task = R.parseTask(ledger, 'T1');
  assert.equal(task.risk, 'low');
  assert.equal(task.impl, 'claude');
  assert.equal(task.reviewer, 'auto');
  const resolved = R.resolveRoute({ ...task, codexAvailable: true });
  const updated = R.persistRoute(ledger, 'T1', resolved);
  assert.match(updated, /- route: claude\/sonnet -> codex\/gpt-6-luna/);
  assert.match(updated, /- route-reason: low-risk Claude-authored task/);
  assert.match(updated, /## T2: Two[\s\S]*- route: pending/);
  assert.equal(R.parseTask(updated, 'T1').route, resolved.route);
});

test('requireRoute refuses a task dispatched before route.js resolved it', () => {
  const ledger = `# Tasks — demo
impl: auto
reviewer: auto

## T1: Unrouted
- status: pending
- risk: high
- impl: -
- reviewer: -
- route: pending

## T2: Routed
- status: pending
- risk: medium
- impl: -
- reviewer: -
- route: codex/gpt-5.6-sol@medium -> claude/inherited

## T3: Garbled
- status: pending
- risk: low
- route: sonnet
`;
  // `pending` — the exact state that let 3 of 10 tasks dispatch off-router.
  assert.throws(() => R.requireRoute(ledger, 'T1'), /no persisted route \(found "pending"\)/);
  // An unparseable route is not a route either: it can't be replayed on resume.
  assert.throws(() => R.requireRoute(ledger, 'T3'), /no persisted route/);
  // A missing task is a mislabelled dispatch, and must not pass the gate.
  assert.throws(() => R.requireRoute(ledger, 'T9'), /not found in ledger/);

  const ok = R.requireRoute(ledger, 'T2');
  assert.equal(ok.impl, 'codex');
  assert.equal(ok.writerModel, 'gpt-5.6-sol');
  assert.equal(ok.writerEffort, 'medium');
  assert.equal(ok.reviewer, 'claude');
  assert.equal(ok.risk, 'medium');
  assert.equal(ok.route, 'codex/gpt-5.6-sol@medium -> claude/inherited');
});

test('requireRoute never resolves or writes — it only reports', () => {
  const ledger = `## T1: One
- status: pending
- risk: low
- route: pending
`;
  // resolveTask WOULD happily derive a route here; the gate must not, or it
  // repairs the very omission it exists to catch.
  assert.equal(R.resolveTask(ledger, 'T1', { codexAvailable: true }).reused, false);
  assert.throws(() => R.requireRoute(ledger, 'T1'), /resolve it first/);
});

test('U11: docs and config classes skip the per-task reviewer gate', () => {
  const docsLedger = `# Tasks
impl: auto
reviewer: auto

## T1: Docs
- status: pending
- risk: low
- class: docs   # prose-only task
- route: pending
`;
  const docs = R.resolveTask(docsLedger, 'T1', { codexAvailable: true });
  assert.equal(docs.reviewRequired, false, 'docs tasks must skip the per-task reviewer gate');

  const configLedger = `# Tasks
impl: auto
reviewer: auto

## T1: Config
- status: pending
- risk: medium
- class: config
- route: pending
`;
  const config = R.resolveTask(configLedger, 'T1', { codexAvailable: true });
  assert.equal(config.reviewRequired, false, 'config tasks must skip the per-task reviewer gate');
});

test('U12: an absent class defaults to logic and requires review', () => {
  const ledger = `# Tasks
impl: auto
reviewer: auto

## T1: Logic
- status: pending
- risk: low
- route: pending
`;
  assert.equal(R.parseTask(ledger, 'T1').class, 'logic');
  assert.equal(R.resolveTask(ledger, 'T1', { codexAvailable: true }).reviewRequired, true);
});

test('U13: an unknown class is rejected with the valid set', () => {
  const ledger = `# Tasks
impl: auto
reviewer: auto

## T1: Misspelled class
- status: pending
- risk: low
- class: doc
- route: pending
`;
  assert.throws(
    () => R.parseTask(ledger, 'T1'),
    /route: class must be logic, security, docs, or config \(got "doc"\)/,
  );
});

test('U14: sticky resolve and requireRoute reread class for reviewRequired', () => {
  const ledger = `# Tasks
impl: auto
reviewer: auto

## T1: Reused docs task
- status: pending
- risk: low
- class: docs
- route: codex/gpt-5.6-luna@max -> claude/inherited
`;
  const reused = R.resolveTask(ledger, 'T1', { codexAvailable: true });
  assert.equal(reused.reused, true);
  assert.equal(reused.reviewRequired, false, 'sticky resolve must derive the gate from the current class');

  const required = R.requireRoute(ledger, 'T1');
  assert.equal(required.reviewRequired, false, 'requireRoute must report the current class gate');
});

test('U15: class config does not change the route; class docs moves only the writer, never independence', () => {
  const plainLedger = `# Tasks
impl: auto
reviewer: auto

## T1: Same task
- status: pending
- risk: low
- route: pending
`;
  const classedLedger = `# Tasks
impl: auto
reviewer: auto

## T1: Same task
- status: pending
- risk: low
- class: config
- route: pending
`;
  const plain = R.resolveTask(plainLedger, 'T1', { codexAvailable: true, geminiAvailable: true });
  const classed = R.resolveTask(classedLedger, 'T1', { codexAvailable: true, geminiAvailable: true });
  assert.equal(classed.route, plain.route);
  assert.equal(classed.impl, plain.impl);
  assert.equal(classed.reviewer, plain.reviewer);
  assert.notEqual(classed.impl, classed.reviewer, 'class must not weaken writer/reviewer independence');

  const routeLine = (ledger) => ledger.match(/^- route: .*$/m)[0];
  assert.equal(routeLine(R.persistRoute(classedLedger, 'T1', classed)), routeLine(R.persistRoute(plainLedger, 'T1', plain)));

  const docs = R.resolveTask(classedLedger.replace('class: config', 'class: docs'), 'T1', { codexAvailable: true, geminiAvailable: true });
  assert.equal(docs.impl, 'gemini');
  assert.equal(docs.reviewer, plain.reviewer, 'docs changes the writer only');
  assert.notEqual(docs.impl, docs.reviewer, 'a Gemini draft is never its own reviewer');
});

test('U14: pinned-contradiction resolve carries the class gate', () => {
  const ledger = `# Tasks
impl: auto
reviewer: auto

## T1: Pinned docs task
- status: pending
- risk: low
- class: docs
- impl: claude
- impl-reason: this task needs the Claude writer for repository context
- route: pending
`;
  const resolved = R.resolveTask(ledger, 'T1', { codexAvailable: true, geminiAvailable: true });
  assert.equal(resolved.impl, 'claude');
  assert.match(resolved.implReason, /pinned to claude against the automatic route \(gemini\)/);
  assert.equal(resolved.reviewRequired, false, 'pinned-contradiction resolve must carry the class gate');
});

/*
 * Mutation ledger (full `node --test test/*.test.js`; restore route.js after each):
 *
 * | mutation | first assertion that must RED |
 * |---|---|
 * | C1: reviewRequiredFor → cls === 'logic' | security/P1 plain resolve reviewRequired mismatch |
 * | B1: sticky/reused resolve return hardcoded false | logic/P2 sticky reuse reviewRequired mismatch |
 * | B2: pinned-contradiction return hardcoded false | logic/P3 pinned contradiction reviewRequired mismatch |
 * | B4: requireRoute return hardcoded false | logic/P4 requireRoute reviewRequired mismatch |
 *
 * This source-scan tripwire counts the four current field-carrying call sites,
 * but it does NOT catch a new exit path that omits the field; only a test
 * exercising that path does.
 */
test('reviewRequired is boolean and pinned across every class and exit path', () => {
  const surface = [
    {
      class: 'logic',
      expected: true,
      fixtures: {
        'P1 plain resolve': `# Tasks
impl: auto
reviewer: auto

## T1: Logic plain resolve
- status: pending
- risk: low
- class: logic
- route: pending
`,
        'P2 sticky reuse': `# Tasks
impl: auto
reviewer: auto

## T1: Logic sticky reuse
- status: pending
- risk: low
- class: logic
- route: codex/gpt-5.6-luna@max -> claude/inherited
`,
        'P3 pinned contradiction': `# Tasks
impl: auto
reviewer: auto

## T1: Logic pinned contradiction
- status: pending
- risk: low
- class: logic
- impl: claude
- impl-reason: this task needs the Claude writer for repository context
- route: pending
`,
        'P4 requireRoute': `# Tasks
impl: auto
reviewer: auto

## T1: Logic requireRoute
- status: pending
- risk: low
- class: logic
- route: codex/gpt-5.6-luna@max -> claude/inherited
`,
      },
    },
    {
      class: 'security',
      expected: true,
      fixtures: {
        'P1 plain resolve': `# Tasks
impl: auto
reviewer: auto

## T1: Security plain resolve
- status: pending
- risk: low
- class: security
- route: pending
`,
        'P2 sticky reuse': `# Tasks
impl: auto
reviewer: auto

## T1: Security sticky reuse
- status: pending
- risk: low
- class: security
- route: codex/gpt-5.6-luna@max -> claude/inherited
`,
        'P3 pinned contradiction': `# Tasks
impl: auto
reviewer: auto

## T1: Security pinned contradiction
- status: pending
- risk: low
- class: security
- impl: claude
- impl-reason: this task needs the Claude writer for repository context
- route: pending
`,
        'P4 requireRoute': `# Tasks
impl: auto
reviewer: auto

## T1: Security requireRoute
- status: pending
- risk: low
- class: security
- route: codex/gpt-5.6-luna@max -> claude/inherited
`,
      },
    },
    {
      class: 'docs',
      expected: false,
      fixtures: {
        'P1 plain resolve': `# Tasks
impl: auto
reviewer: auto

## T1: Docs plain resolve
- status: pending
- risk: low
- class: docs
- route: pending
`,
        'P2 sticky reuse': `# Tasks
impl: auto
reviewer: auto

## T1: Docs sticky reuse
- status: pending
- risk: low
- class: docs
- route: codex/gpt-5.6-luna@max -> claude/inherited
`,
        'P3 pinned contradiction': `# Tasks
impl: auto
reviewer: auto

## T1: Docs pinned contradiction
- status: pending
- risk: low
- class: docs
- impl: claude
- impl-reason: this task needs the Claude writer for repository context
- route: pending
`,
        'P4 requireRoute': `# Tasks
impl: auto
reviewer: auto

## T1: Docs requireRoute
- status: pending
- risk: low
- class: docs
- route: codex/gpt-5.6-luna@max -> claude/inherited
`,
      },
    },
    {
      class: 'config',
      expected: false,
      fixtures: {
        'P1 plain resolve': `# Tasks
impl: auto
reviewer: auto

## T1: Config plain resolve
- status: pending
- risk: low
- class: config
- route: pending
`,
        'P2 sticky reuse': `# Tasks
impl: auto
reviewer: auto

## T1: Config sticky reuse
- status: pending
- risk: low
- class: config
- route: codex/gpt-5.6-luna@max -> claude/inherited
`,
        'P3 pinned contradiction': `# Tasks
impl: auto
reviewer: auto

## T1: Config pinned contradiction
- status: pending
- risk: low
- class: config
- impl: claude
- impl-reason: this task needs the Claude writer for repository context
- route: pending
`,
        'P4 requireRoute': `# Tasks
impl: auto
reviewer: auto

## T1: Config requireRoute
- status: pending
- risk: low
- class: config
- route: codex/gpt-5.6-luna@max -> claude/inherited
`,
      },
    },
  ];
  assert.ok(R.CLASSES instanceof Set, 'route.js must export CLASSES for completeness coverage');
  assert.deepStrictEqual(
    surface.map(({ class: taskClass }) => taskClass).sort(),
    [...R.CLASSES].sort(),
    'the table class column must cover exactly CLASSES',
  );

  const exitPaths = ['P1 plain resolve', 'P2 sticky reuse', 'P3 pinned contradiction', 'P4 requireRoute'];
  for (const row of surface) {
    assert.deepStrictEqual(Object.keys(row.fixtures).sort(), [...exitPaths].sort(), `${row.class} must cover every exit path`);
    for (const [exitPath, ledger] of Object.entries(row.fixtures)) {
      const result = exitPath === 'P4 requireRoute'
        ? R.requireRoute(ledger, 'T1')
        : R.resolveTask(ledger, 'T1', { codexAvailable: true });
      assert.strictEqual(typeof result.reviewRequired, 'boolean', `${row.class}/${exitPath} must expose a boolean reviewRequired`);
      assert.strictEqual(result.reviewRequired, row.expected, `${row.class}/${exitPath} reviewRequired mismatch`);
    }
  }

  const routeSource = fs.readFileSync(path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'route.js'), 'utf8');
  const reviewRequiredCallSites = routeSource.match(/reviewRequiredFor\(task\.class\)/g) || [];
  // Secondary tripwire: four call sites currently carry reviewRequired. This
  // does NOT catch a new exit path that omits the field; only a test exercising
  // that path does, so the table must grow when the exit surface grows.
  assert.strictEqual(reviewRequiredCallSites.length, 4, 'route.js must derive reviewRequired on every exit path');
});

// A per-task pin that contradicts the automatic route must say why. Regression
// cover for 2026-08-02, where four high-risk tasks were pinned to Claude by a
// /build brief and silently opted out of the cross-provider policy.
const pinned = (extra, risk = 'high') => `# Tasks — demo
impl: auto
reviewer: auto

## T1: Pinned
- status: pending
- risk: ${risk}
${extra}
- route: pending
`;

test('an unexplained per-task pin against the automatic route is refused', () => {
  assert.throws(
    () => R.resolveTask(pinned('- impl: claude'), 'T1', { codexAvailable: true }),
    /pins `impl: claude` but the automatic route for a high-risk task is `codex`/,
  );
  // The message has to say how to comply, not just that it failed.
  assert.throws(() => R.resolveTask(pinned('- impl: claude'), 'T1', { codexAvailable: true }), /impl-reason/);
});

test('a pin earns its exception with impl-reason, and the reason is persisted', () => {
  const ledger = pinned('- impl: claude\n- impl-reason: the offline gate cannot detect a wrong breakpoint');
  const r = R.resolveTask(ledger, 'T1', { codexAvailable: true });
  assert.equal(r.impl, 'claude');
  assert.match(r.reason, /pinned to claude against the automatic route \(codex\)/);
  assert.match(r.reason, /offline gate cannot detect a wrong breakpoint/);
  // It must reach the ledger, or the exception is not auditable on resume.
  assert.match(R.persistRoute(ledger, 'T1', r), /- route-reason: pinned to claude against the automatic route/);
});

test('a `# …` note on the impl line counts as the reason (and no longer breaks parsing)', () => {
  // This shape existed in real ledgers and used to throw "impl must be auto,
  // claude, or codex" on the whole comment — so the task never routed at all.
  const ledger = pinned('- impl: claude   # capability: the sandboxed codex writer has NO network');
  assert.equal(R.parseTask(ledger, 'T1').impl, 'claude');
  const r = R.resolveTask(ledger, 'T1', { codexAvailable: true });
  assert.match(r.reason, /capability: the sandboxed codex writer has NO network/);
});

test('a pin that AGREES with the automatic route needs no reason', () => {
  const r = R.resolveTask(pinned('- impl: codex'), 'T1', { codexAvailable: true });
  assert.equal(r.impl, 'codex');
  assert.equal(r.reviewer, 'claude');
});

test('no pin, an inherited header, and an unavailable Codex are all exempt', () => {
  // `- impl: -` inherits; the header is the feature's declared policy, not a pin.
  assert.equal(R.resolveTask(pinned('- impl: -'), 'T1', { codexAvailable: true }).impl, 'codex');
  // With Codex gone, `auto` resolves to claude too — the pin no longer contradicts.
  assert.equal(R.resolveTask(pinned('- impl: claude'), 'T1', { codexAvailable: false }).impl, 'claude');
});

test('a CLI --impl is exempt from the explain-yourself rule', () => {
  // Typed by a human in the moment and visible in the invocation.
  const r = R.resolveTask(pinned('- impl: claude'), 'T1', { impl: 'claude', codexAvailable: true });
  assert.equal(r.impl, 'claude');
});

// --- the writer axis goes to Codex at EVERY band ---------------------------
// Regression cover for a prose/code divergence found 2026-08-02: the body of
// /design still told the Eng Manager "low/medium implementation goes to Codex,
// high-risk stays on Claude" — the pre-fix policy. route.js had already moved to
// Codex at every band (risk buys a reasoning tier, not a provider), so the one
// command whose job is to route work was describing the opposite of what
// route.js does, and it misrouted a planning summary before anyone noticed.

test('impl: auto sends the writer to Codex at every risk band', () => {
  for (const [risk, model, effort] of [
    ['low', 'gpt-6-luna', 'max'],
    ['medium', 'gpt-6.1-sol', 'medium'],
    ['high', 'gpt-6.1-sol', 'xhigh'],
  ]) {
    const r = R.resolveRoute({ risk, impl: 'auto', reviewer: 'auto', codexAvailable: true });
    assert.equal(r.impl, 'codex', `${risk}-risk writer must be Codex`);
    assert.equal(r.writerModel, model, `${risk} rides the ${model} tier`);
    assert.equal(r.writerEffort, effort);
    // The interlock that makes delegating high risk safe.
    assert.equal(r.reviewer, 'claude', 'an external writer always gets a fresh Claude reviewer');
  }
});

test('no plugin instruction file claims high-risk IMPLEMENTATION stays on Claude', () => {
  // Pinned as bidirectional set-equality against an explicit literal rather than
  // a cleverness regex (L11): a predicate that merely has to be *satisfied* rots,
  // and "stays on Claude" is legitimately true on the REVIEWER axis, so a naive
  // grep would either false-positive forever or be weakened until it catches
  // nothing. An author adding the phrase anywhere must consciously edit this map.
  const EXPECTED = {
    // The one legitimate occurrence: reviewer axis. A Claude-authored high-risk
    // task does keep Claude review (route.js: 'high-risk task stays on the fresh
    // Claude quality gate'). The WRITER for that same task is still Codex.
    'plugins/rstaff-engineer/skills/parallel-build/references/task-format.md': 1,
  };
  const root = path.join(__dirname, '../..');
  const found = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.md')) {
        const lines = fs.readFileSync(path.join(root, child), 'utf8').split('\n');
        const hits = lines
          .map((l, i) => ({ l, i }))
          .filter(({ l }) => /stays on Claude/i.test(l));
        if (hits.length) {
          found[child] = hits.length;
          // Semantic half: every surviving occurrence must be about review.
          // Checked over a 3-line window, not the matched line alone — prose
          // wraps, and the reviewer bullet this legitimately belongs to carries
          // "reviewer" two lines above the phrase.
          for (const { l, i } of hits) {
            const window = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
            assert.match(window, /review/i,
              `"stays on Claude" in ${child} is not on the reviewer axis — the writer goes to Codex at every band:\n  ${l.trim()}`);
          }
        }
      }
    }
  };
  const pluginsRoot = path.join(root, 'plugins');
  for (const plugin of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    for (const kind of ['commands', 'agents', 'skills', 'rules']) {
      const dir = `plugins/${plugin.name}/${kind}`;
      if (fs.existsSync(path.join(root, dir))) walk(dir);
    }
  }
  // Fail-closed: an empty result is a change too (the reviewer line was deleted).
  assert.deepEqual(found, EXPECTED);
});

// The tier rows in both routing docs must equal
// CODEX_TIER. Parsed, not grepped: a doc that drifts reds against the code.
test('routing.md and task-format.md tier rows equal CODEX_TIER', () => {
  const root = path.join(__dirname, '../..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const asTier = (pairs) => Object.fromEntries(pairs.map(([band, model, effort]) => [band, { model, effort }]));

  // routing.md writer table: `| low | Codex | `gpt-6-luna` | max |`
  const routing = read('plugins/rstaff-delegation/skills/token-efficient-delegation/references/routing.md');
  const writerRows = [...routing.matchAll(/^\| (low|medium|high) \| Codex \| `([^`]+)` \| (\w+) \|$/gm)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.equal(writerRows.length, 3, 'routing.md writer table must list all three bands');
  assert.deepEqual(asTier(writerRows), R.CODEX_TIER, 'routing.md writer table drifted from CODEX_TIER');

  // routing.md reviewer table: the Claude-writer low/medium rows judge at the same tier.
  const reviewerRows = [...routing.matchAll(/^\| Claude \| (low|medium) \| Codex \| `([^`]+)` \| (\w+) \|$/gm)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.equal(reviewerRows.length, 2, 'routing.md reviewer table must list the low and medium Codex rows');
  for (const [band, model, effort] of reviewerRows) {
    assert.deepEqual({ model, effort }, R.CODEX_TIER[band], `routing.md reviewer row for ${band} drifted from CODEX_TIER`);
  }

  // task-format.md writer bullet: `low → `gpt-6-luna@max`, medium → …`
  const taskFormat = read('plugins/rstaff-engineer/skills/parallel-build/references/task-format.md');
  const bulletRows = [...taskFormat.matchAll(/(low|medium|high) → `([^`@]+)@(\w+)`/g)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.equal(bulletRows.length, 3, 'task-format.md must spell out all three writer tiers as `model@effort`');
  assert.deepEqual(asTier(bulletRows), R.CODEX_TIER, 'task-format.md writer bullet drifted from CODEX_TIER');

  // routing.md Claude tier table: `| low | Claude | `sonnet` |`
  const claudeRows = [...routing.matchAll(/^\| (low|medium|high) \| Claude \| `(\w+)` \|$/gm)]
    .map((m) => [m[1], m[2]]);
  assert.equal(claudeRows.length, 3, 'routing.md Claude tier table must list all three bands');
  assert.deepEqual(Object.fromEntries(claudeRows.map(([b, model]) => [b, { model }])), R.CLAUDE_TIER, 'routing.md Claude tier drifted from CLAUDE_TIER');
  // The docs-class row names the Gemini drafter route.js uses.
  assert.match(routing, new RegExp('class: docs.*`' + R.GEMINI_DOCS_MODEL + '`'), 'routing.md must state the class: docs Gemini drafter');
  assert.match(taskFormat, new RegExp('class: docs.*`' + R.GEMINI_DOCS_MODEL + '`'), 'task-format.md must state the class: docs Gemini drafter');
});

test('splitComment keeps enum values clean and free-text reasons intact', () => {
  assert.deepEqual(R.splitComment('claude   # why'), { value: 'claude', comment: 'why' });
  assert.deepEqual(R.splitComment('codex'), { value: 'codex', comment: null });
  assert.deepEqual(R.splitComment('claude #'), { value: 'claude', comment: null });
  // route-reason is free text: a `#` in it must not be mistaken for a field
  // comment, and must not disturb the surrounding fields.
  const ledger = pinned('- impl: -\n- route-reason: uses # in prose');
  assert.equal(R.parseTask(ledger, 'T1').impl, 'auto');   // inherited header, not a pin
  assert.equal(R.parseTask(ledger, 'T1').implPinned, false);
  assert.equal(R.resolveTask(ledger, 'T1', { codexAvailable: true }).impl, 'codex');
});

function extractParseTaskFields(routeSource) {
  const parseTaskStart = routeSource.indexOf('function parseTask(');
  assert.ok(parseTaskStart >= 0, 'route.js must contain parseTask');
  const parseTaskEndMarker = '\n}\n\nfunction resolveRoute(';
  const parseTaskEnd = routeSource.indexOf(parseTaskEndMarker, parseTaskStart);
  assert.ok(parseTaskEnd > parseTaskStart, 'route.js parseTask boundary must be found');
  const parseTaskSource = routeSource.slice(parseTaskStart, parseTaskEnd);
  return new Set(
    [...parseTaskSource.matchAll(/value\s*\(\s*section\.text\s*,\s*['"]([^'"]+)['"]/g)]
      .map(([, field]) => field),
  );
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('parseTask fields stay synchronized with the schema and /design ledger enumeration', () => {
  const root = path.join(__dirname, '../..');
  const routeSource = fs.readFileSync(path.join(root, 'plugins', 'rstaff-delegation', 'scripts', 'route.js'), 'utf8');
  const taskFields = extractParseTaskFields(routeSource);
  assert.ok(taskFields.size > 0, 'route.js field extractor must find at least one parseTask field');

  const taskFormat = fs.readFileSync(
    path.join(root, 'plugins', 'rstaff-engineer', 'skills', 'parallel-build', 'references', 'task-format.md'),
    'utf8',
  );
  const schemaStartMarker = '## Schema\n\n```markdown\n';
  const schemaStart = taskFormat.indexOf(schemaStartMarker);
  assert.ok(schemaStart >= 0, 'task-format.md schema block must be found');
  const schemaEndMarker = '\n```\n\n## Rules';
  const schemaEnd = taskFormat.indexOf(schemaEndMarker, schemaStart + schemaStartMarker.length);
  assert.ok(schemaEnd > schemaStart, 'task-format.md schema block boundary must be found');
  const schemaBlock = taskFormat.slice(schemaStart + schemaStartMarker.length, schemaEnd);
  assert.ok(schemaBlock.length > 0, 'task-format.md schema block must be non-empty');

  const plan = fs.readFileSync(path.join(root, 'plugins', 'rstaff-engineer', 'commands', 'design.md'), 'utf8');
  const enumerationStartMarker = 'with `deps`';
  const enumerationStart = plan.indexOf(enumerationStartMarker);
  assert.ok(enumerationStart >= 0, 'design.md ledger-field enumeration must be found');
  const enumerationEndMarker = '; set the ledger';
  const enumerationEnd = plan.indexOf(enumerationEndMarker, enumerationStart + enumerationStartMarker.length);
  assert.ok(enumerationEnd > enumerationStart, 'design.md ledger-field enumeration boundary must be found');
  const enumeration = plan.slice(enumerationStart, enumerationEnd);
  assert.ok(enumeration.length > 0, 'design.md ledger-field enumeration must be non-empty');

  const schemaMissing = [...taskFields].filter((field) => !new RegExp(
    `^\\s*-\\s*${escapeRegExp(field)}\\s*:`,
    'm',
  ).test(schemaBlock));
  const enumerationMissing = [...taskFields].filter((field) => !new RegExp(
    '`' + escapeRegExp(field) + '(?:`|:)',
  ).test(enumeration));
  assert.deepStrictEqual(
    { schemaMissing, enumerationMissing },
    { schemaMissing: [], enumerationMissing: [] },
    'every field parseTask reads must appear in both documentation regions',
  );
});

// --- The `codex default model` check reads the dedicated CLI home ---
// Same reasoning as the tier check above: this block reads the dedicated codex home and shells
// `codex --version`, so `health --static` never reaches it and the PASS/WARN
// mapping would otherwise be code no test has ever run. Report-only is an
// operator DECISION, so "never FAIL" is pinned here rather than left to prose.

test('health WARNs, naming the model, when the cache was written by a NEWER codex', () => {
  const home = mkCodexHome('dm-newer', { client_version: '0.153.4', models: [] }, 'gpt-6-astra');
  const c = healthCheck('codex default model', home, { codexVersion: 'codex-cli 0.146.0' });
  assert.ok(c, 'health must report the check at all');
  assert.equal(c.status, 'WARN', `${c.status}: ${c.note}`);
  // The note has to carry the model, BOTH versions, and the fix — a WARN that
  // does not name them leaves the operator with nothing to act on.
  assert.match(c.note, /gpt-6-astra/, 'the WARN must name the model that would run');
  assert.match(c.note, /0\.153\.4/, 'the WARN must name the cache version');
  assert.match(c.note, /0\.146\.0/, 'the WARN must name the CLI version');
  assert.match(c.note, /codex update/, 'a WARN must carry the fix');
  // ...and the fix must name the home rstaff SPAWNS INTO. Without the CODEX_HOME=
  // prefix the operator refreshes their shared ~/.codex, which the spawned CLI no
  // longer reads — so the WARN comes back unchanged and looks like a fix that will
  // not take. That is the failure this check's own comment warns about.
  assert.match(c.note, new RegExp(`CODEX_HOME=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'the fix must refresh the DEDICATED home, not the shared one');
});

test('health names the model an UNSEEDED dedicated home will actually run', () => {
  // `var/` is gitignored and nothing outside delegate.run() seeds the home, so a
  // fresh clone's first `/health` — the documented first post-install step — reads
  // an empty directory. It reported "declares no top-level `model =`" while the
  // seeded home resolves the operator's own pin: the exact opposite of what codex
  // will run, on the one check whose whole job is to say what codex will run.
  const source = mkCodexHome('dm-source', null, 'gpt-6-astra');
  const unseeded = mkCodexHome('dm-unseeded', { client_version: '0.146.0', models: [] }, null);
  const c = healthCheck('codex default model', unseeded,
    { codexVersion: 'codex-cli 0.146.0', sharedHome: source });
  assert.ok(c, 'health must report the check at all');
  assert.notEqual(c.status, 'FAIL', 'this check is REPORT-ONLY');
  assert.match(c.note, /gpt-6-astra/, 'it must name the model the spawned codex will read');
  assert.match(c.note, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'and name the source config.toml it read that from, since the dedicated home has none');
});

test('health PASSes ONLY on an exact match, and never FAILs on any input', () => {
  const equal = healthCheck('codex default model',
    mkCodexHome('dm-equal', { client_version: '0.146.0', models: [] }, 'gpt-5.6-sol'),
    { codexVersion: 'codex-cli 0.146.0' });
  assert.equal(equal.status, 'PASS', `${equal.status}: ${equal.note}`);
  assert.match(equal.note, /gpt-5\.6-sol/);

  // A stale cache used to pass. The CLI discards a stale cache exactly as it
  // discards a newer one, so a silent PASS here told the operator their tier
  // verdicts were live when codex had already fallen back to built-in metadata.
  const older = healthCheck('codex default model',
    mkCodexHome('dm-older', { client_version: '0.140.0', models: [] }, 'gpt-5.6-sol'),
    { codexVersion: 'codex-cli 0.146.0' });
  assert.equal(older.status, 'WARN', `${older.status}: ${older.note}`);
  assert.match(older.note, /0\.140\.0/, 'the WARN must name the cache version');
  assert.match(older.note, /0\.146\.0/, 'the WARN must name the CLI version');
  // The stale fix is a refetch, NOT `codex update` — the CLI is already ahead.
  assert.doesNotMatch(older.note, /codex update/, 'upgrading does not re-stamp a stale cache');

  // Every way this check can fail to answer, swept together. Report-only was an
  // explicit decision (the tier table still works under the observed skew, so
  // blocking would take the working routes down with the broken one) — assert the
  // CLASS, not one instance, or a later edit can turn any single branch into a
  // FAIL and take `make health` to exit 1 with nothing red.
  const fixtures = [
    ['newer', mkCodexHome('dm-c1', { client_version: '0.153.4', models: [] }, 'gpt-6-astra'), { codexVersion: 'codex-cli 0.146.0' }],
    ['equal', mkCodexHome('dm-c2', { client_version: '0.146.0', models: [] }, 'gpt-5.6-sol'), { codexVersion: 'codex-cli 0.146.0' }],
    ['no catalog', mkCodexHome('dm-c3', null, 'gpt-5.6-sol'), { codexVersion: 'codex-cli 0.146.0' }],
    ['no config.toml', mkCodexHome('dm-c4', { client_version: '0.146.0', models: [] }, null), { codexVersion: 'codex-cli 0.146.0' }],
    ['unparsable codex --version', mkCodexHome('dm-c5', { client_version: '0.153.4', models: [] }, 'gpt-6-astra'), { codexVersion: 'not a version' }],
    ['codex absent from PATH', mkCodexHome('dm-c6', { client_version: '0.153.4', models: [] }, 'gpt-6-astra'), {}],
  ];
  for (const [why, home, opts] of fixtures) {
    const c = healthCheck('codex default model', home, opts);
    assert.ok(c, `${why}: the check must always report`);
    assert.notEqual(c.status, 'FAIL',
      `${why}: this check is REPORT-ONLY — a FAIL takes \`make health\` to exit 1 (health.js exits on any FAIL)`);
    assert.ok(['PASS', 'WARN'].includes(c.status), `${why}: unexpected status ${c.status}`);
  }
});

// --- The checks read the dedicated home used by the CLI -------------------
// checkTierSupport / catalogParity / the default-model pin are only worth anything
// while they read the SAME models_cache.json the spawned CLI loads. Two codex builds
// sharing ~/.codex made that false: the newest writer won the file and the CLI rstaff
// spawns discarded it. delegate.js now gives those runs their own CODEX_HOME, so
// these loaders have to resolve through the same function — not a second copy of the
// path, which is exactly how a doctor passes while the thing it certifies is broken.
const D = require(path.join(__dirname, '../..', 'plugins', 'rstaff-delegation', 'scripts', 'delegate.js'));
const withCodexHomes = (dedicated, shared, fn) => {
  const saved = [process.env.RSTAFF_CODEX_HOME, process.env.CODEX_HOME];
  try {
    process.env.RSTAFF_CODEX_HOME = dedicated;
    process.env.CODEX_HOME = shared;
    return fn();
  } finally {
    if (saved[0] === undefined) delete process.env.RSTAFF_CODEX_HOME; else process.env.RSTAFF_CODEX_HOME = saved[0];
    if (saved[1] === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved[1];
  }
};

test('route.codexHome is delegate.codexHome — one resolver, not two copies of a path', () => {
  const ctrl = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-route-ctrl-'));
  fs.writeFileSync(path.join(ctrl, 'rstaff.json'), '{}');
  withCodexHomes(path.join(ctrl, 'var', 'codex-home'), ctrl, () => {
    assert.equal(R.codexHome(), D.codexHome());
  });
});

test('loadCodexCatalog reads the dedicated home, not the shared ~/.codex', () => {
  const dedicated = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ded-'));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-shared-'));
  fs.writeFileSync(path.join(dedicated, 'models_cache.json'), JSON.stringify({ client_version: '0.153.2', models: [] }));
  fs.writeFileSync(path.join(shared, 'models_cache.json'), JSON.stringify({ client_version: '0.153.4', models: [] }));
  const catalog = withCodexHomes(dedicated, shared, () => R.loadCodexCatalog());
  assert.equal(catalog.client_version, '0.153.2');
});

test('loadCodexDefaultModel reads the dedicated home, not the shared ~/.codex', () => {
  const dedicated = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ded-'));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-shared-'));
  fs.writeFileSync(path.join(dedicated, 'config.toml'), 'model = "gpt-6-astra"\n');
  fs.writeFileSync(path.join(shared, 'config.toml'), 'model = "decoy"\n');
  assert.equal(withCodexHomes(dedicated, shared, () => R.loadCodexDefaultModel()), 'gpt-6-astra');
});

// /health certifies a catalog; its source is the dedicated
// codex home. Its notes have to name THAT home — a fix that says "run any codex
// command" sends the operator to refresh the shared ~/.codex, which is the file the
// spawned CLI is no longer reading.
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('health: the no-catalog WARN names the dedicated home and how to populate THAT home', () => {
  const home = mkCodexHome('tier-dedicated', null);
  const c = healthTierCheck(home);
  assert.equal(c.status, 'WARN', `${c.status}: ${c.note}`);
  assert.match(c.note, new RegExp(reEscape(path.join(home, 'models_cache.json'))),
    'the WARN must name the cache path rstaff actually reads');
  assert.match(c.note, new RegExp(`CODEX_HOME=${reEscape(home)}`),
    'the fix must populate the dedicated home; a bare `codex` run refreshes the operator\'s own home instead');
});

test('health: the default-model check reads config.toml from the dedicated home', () => {
  const home = mkCodexHome('dm-dedicated', { client_version: '0.146.0', models: [] });   // no config.toml
  const c = healthCheck('codex default model', home, { codexVersion: 'codex-cli 0.146.0' });
  assert.match(c.note, new RegExp(reEscape(path.join(home, 'config.toml'))),
    'the note must name the config the spawned codex will actually load');
});

// ---- Weekly quota limit check ----
const NOW = Date.parse('2026-10-02T06:00:00Z');
const brake = (percent = 90, threshold = 85) => ({
  tripped: percent >= threshold, percent, threshold, resetsAt: NOW / 1000 + 3600,
  reason: `codex weekly quota ${percent}% >= ${threshold}% brake (rstaff.json codexQuota.weeklyBrakePercent)`,
});
const autoLedger = (risk = 'low', extra = '') => `# Tasks
impl: auto
reviewer: auto

## T1: One
- status: pending
- risk: ${risk}
${extra}- route: pending
`;

function quotaHome(percent, { rows, json } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-brake-'));
  fs.mkdirSync(path.join(home, 'var'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), JSON.stringify(json === undefined ? { codexQuota: { weeklyBrakePercent: 85 } } : json));
  const row = (ts, adapter, end, resetsAt = NOW / 1000 + 3600) => JSON.stringify({
    id: `${adapter}:${ts}`, timestamp: new Date(ts).toISOString(), adapter,
    quota: end === null ? null : { secondary: { start: end, end, resetsAt, reset: false } },
  });
  const lines = rows ? rows(row) : [row(NOW - 1000, 'codex', percent)];
  fs.writeFileSync(path.join(home, 'var', 'usage.jsonl'), lines.join('\n') + '\n');
  return home;
}

test('quota brake: auto writer falls back to claude with the reason, else codex as today', () => {
  const t = R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true, quotaBrake: brake(90) });
  assert.equal(t.impl, 'claude');
  assert.equal(t.implReason, 'codex weekly quota 90% >= 85% brake (rstaff.json codexQuota.weeklyBrakePercent); recorded fallback to Claude');
  for (const quotaBrake of [null, undefined, brake(80)]) {
    assert.equal(R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: true, quotaBrake }).impl, 'codex');
  }
  const high = R.resolveRoute({ risk: 'high', impl: 'auto', reviewer: 'auto', codexAvailable: true, quotaBrake: brake(90) });
  assert.equal(high.impl, 'claude');
});

test('quota brake: auto reviewer on a Claude-authored low-risk task falls back to claude', () => {
  const t = R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'auto', codexAvailable: true, quotaBrake: brake(90) });
  assert.equal(t.reviewer, 'claude');
  assert.equal(t.reviewReason, 'codex weekly quota 90% >= 85% brake (rstaff.json codexQuota.weeklyBrakePercent); recorded fallback to Claude');
  assert.equal(R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'auto', codexAvailable: true, quotaBrake: brake(80) }).reviewer, 'codex');
});

test('quota brake: explicit codex writer and reviewer pass through', () => {
  assert.equal(R.resolveRoute({ risk: 'low', impl: 'codex', reviewer: 'auto', codexAvailable: true, quotaBrake: brake(90) }).impl, 'codex');
  const r = R.resolveRoute({ risk: 'low', impl: 'claude', reviewer: 'codex', codexAvailable: true, quotaBrake: brake(90) });
  assert.equal(r.reviewer, 'codex');
  assert.match(r.reviewReason, /explicit reviewer override/);
});

test('quota brake: codex unavailable keeps the existing unavailable reason', () => {
  const r = R.resolveRoute({ risk: 'low', impl: 'auto', reviewer: 'auto', codexAvailable: false, quotaBrake: brake(90) });
  assert.equal(r.implReason, 'automatic Codex writer unavailable; recorded fallback to Claude');
  assert.equal(r.reviewReason, 'automatic Codex review unavailable; recorded fallback to Claude');
  assert.doesNotMatch(r.reason, /weekly quota/);
});

test('quota brake: resolveTask reuses a persisted codex route while tripped', () => {
  const stored = autoLedger('low').replace('- route: pending', '- route: codex/gpt-6-luna@max -> claude/sonnet');
  const r = R.resolveTask(stored, 'T1', { codexAvailable: true, quotaBrake: brake(90) });
  assert.equal(r.reused, true);
  assert.equal(r.impl, 'codex');
  const fresh = R.resolveTask(autoLedger('low'), 'T1', { codexAvailable: true, quotaBrake: brake(90) });
  assert.equal(fresh.impl, 'claude');
  const rerouted = R.resolveTask(stored, 'T1', { codexAvailable: true, quotaBrake: brake(90), reroute: true });
  assert.equal(rerouted.impl, 'claude');
});

test('quota brake: a per-task impl: codex pin needs no impl-reason while tripped', () => {
  const r = R.resolveTask(pinned('- impl: codex', 'low'), 'T1', { codexAvailable: true, quotaBrake: brake(90) });
  assert.equal(r.impl, 'codex');
  // an impl: claude pin keeps its existing rule: high risk auto = codex, so a reason is required
  assert.throws(() => R.resolveTask(pinned('- impl: claude'), 'T1', { codexAvailable: true, quotaBrake: brake(90) }), /impl-reason/);
});

test('readQuotaBrake: 90 and 85 trip, 80 does not', () => {
  const t = R.readQuotaBrake({ home: quotaHome(90), nowMs: NOW });
  assert.equal(t.tripped, true);
  assert.equal(t.percent, 90);
  assert.equal(t.threshold, 85);
  assert.equal(t.resetsAt, NOW / 1000 + 3600);
  assert.equal(t.reason, 'codex weekly quota 90% >= 85% brake (rstaff.json codexQuota.weeklyBrakePercent)');
  assert.equal(R.readQuotaBrake({ home: quotaHome(85), nowMs: NOW }).tripped, true);
  assert.equal(R.readQuotaBrake({ home: quotaHome(80), nowMs: NOW }).tripped, false);
});

test('readQuotaBrake: newest codex row wins; gemini and quota-less rows are ignored', () => {
  const home = quotaHome(0, { rows: (row) => [
    row(NOW - 5000, 'codex', 50),
    row(NOW - 3000, 'codex', 90),
    row(NOW - 2000, 'codex', null),
    row(NOW - 1000, 'gemini', 10),
  ] });
  const b = R.readQuotaBrake({ home, nowMs: NOW });
  assert.equal(b.percent, 90);
  assert.equal(b.tripped, true);
});

test('readQuotaBrake: stale reading, bad key, and missing log all mean brake off', () => {
  const stale = quotaHome(0, { rows: (row) => [row(NOW - 1000, 'codex', 95, NOW / 1000 - 10)] });
  assert.equal(R.readQuotaBrake({ home: stale, nowMs: NOW }), null);
  for (const json of [{}, { codexQuota: {} }, { codexQuota: { weeklyBrakePercent: 0 } },
    { codexQuota: { weeklyBrakePercent: 150 } }, { codexQuota: { weeklyBrakePercent: 'x' } }]) {
    assert.equal(R.readQuotaBrake({ home: quotaHome(95, { json }), nowMs: NOW }), null, JSON.stringify(json));
  }
  const noLog = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-brake-'));
  fs.writeFileSync(path.join(noLog, 'rstaff.json'), JSON.stringify({ codexQuota: { weeklyBrakePercent: 85 } }));
  assert.equal(R.readQuotaBrake({ home: noLog, nowMs: NOW }), null);
  assert.equal(R.readQuotaBrake({ home: '/nonexistent/xyz', nowMs: NOW }), null);
});
