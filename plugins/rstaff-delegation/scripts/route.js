#!/usr/bin/env node
// Deterministically resolve and persist one ledger task's writer/reviewer route.
'use strict';
const fs = require('fs');
const path = require('path');
const { isAvailable, CODEX_EFFORTS, codexHome, sharedCodexHome, ADAPTERS } = require('./delegate.js');

const RISKS = new Set(['low', 'medium', 'high']);
const CLASSES = new Set(['logic', 'security', 'docs', 'config']);
const reviewRequiredFor = (cls) => cls === 'logic' || cls === 'security';
// gemini is a WRITER backend for prose only: delegate.js wires it as a read-only
// `draft`, so a Claude implementer applies what it drafts. resolveRoute refuses it
// off `class: docs`; it is never a reviewer.
const BACKENDS = new Set(['claude', 'codex', 'gemini']);
const REQUESTED_IMPLS = new Set(['auto', 'claude', 'codex', 'gemini']);
const REQUESTED_REVIEWERS = new Set(['auto', 'claude', 'codex']);
// `default` is the model a per-task `- impl: codex` PIN carries: "whatever codex's own
// config.toml names". A route can also carry Claude-side aliases (`sonnet`, `opus`,
// and the pre-2026-09-30 `inherited` sentinel old ledgers still replay); those
// simply aren't in codex's catalog, so pairSupport answers `unknown` for them
// without needing a special case.
const CODEX_CONFIG_DEFAULT = 'default';
// One Codex tier per risk band, shared by the writer and reviewer tables so a
// task is judged at the same reasoning tier it was written at. The band moves the
// model AND the reasoning effort: the lowest band rides the cheapest `luna`
// thinking as hard as it will (`gpt-6-luna@max`), medium runs `gpt-6.1-sol@medium`,
// and high buys more reasoning on the same model (`gpt-6.1-sol@xhigh`) rather
// than paying for `gpt-6-astra`. Moved sol -> 6.1-sol on 2026-09-30 (released
// 2026-09-29; same API price as gpt-6-sol, cheaper cache, ~Astra on DeepSWE at
// ~1/5 the cost per task). Each pair was smoke-tested (`codex exec`, exit 0) on
// codex-cli 0.159.0 under rstaff's CODEX_HOME — 0.155.0 and 0.157.0 both refused
// gpt-6.1-sol with HTTP 400 "not supported when using Codex with a ChatGPT
// account" (metadata missing, fallback), so 0.159.0 is the minimum for this table.
// astra stays out on the 2026-09-16 quota measurement (`rate_limits` snapshots
// put astra at ~25x luna and ~3x sol weekly-quota per token), which /rstaff-usage:spend cannot
// see because it counts tokens, not quota. Previous table: gpt-6-sol@medium /
// gpt-6-sol@xhigh (2026-09-23), luna/sol at gpt-5.6 before that.
const CODEX_TIER = {
  low: { model: 'gpt-6-luna', effort: 'max' },
  medium: { model: 'gpt-6.1-sol', effort: 'medium' },
  high: { model: 'gpt-6.1-sol', effort: 'xhigh' },
};

// The Claude side of the same ledger (2026-09-30). One alias per risk band, used
// for a pinned Claude writer AND for the fresh Claude reviewer, so a high-risk
// diff — auth, migrations, money — is read by the strongest independent Claude
// model while bounded work stays on sonnet. Aliases, not versions: these are what
// the Task tool's `model` accepts, and it overrides the agent frontmatter, so
// feature-runner passes the resolved value on every spawn. No effort axis: Claude
// has no reasoning-effort flag here. Replaces the 'sonnet' writer sentinel and the
// 'inherited' reviewer sentinel; routes persisted with 'inherited' replay as-is.
const CLAUDE_TIER = {
  low: { model: 'sonnet' },
  medium: { model: 'sonnet' },
  high: { model: 'opus' },
};

// `class: docs` under `impl: auto` drafts on Gemini. delegate.js's gemini adapter
// is `draft` only (read-only, --policy denies every write tool), so the route
// names Gemini as the writer and feature-runner has the band's Claude implementer
// apply the draft; the docs class already skips the per-task review gate and
// verify still runs. Kept in step with delegate.js GEMINI_DEFAULT_MODEL.
const GEMINI_DOCS_MODEL = 'gemini-3.8-flash';

// Read the band's tier HERE rather than validating the table at module load. A
// top-level throw would make route.js unloadable, and guard-bash.js loads it
// inside a try/catch that deliberately fails OPEN — so a one-token typo in the
// table would have silently disabled the unrouted-dispatch deny for every task,
// a far worse failure than the mistyped effort it was catching. Failing where the
// tier is consumed keeps `requireRoute` (which never reads the table) loadable.
function tierFor(risk) {
  const tier = CODEX_TIER[risk];
  if (!CODEX_EFFORTS.has(tier.effort)) {
    throw new Error(`route: CODEX_TIER.${risk} has unknown reasoning effort "${tier.effort}" (known: ${[...CODEX_EFFORTS].join(', ')})`);
  }
  return tier;
}

// Does the installed codex accept this (model, effort) PAIR? CODEX_EFFORTS only
// says a level exists; the CLI ships a per-model catalog saying which levels that
// model actually offers, and the two disagree (no model offers all seven).
//
// `unknown` whenever the catalog cannot ANSWER — absent, stale, or carrying a
// schema this no longer understands. A cache rstaff can't read is never evidence
// that a route is broken, so it must never produce a failure.
//
// Kept pure and split from the file read so the policy is testable with no codex
// installed; /health and the CLI entrypoint supply the parsed catalog.
function pairSupport(catalog, model, effort) {
  const models = catalog && Array.isArray(catalog.models) ? catalog.models : null;
  if (!models || !model || !effort) return { status: 'unknown', levels: [] };
  const found = models.find((m) => m && m.slug === model);
  const levels = found && Array.isArray(found.supported_reasoning_levels)
    ? found.supported_reasoning_levels.map((l) => l && l.effort).filter(Boolean)
    : [];
  // Model absent, or present with nothing parsable: both are "can't answer".
  if (!levels.length) return { status: 'unknown', levels };
  return { status: levels.includes(effort) ? 'ok' : 'unsupported', levels };
}

// The codex CLI's own version, from `codex --version` ("codex-cli 0.146.0").
// A numeric triple only: an `-rc1` / `+build` tail is dropped here, because this
// function no longer decides the verdict — it answers "is this a version at all"
// and, for a mismatch, which way it points. codexVersionToken owns the identity.
function parseCodexVersion(text) {
  const m = String(text == null ? '' : text).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

// The WHOLE version string codex matches on, release tail included. Measured
// 2026-09-10: a cache stamped `0.153.2-rc1` against CLI `0.153.2` still logs
// `cache version mismatch`, so the tail is part of the identity and comparing
// triples alone would wave through a cache codex refuses.
function codexVersionToken(text) {
  const m = String(text == null ? '' : text).match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

// Will codex actually USE the cache rstaff is reading?
//
// rstaff derives `pairSupport` / `checkTierSupport` from models_cache.json, so
// those verdicts are only worth anything while codex is reading the same file.
// `loadCodexCatalog` is a bare `JSON.parse`; codex gates the file on its version
// first, and the two oracles part company there.
//
// The rule is EQUALITY, measured 2026-09-10 with RUST_LOG against codex-cli
// 0.153.2. codex's loader logs, for the live cache:
//   models cache: loaded cache file        cached_version=Some("0.153.4")
//   models cache: cache version mismatch   expected_version="0.153.2"
//   models cache: no usable cache entry
// and then discards the WHOLE file and falls back to built-in metadata. Rewriting
// only `client_version` to 0.153.2 flips the same file to `cache entry applied`.
//
// Two things that check ISN'T, both measured rather than reasoned:
//   - It is not an ORDERING. An older cache takes the identical mismatch branch.
//     The previous version of this function asked "is the cache newer?" and so
//     answered `ok` for every stale cache codex was busy throwing away.
//   - It is not a SCHEMA check. `base_instructions` — the field named in the
//     loader error — is absent from all 7 models in the catalog the
//     API returns today, and codex loads that cache happily once the version
//     matches. That error came from a different codex's schema, so reading the
//     models' fields here would pin a belief the installed CLI contradicts.
//
// `client_version` is written BY the client that wrote the file, not advertised
// by the API: forcing an authenticated refetch under CLI 0.153.2 rewrote a
// 0.153.4 stamp to 0.153.2. So a mismatch is real, and it self-heals on the next
// successful online run — it persists only while codex hasn't run since the CLI
// changed, or while its refetch keeps failing.
//
// REPORT-ONLY by design. Under that version skew `gpt-5.6-sol` still ran fine,
// so refusing codex routes on a mismatched cache would take the working paths
// down with the broken one — the "your cache is old" -> "all routing is down"
// failure this file is built to avoid. /health reports it; the human decides.
//
// `direction` is for the MESSAGE only, never the verdict: 'newer' | 'older', or
// null when the triples tie and only the release tail differs.
function catalogParity(catalog, cliVersionText) {
  const cacheText = catalog && typeof catalog.client_version === 'string' ? catalog.client_version.trim() : null;
  const cliText = typeof cliVersionText === 'string' ? cliVersionText.trim() : null;
  const cacheToken = codexVersionToken(cacheText);
  const cliToken = codexVersionToken(cliText);
  // A cache rstaff can't read is never evidence that a route is broken.
  if (!cacheToken || !cliToken) return { status: 'unknown', cache: cacheText, cli: cliText, direction: null };
  if (cacheToken === cliToken) return { status: 'ok', cache: cacheText, cli: cliText, direction: null };
  const cache = parseCodexVersion(cacheToken);
  const cli = parseCodexVersion(cliToken);
  const diff = [cache.major - cli.major, cache.minor - cli.minor, cache.patch - cli.patch].find((d) => d !== 0);
  return { status: 'mismatch', cache: cacheText, cli: cliText, direction: diff ? (diff > 0 ? 'newer' : 'older') : null };
}

function checkTierSupport(catalog) {
  if (!catalog || !Array.isArray(catalog.models)) return { verified: false, unsupported: [], unknown: [] };
  const unsupported = [];
  const unknown = [];
  for (const [band, tier] of Object.entries(CODEX_TIER)) {
    const { status, levels } = pairSupport(catalog, tier.model, tier.effort);
    if (status === 'unknown') unknown.push(`${band}: ${tier.model}`);
    else if (status === 'unsupported') {
      unsupported.push(`${band}: ${tier.model} has no "${tier.effort}" (offers ${levels.join('/')})`);
    }
  }
  return { verified: true, unsupported, unknown };
}

// The TOP-LEVEL `model =` in codex's config.toml — what a per-task `- impl: codex`
// pin actually runs. Scoped to the text before the first `[section]` header on
// purpose: a `model =` under `[profiles.foo]` belongs to that profile, and reading
// it as the global default would name the wrong model in an error.
function codexDefaultModel(toml) {
  const head = String(toml == null ? '' : toml).split(/^\s*\[/m)[0];
  const m = head.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
  return m ? m[1] : null;
}

// The catalog + default the codex CLI keeps for itself. Best-effort: unreadable
// is `null`, which every consumer treats as "cannot answer" rather than a fault.
// `codexHome` is delegate.js's, on purpose: these loaders answer questions about the
// catalog THE SPAWNED CLI loads, and a second copy of the path here is how a /health
// passes while the binary it certifies is reading a different file.
function loadCodexCatalog() {
  try { return JSON.parse(fs.readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8')); } catch (_) { return null; }
}
// Defaults to the home rstaff spawns into. /health passes the OPERATOR home instead
// when that one has not been seeded yet, because the seeding delegate.run() does
// before the spawn is what makes the operator's config the one codex reads.
function loadCodexDefaultModel(home = codexHome()) {
  try { return codexDefaultModel(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')); } catch (_) { return null; }
}

function value(text, key, fallback = null) {
  const match = String(text || '').match(new RegExp(`^\\s*-?\\s*${key}:\\s*(.+?)\\s*$`, 'mi'));
  return match ? match[1].trim() : fallback;
}

// A trailing `# …` on an enum field is a human note, not part of the value.
// Ledgers in the wild already record override rationale there, and the parser
// used to choke on it — `impl: claude   # capability, not risk` failed
// REQUESTED_IMPLS and threw, so the task silently never got routed at all.
// Split the note off and keep it: it is exactly the reason resolveTask needs.
// Only applied to enum-ish fields; a free-text `route-reason` may contain `#`.
function splitComment(raw) {
  const s = String(raw == null ? '' : raw);
  const i = s.indexOf('#');
  if (i < 0) return { value: s.trim(), comment: null };
  return { value: s.slice(0, i).trim(), comment: s.slice(i + 1).trim() || null };
}

function taskSection(ledger, taskId) {
  const escaped = String(taskId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = String(ledger);
  const match = source.match(new RegExp(`^## ${escaped}:.*$`, 'm'));
  if (!match) throw new Error(`route: task "${taskId}" not found in ledger`);
  const start = match.index;
  const tail = source.slice(start + match[0].length);
  const next = tail.search(/^## \S+:/m);
  const end = next < 0 ? source.length : start + match[0].length + next;
  return { text: source.slice(start, end), start, end };
}

function headerText(ledger) {
  const i = String(ledger).search(/^## \S+:/m);
  return i < 0 ? String(ledger) : String(ledger).slice(0, i);
}

function parseTask(ledger, taskId) {
  const header = headerText(ledger);
  const section = taskSection(ledger, taskId);
  const taskImpl = splitComment(value(section.text, 'impl', '-'));
  const taskReviewer = splitComment(value(section.text, 'reviewer', '-'));
  const taskClass = splitComment(value(section.text, 'class', 'logic'));
  if (!CLASSES.has(taskClass.value)) {
    throw new Error(`route: class must be logic, security, docs, or config (got "${taskClass.value}")`);
  }
  // A PER-TASK `impl:` is a pin: one task opting out of the feature's policy.
  // A header `impl:` is the feature's policy, declared once and visible at the
  // top; and an absent header is a default, not a decision. Only the pin is
  // held to the explain-yourself rule in resolveTask.
  const pinned = taskImpl.value !== '' && taskImpl.value !== '-';
  return {
    risk: splitComment(value(section.text, 'risk', null)).value || null,
    class: taskClass.value,
    impl: pinned ? taskImpl.value : splitComment(value(header, 'impl', 'claude')).value,
    implPinned: pinned,
    implReason: value(section.text, 'impl-reason', null) || (pinned ? taskImpl.comment : null),
    reviewer: (taskReviewer.value !== '' && taskReviewer.value !== '-')
      ? taskReviewer.value
      : splitComment(value(header, 'reviewer', 'auto')).value,
    route: value(section.text, 'route', 'pending'),
    section,
  };
}

// Codex weekly-quota brake. The only I/O: rstaff.json's
// `codexQuota.weeklyBrakePercent` plus the newest codex row in var/usage.jsonl that
// carries a weekly (`secondary`) reading. Returns null (brake off) on anything
// missing, invalid, stale, or thrown — telemetry must never fail routing.
function readQuotaBrake({ home, nowMs = Date.now() } = {}) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'rstaff.json'), 'utf8'));
    const threshold = cfg && cfg.codexQuota && cfg.codexQuota.weeklyBrakePercent;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 100) return null;
    const usageRoot = require('./locate.js').locate('rstaff-usage');
    if (!usageRoot) return null;
    const { readRecords } = require(path.join(usageRoot, 'scripts', 'usage.js'));
    let latest = null;
    let latestTs = -Infinity;
    for (const r of readRecords(path.join(home, 'var', 'usage.jsonl'), nowMs, 8)) {
      if (!r || r.adapter !== 'codex') continue;
      const sec = r.quota && r.quota.secondary;
      if (!sec || !Number.isFinite(sec.end)) continue;
      const ts = Date.parse(r.timestamp);
      if (ts > latestTs) { latestTs = ts; latest = sec; }
    }
    if (!latest) return null;
    const resetsAt = Number.isFinite(latest.resetsAt) ? latest.resetsAt : null;
    if (resetsAt !== null && resetsAt * 1000 <= nowMs) return null;
    const percent = latest.end;
    return {
      tripped: percent >= threshold, percent, threshold, resetsAt,
      reason: `codex weekly quota ${percent}% >= ${threshold}% brake (rstaff.json codexQuota.weeklyBrakePercent)`,
    };
  } catch (_) {
    return null;
  }
}

function resolveRoute(opts) {
  const risk = opts.risk;
  const requestedImpl = opts.impl || 'claude';
  const requestedReviewer = opts.reviewer || 'auto';
  if (!RISKS.has(risk)) throw new Error(`route: risk must be low, medium, or high (got "${risk || ''}")`);
  if (!REQUESTED_IMPLS.has(requestedImpl)) {
    throw new Error(`route: impl must be auto, claude, codex, or gemini (got "${requestedImpl}")`);
  }
  const cls = opts.class || 'logic';
  if (requestedImpl === 'gemini' && cls !== 'docs') {
    throw new Error(`route: gemini drafts prose only — \`impl: gemini\` needs \`class: docs\` (got class "${cls}")`);
  }
  if (!REQUESTED_REVIEWERS.has(requestedReviewer)) {
    throw new Error(`route: reviewer must be auto, claude, or codex (got "${requestedReviewer}")`);
  }
  // Overrides skip the tier table, so they need the same guard it got above.
  for (const [flag, effort] of [['--impl-effort', opts.implEffort], ['--review-effort', opts.reviewEffort]]) {
    if (effort && !CODEX_EFFORTS.has(effort)) {
      throw new Error(`route: ${flag} "${effort}" is not a codex reasoning effort (known: ${[...CODEX_EFFORTS].join(', ')})`);
    }
  }

  const codexAvailable = opts.codexAvailable === undefined ? isAvailable('codex') : !!opts.codexAvailable;
  // Pure input (null/undefined = brake off). Only the `auto` codex picks below consult it.
  const brakeTripped = !!(opts.quotaBrake && opts.quotaBrake.tripped);

  // Writer axis. `auto` sends implementation to Codex at every risk band — the
  // writer runs the most turns and produces the most edit/build residue, so it is
  // the largest token lever, and the independence interlock below keeps a fresh
  // Claude reviewer as the gate on whatever Codex writes. High risk buys a higher
  // reasoning tier (CODEX_TIER), not a different provider.
  // An EXPLICIT backend is passed through untouched: /dispatch
  // preflight owns explicit-backend availability and offers the human a
  // fallback that throwing here would preempt.
  let impl = requestedImpl;
  let implReason = null;
  if (impl === 'auto' && cls === 'docs') {
    // Probed lazily: only a docs task ever asks, so a logic task never spawns
    // `command -v gemini`.
    const geminiAvailable = opts.geminiAvailable === undefined ? isAvailable('gemini') : !!opts.geminiAvailable;
    if (geminiAvailable) {
      impl = 'gemini';
      implReason = 'docs task drafted by Gemini; the band\'s Claude implementer applies the draft';
    } else {
      implReason = 'automatic Gemini drafter unavailable; recorded fallback to the ordinary writer policy';
    }
  }
  if (impl === 'auto') {
    if (!codexAvailable) {
      impl = 'claude';
      implReason = [implReason, 'automatic Codex writer unavailable; recorded fallback to Claude'].filter(Boolean).join('; ');
    } else if (brakeTripped) {
      impl = 'claude';
      implReason = [implReason, `${opts.quotaBrake.reason}; recorded fallback to Claude`].filter(Boolean).join('; ');
    } else if (risk === 'high') {
      impl = 'codex';
      implReason = [implReason, 'high-risk task delegated to the Codex writer at the high tier; the fresh Claude reviewer is the gate'].filter(Boolean).join('; ');
    } else {
      impl = 'codex';
      implReason = [implReason, `${risk}-risk bounded task delegated to the Codex writer`].filter(Boolean).join('; ');
    }
  }
  if (!BACKENDS.has(impl)) throw new Error(`route: unknown implementation backend "${impl}"`);

  // Reviewer axis, resolved against the RESOLVED writer so the independence
  // interlock below sees who actually writes.
  let reviewer = requestedReviewer;
  let reviewReason;
  if (reviewer === 'auto') {
    if (impl !== 'claude') {
      reviewer = 'claude';
      reviewReason = 'external writer requires an independent Claude reviewer';
    } else if (risk === 'high') {
      reviewer = 'claude';
      reviewReason = 'high-risk task stays on the fresh Claude quality gate';
    } else if (!codexAvailable) {
      reviewer = 'claude';
      reviewReason = 'automatic Codex review unavailable; recorded fallback to Claude';
    } else if (brakeTripped) {
      reviewer = 'claude';
      reviewReason = `${opts.quotaBrake.reason}; recorded fallback to Claude`;
    } else {
      reviewer = 'codex';
      reviewReason = `${risk}-risk Claude-authored task uses cross-provider review`;
    }
  } else if (reviewer === 'codex' && !codexAvailable) {
    throw new Error('route: explicit Codex reviewer requested but `codex` is unavailable');
  } else {
    reviewReason = `explicit reviewer override: ${reviewer}`;
  }

  // A Codex writer gets the risk band's tier unless a PER-TASK `- impl: codex`
  // pin asked for codex's own config default. PROVENANCE decides that, not the
  // value: a header `impl:` is the feature's POLICY ("a named backend implements
  // every task this run", task-format.md) and a CLI `--impl` is a run-level choice
  // typed by a human, so both take the tier exactly like `auto`. Only a per-task
  // line is the one-task exception the `default` sentinel exists for.
  //
  // Keying this off `requestedImpl === 'auto'` collapsed all three provenances.
  // Measured 2026-09-09: /build's dispatcher writes its resolved
  // backend into the ledger HEADER before the loop starts, so that turned `auto`
  // into an explicit `codex` and moved every LATER task in the ledger onto
  // `default` — silently, because `implPinned` is false for a header value and the
  // explain-your-pin guard below never fires. A writer was dispatched onto
  // config.toml's `gpt-6-astra`, which the installed codex-cli refuses with HTTP
  // 400, and the attempt was consumed having written nothing.
  //
  // `--impl-model` / `--impl-effort` override either way.
  const pinnedToCodexDefault = requestedImpl === 'codex' && !!opts.implPinned;
  let writerModel = opts.implModel
    || (impl === 'claude' ? CLAUDE_TIER[risk].model : impl === 'gemini' ? GEMINI_DOCS_MODEL : CODEX_CONFIG_DEFAULT);
  let writerEffort = opts.implEffort || null;
  if (impl === 'codex' && !pinnedToCodexDefault) {
    writerModel = opts.implModel || tierFor(risk).model;
    writerEffort = opts.implEffort || tierFor(risk).effort;
  }

  let reviewerModel = CLAUDE_TIER[risk].model;
  let reviewerEffort = null;
  if (reviewer === 'codex') {
    reviewerModel = opts.reviewModel || tierFor(risk).model;
    reviewerEffort = opts.reviewEffort || tierFor(risk).effort;
  }

  // OVERRIDES ONLY, deliberately. `--impl-effort ultra` on a model that stops at
  // max would be persisted as the task's sticky route and die at spawn inside the
  // worker — and an override bypasses both the tier table and /health's check of
  // it, so this is the only place that ever sees the pair.
  //
  // The tier table is NOT checked here even though this code could: the catalog is
  // a CACHE, and a merely out-of-date one lists a real model with a real level list
  // that simply predates a newer level. Blocking on that turns "your cache is old"
  // into "all routing is down", with no escape but deleting the file — and the
  // table changes only when someone edits this file, where /health's FAIL and the
  // test suite already cover it. An override is typed by a human in the moment, so
  // failing it costs that one command.
  //
  // `unknown` never blocks either: a catalog rstaff can't read is not evidence.
  // Per AXIS, not per call: `--impl-model` alone still produces a pair the tier
  // walk never saw (override model + table effort), and an override on the writer
  // must not drag the untouched reviewer axis into a catalog check.
  if (opts.catalog) {
    for (const [axis, rawModel, effort, overridden] of [
      ['writer', writerModel, writerEffort, !!(opts.implModel || opts.implEffort)],
      ['reviewer', reviewerModel, reviewerEffort, !!(opts.reviewModel || opts.reviewEffort)],
    ]) {
      if (!overridden || !effort) continue;
      // A per-task `- impl: codex` pin resolves to the `default` sentinel and the
      // runner then omits `-m`, so the effort lands on whatever config.toml
      // names — the one remaining path by which a bad `--impl-effort` reached a
      // worker. Resolve it when we can; when we can't, `unknown` and proceed.
      const model = rawModel === CODEX_CONFIG_DEFAULT ? opts.codexDefaultModel : rawModel;
      if (!model) continue;
      const { status, levels } = pairSupport(opts.catalog, model, effort);
      if (status === 'unsupported') {
        const named = rawModel === CODEX_CONFIG_DEFAULT ? `${model} (codex's config.toml default)` : model;
        throw new Error(`route: ${axis} model ${named} does not offer reasoning effort "${effort}" (offers ${levels.join('/')}) — codex would reject it at spawn`);
      }
    }
  }

  // writer ≠ reviewer is a non-negotiable. `auto` can't violate it (an external
  // writer always forces Claude review), but two explicit overrides could ask
  // Codex to review its own diff, so refuse it here rather than in prose.
  // Claude/Claude is NOT a violation: the reviewer is a fresh, independent
  // context, which is rstaff's baseline gate.
  if (impl === reviewer && impl !== 'claude') {
    throw new Error(`route: ${impl} cannot review its own diff — writer and reviewer must differ (drop the explicit reviewer, or set reviewer: claude)`);
  }

  return {
    risk, impl, writerModel, writerEffort,
    reviewer, reviewerModel, reviewerEffort,
    implReason, reviewReason,
    reason: implReason ? `${implReason}; ${reviewReason}` : reviewReason,
    route: formatRoute({ impl, writerModel, writerEffort, reviewer, reviewerModel, reviewerEffort }),
  };
}

// How the dispatcher runs a resolved writer. `impl` alone is not enough: codex
// writes through `delegate.js codex execute`, but gemini is wired read-only and
// only has `draft` (a Claude implementer applies it). Measured 2026-10-09: a
// dispatcher shelled `delegate.js gemini execute` for a docs task and delegate.js
// refused it. Checked against delegate.js's own adapter table, so a mode that
// doesn't exist is refused here instead of at dispatch.
const WRITER_DELEGATE_MODE = { codex: 'execute', gemini: 'draft' };
function writerModeFor(impl, adapters = ADAPTERS) {
  if (impl === 'claude') return 'subagent';
  const mode = WRITER_DELEGATE_MODE[impl];
  if (!mode || !adapters[impl] || !adapters[impl].modes[mode]) {
    throw new Error(`route: delegate.js has no "${mode}" mode for ${impl} — no way to dispatch this writer`);
  }
  return mode;
}

// `<writer>/<model>[@<effort>] -> <reviewer>/<model>[@<effort>]`. The effort
// suffix is what makes a persisted route replayable: without it a resumed task
// would recover the model but silently fall back to the provider's default
// reasoning effort.
function formatRoute(r) {
  const side = (backend, model, effort) => `${backend}/${model}${effort ? `@${effort}` : ''}`;
  return `${side(r.impl, r.writerModel, r.writerEffort)} -> ${side(r.reviewer, r.reviewerModel, r.reviewerEffort)}`;
}

const ROUTE_RE = /^(\w[\w-]*)\/([^@\s]+)(?:@(\S+))?\s*->\s*(\w[\w-]*)\/([^@\s]+)(?:@(\S+))?$/;

function parseRoute(route) {
  const m = ROUTE_RE.exec(String(route || '').trim());
  if (!m) return null;
  const [, impl, writerModel, writerEffort, reviewer, reviewerModel, reviewerEffort] = m;
  if (!BACKENDS.has(impl) || !new Set(['claude', 'codex']).has(reviewer)) return null;
  return {
    impl, writerModel, writerEffort: writerEffort || null,
    reviewer, reviewerModel, reviewerEffort: reviewerEffort || null,
  };
}

const OVERRIDE_KEYS = ['impl', 'reviewer', 'implModel', 'implEffort', 'reviewModel', 'reviewEffort'];

// Resolve one ledger task: REUSE a persisted route rather than re-deriving it.
// Re-resolving is not idempotent across time — a route persisted while Codex was
// unavailable would silently flip to Codex once the CLI came back, mid-feature.
// An explicit override or `--reroute` is the only way to change a stored route.
function resolveTask(ledger, taskId, opts = {}) {
  const task = parseTask(ledger, taskId);
  const overridden = OVERRIDE_KEYS.some((k) => opts[k]);
  const stored = parseRoute(task.route);
  if (stored && !overridden && !opts.reroute) {
    return {
      ...stored,
      risk: task.risk,
      reviewRequired: reviewRequiredFor(task.class),
      implReason: null,
      reviewReason: 'reused the route already persisted in the ledger',
      reason: 'reused the route already persisted in the ledger',
      route: formatRoute(stored),
      writerMode: writerModeFor(stored.impl),
      reused: true,
    };
  }
  // Probe once and pass it down: both resolveRoute calls below must agree about
  // Codex's availability, or the comparison would compare two different worlds.
  const codexAvailable = opts.codexAvailable === undefined ? isAvailable('codex') : !!opts.codexAvailable;
  // Same once-only rule for the quota brake; an injected value (even null) wins.
  const quotaBrake = opts.quotaBrake !== undefined ? opts.quotaBrake
    : readQuotaBrake({ home: require('../hooks/lib.js').resolveHome(process.cwd()), nowMs: Date.now() });
  const base = {
    ...task, ...opts, codexAvailable, quotaBrake,
    impl: opts.impl || task.impl,
    reviewer: opts.reviewer || task.reviewer,
    // Provenance, not value, decides whether a codex writer keeps codex's own
    // config default (see resolveRoute). A CLI `--impl` overrides the ledger, so
    // it also overrides the PIN semantics — the same exemption the
    // explain-yourself rule below already grants it.
    implPinned: task.implPinned && !opts.impl,
  };
  const resolved = resolveRoute(base);

  // A per-task pin that CONTRADICTS the automatic policy is an exception, and
  // exceptions have to say why. Measured 2026-08-02: four high-risk tasks were
  // pinned to Claude by a /build brief, silently opting out of the policy
  // route.js states one function up (high risk -> Codex writer, fresh Claude
  // reviewer as the gate). Nothing recorded the disagreement, so the code and
  // the operator's intent diverged invisibly for a whole feature.
  //
  // This does not decide who is right — it refuses to let the two disagree in
  // silence. The reason lands in `- route-reason:`, so a pin is reviewable and
  // a recurring one is evidence to change the default here instead.
  // A CLI `--impl` is exempt: it is typed by a human in the moment and visible
  // in the invocation, not buried in a ledger row.
  if (task.implPinned && !opts.impl) {
    // `catalog: null` — this probe asks ONLY "who would the policy pick?", and its
    // route is never dispatched. Validating its hypothetical codex pair would fail
    // a task that resolves to no codex at all: a `impl: claude` pin would die on
    // catalog drift naming a model it never touches.
    const auto = resolveRoute({ ...base, impl: 'auto', catalog: null, quotaBrake: null });
    if (auto.impl !== resolved.impl) {
      if (!task.implReason) {
        throw new Error(
          `route: task "${taskId}" pins \`impl: ${resolved.impl}\` but the automatic route for a `
          + `${task.risk}-risk task is \`${auto.impl}\` — record why with \`- impl-reason: <why>\` `
          + '(or a `# …` note on the impl line). An unexplained pin silently opts the task out of the '
          + 'cross-provider policy; if the same reason keeps recurring, change the policy in route.js instead.',
        );
      }
      const implReason = `pinned to ${resolved.impl} against the automatic route (${auto.impl}): ${task.implReason}`;
      return {
        ...resolved,
        reviewRequired: reviewRequiredFor(task.class),
        implReason,
        reason: `${implReason}; ${resolved.reviewReason}`,
        writerMode: writerModeFor(resolved.impl),
        reused: false,
      };
    }
  }
  return {
    ...resolved,
    reviewRequired: reviewRequiredFor(task.class),
    writerMode: writerModeFor(resolved.impl),
    reused: false,
  };
}

// The persisted route IS the writer's authorization. A task dispatched while its
// `route:` is still `pending` never passed through resolveTask, so nothing chose
// its backend, model, or reasoning tier: the risk band is decoration, the
// cross-provider policy silently doesn't apply, and a resumed run can't replay
// what it did. Measured 2026-08-02: 3 of 10 tasks in one feature dispatched
// unrouted and every one of them defaulted to Claude. Refuse instead of guessing.
function requireRoute(ledger, taskId) {
  const task = parseTask(ledger, taskId);
  const stored = parseRoute(task.route);
  if (!stored) {
    throw new Error(
      `route: task "${taskId}" has no persisted route (found "${task.route || 'nothing'}") — `
      + 'resolve it first: route.js resolve --ledger <file> --task <id> --write'
    );
  }
  return {
    ...stored,
    risk: task.risk,
    reviewRequired: reviewRequiredFor(task.class),
    route: formatRoute(stored),
    writerMode: writerModeFor(stored.impl),
  };
}

function persistRoute(ledger, taskId, resolved) {
  const section = taskSection(ledger, taskId);
  let updated = section.text;
  // Anchor or fail loudly. A silent no-op here would lose exactly the routes
  // that are NOT re-derivable: an unavailable-Codex fallback re-resolves to
  // Codex once the CLI is back, silently swapping writer or reviewer mid-run.
  if (!/^- (route|reviewer|risk|status):\s*.*$/m.test(updated)) {
    throw new Error(`route: task "${taskId}" has no - status:/- risk:/- reviewer:/- route: line to anchor the resolved route`);
  }
  const routeLine = `- route: ${resolved.route}`;
  const reasonLine = `- route-reason: ${resolved.reason}`;
  // Replace in place when the field exists, else insert after the first
  // available anchor. Function replacements so a `$` in a model id or reason
  // can't be read as a capture reference.
  const upsert = (text, field, line, anchors) => {
    const existing = new RegExp(`^- ${field}:\\s*.*$`, 'm');
    if (existing.test(text)) return text.replace(existing, () => line);
    for (const anchor of anchors) {
      const re = new RegExp(`^- ${anchor}:\\s*.*$`, 'm');
      if (re.test(text)) return text.replace(re, (m) => `${m}\n${line}`);
    }
    return text;
  };
  updated = upsert(updated, 'route', routeLine, ['reviewer', 'impl', 'risk', 'status']);
  updated = upsert(updated, 'route-reason', reasonLine, ['route']);
  return ledger.slice(0, section.start) + updated + ledger.slice(section.end);
}

function parseArgs(argv) {
  const opts = { command: argv[0] };
  const flags = {
    '--ledger': 'ledger', '--task': 'taskId', '--impl': 'impl',
    '--impl-model': 'implModel', '--impl-effort': 'implEffort',
    '--reviewer': 'reviewer',
    '--review-model': 'reviewModel', '--review-effort': 'reviewEffort',
  };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--write') { opts.write = true; continue; }
    if (argv[i] === '--reroute') { opts.reroute = true; continue; }
    const key = flags[argv[i]];
    if (key) opts[key] = argv[++i];
  }
  return opts;
}

if (require.main === module) {
  try {
    // The CLI is where a human types an override, so it is where the resolved
    // (model, effort) pair gets checked against the catalog. The library entry
    // stays pure — callers opt in by passing `catalog`.
    const opts = {
      ...parseArgs(process.argv.slice(2)),
      catalog: loadCodexCatalog(),
      codexDefaultModel: loadCodexDefaultModel(),
    };
    if (!['resolve', 'require'].includes(opts.command) || !opts.ledger || !opts.taskId) {
      throw new Error('usage: route.js <resolve|require> --ledger <file> --task <id> [overrides] [--reroute] [--write]');
    }
    const ledger = fs.readFileSync(opts.ledger, 'utf8');
    // `require` is the pre-dispatch gate: exit 1 unless a route is ALREADY
    // persisted. It never resolves and never writes — a gate that fixes the thing
    // it is checking for is not a gate.
    if (opts.command === 'require') {
      process.stdout.write(JSON.stringify(requireRoute(ledger, opts.taskId), null, 2) + '\n');
    } else {
      const resolved = resolveTask(ledger, opts.taskId, opts);
      // A reused route is already in the ledger — rewriting it would clobber the
      // original `route-reason` (e.g. why it fell back) with a generic one.
      if (opts.write && !resolved.reused) {
        fs.writeFileSync(opts.ledger, persistRoute(ledger, opts.taskId, resolved));
      }
      process.stdout.write(JSON.stringify(resolved, null, 2) + '\n');
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  value, splitComment, taskSection, parseTask, resolveRoute, resolveTask, requireRoute, readQuotaBrake,
  formatRoute, parseRoute, persistRoute, parseArgs, writerModeFor,
  CLASSES,
  CODEX_TIER, CLAUDE_TIER, GEMINI_DOCS_MODEL, tierFor, pairSupport, checkTierSupport, parseCodexVersion, codexVersionToken, catalogParity,
  codexDefaultModel, codexHome, sharedCodexHome, loadCodexCatalog, loadCodexDefaultModel,
};
