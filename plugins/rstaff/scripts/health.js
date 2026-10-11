#!/usr/bin/env node
// rstaff /health — is the cockpit actually wired up and healthy?
// v1's failure mode was "designed but never activated": hooks silent, plugin
// uninstalled, nobody noticed. This script makes wiring state loud + checkable.
//
//   node plugins/rstaff/scripts/health.js            # full machine diagnosis
//   node plugins/rstaff/scripts/health.js --static   # repo-only checks (CI-safe)
//   node plugins/rstaff/scripts/health.js --json     # machine-readable output
//
// Exit 1 if any FAIL. WARN/INFO never fail the run.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const lib = require(path.join(__dirname, '..', 'hooks', 'lib.js'));
const backlogRoot = require('./locate.js').locate('rstaff-backlog');
const state = backlogRoot ? require(path.join(backlogRoot, 'scripts', 'lib-state.js')) : null;
const delegationRoot = require('./locate.js').locate('rstaff-delegation');
const GEMINI_DEFAULT_MODEL = delegationRoot
  ? require(path.join(delegationRoot, 'scripts', 'delegate.js')).GEMINI_DEFAULT_MODEL : null;

const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } };
const GEMINI_INSTALL_FIX = 'npm i -g @google/gemini-cli';
const GEMINI_ADC_FIX = 'gcloud auth application-default login';
const GEMINI_PROJECT_FIX = 'set RSTAFF_GEMINI_PROJECT (or export GOOGLE_CLOUD_PROJECT)';

function checkGeminiProject(env = process.env) {
  const configured = [env.RSTAFF_GEMINI_PROJECT, env.GOOGLE_CLOUD_PROJECT]
    .some((project) => typeof project === 'string' && project.trim().length > 0);
  return configured
    ? { status: 'PASS', note: 'Vertex project configured' }
    : { status: 'WARN', note: `unavailable — FIX: ${GEMINI_PROJECT_FIX}` };
}

function checkGeminiCli(spawn = spawnSync) {
  const found = spawn('sh', ['-c', 'command -v gemini'], { encoding: 'utf8', timeout: 10000 });
  if (found.status !== 0) {
    return { status: 'WARN', note: `unavailable — FIX: ${GEMINI_INSTALL_FIX}` };
  }
  const version = spawn('gemini', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.status !== 0) {
    return { status: 'WARN', note: `found at ${(found.stdout || '').trim()}, but --version failed — FIX: ${GEMINI_INSTALL_FIX}` };
  }
  return { status: 'PASS', note: `${(version.stdout || version.stderr || '').trim()} · model ${GEMINI_DEFAULT_MODEL}` };
}

function checkGeminiAdc(spawn = spawnSync, env = process.env) {
  const options = { encoding: 'utf8', timeout: 10000, env };
  let bin = path.join(os.homedir(), 'google-cloud-sdk', 'bin', 'gcloud');
  let result = spawn(bin, ['auth', 'application-default', 'print-access-token'], options);
  if (result.status !== 0) {
    bin = 'gcloud';
    result = spawn(bin, ['auth', 'application-default', 'print-access-token'], options);
  }
  if (result.status !== 0) {
    return { status: 'WARN', note: `unavailable via ${bin} — FIX: ${GEMINI_ADC_FIX}` };
  }
  return { status: 'PASS', note: `application-default credentials valid via ${bin}` };
}

// The CLI reports dependency/load failures in errors; older/future shapes may
// also expose a loaded flag or a status. Disabled alone is not a load failure.
function pluginList(text) {
  const value = JSON.parse(text);
  const list = Array.isArray(value) ? value : value && value.plugins;
  if (!Array.isArray(list) || list.some(p => !p || typeof p.id !== 'string')) {
    throw new Error('unknown plugin list shape');
  }
  return list;
}

function checkPluginLoads(spawn = spawnSync) {
  try {
    const result = spawn('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) return { status: 'INFO', note: 'claude unavailable — skipping plugin load checks' };
    const list = pluginList(result.stdout).filter(p => /^rstaff(?:-[a-z0-9-]+)?@rstaff$/.test(p.id));
    const failed = list.filter(p => p.loaded === false || p.status === 'failed to load'
      || p.status === 'not loaded' || (Array.isArray(p.errors) && p.errors.length > 0));
    if (failed.length) return { status: 'WARN', note: `${failed.map(p => p.id).join(', ')} failed to load — FIX: claude plugin marketplace add obra/superpowers-marketplace` };
    return { status: 'PASS', note: `${list.length} installed rstaff plugin(s); no load failures reported` };
  } catch (_) {
    return { status: 'INFO', note: 'plugin list unavailable or unrecognized — skipping plugin load checks' };
  }
}

function findStatelessDispatchFiles(home) {
  let rows;
  try { rows = state.collectDispatch(home, { refsFor: null }); } catch (_) { return []; }
  const parsed = new Set(rows.map((row) => path.join(row.repo, `${row.slug}.md`)));
  const root = path.join(home, 'var', 'dispatch');
  let repos;
  try { repos = fs.readdirSync(root); } catch (_) { return []; }

  const bad = [];
  for (const repo of repos) {
    const dir = path.join(root, repo);
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const full = path.join(dir, file);
      try { if (!fs.statSync(full).isFile()) continue; } catch (_) { continue; }
      if (!parsed.has(path.join(repo, file))) bad.push(full);
    }
  }
  return bad;
}

function checkNode(version = process.version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  const ok = major > 22 || (major === 22 && minor >= 5);
  return ok ? { status: 'PASS', note: version }
    : { status: 'FAIL', note: `found ${version} — upgrade node (nbgate's .rstaff-nbignore matcher needs 22.5)` };
}

function runHealth() {
const STATIC = process.argv.includes('--static');
const JSON_OUT = process.argv.includes('--json');
const PLUGIN = path.resolve(__dirname, '..');            // works installed or in-repo
const HOME = lib.resolveHome(process.cwd());              // control repo (rstaff.json)
const DAY = 24 * 60 * 60 * 1000;

const results = [];
function add(check, status, note) { results.push({ check, status, note: note || '' }); }
function sh(cmd, args) {
  try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 }); }
  catch (e) { return { status: 127, stdout: '', stderr: String(e) }; }
}

// 1. node version -----------------------------------------------------------
{ const node = checkNode(); add('node >= 22.5', node.status, node.note); }

// 2. manifests parse + hook scripts load -------------------------------------
{
  const usageRoot = require('./locate.js').locate('rstaff-usage');
  if (!usageRoot) add('usage', 'INFO', 'usage is not installed; skipping usage hook checks');
  const roots = [PLUGIN, ...(usageRoot ? [usageRoot] : [])];
  const manifests = roots.flatMap(root => [
    path.join(root, '.claude-plugin', 'plugin.json'),
    path.join(root, 'hooks', 'hooks.json'),
  ]);
  const repoMarketplace = path.resolve(PLUGIN, '..', '..', '.claude-plugin', 'marketplace.json');
  const marketplace = exists(repoMarketplace) ? repoMarketplace
    : path.join(HOME, '.claude-plugin', 'marketplace.json');
  if (exists(marketplace)) manifests.push(marketplace);
  const bad = [];
  for (const m of manifests) {
    try { JSON.parse(fs.readFileSync(m, 'utf8')); } catch (_) { bad.push(m); }
  }
  let hookCount = 0;
  for (const root of roots) {
    for (const h of fs.readdirSync(path.join(root, 'hooks')).filter(file => file.endsWith('.js'))) {
      hookCount++;
      const r = sh(process.execPath, ['--check', path.join(root, 'hooks', h)]);
      if (r.status !== 0) bad.push(`${root}/hooks/${h}`);
    }
  }
  add('manifests + hook syntax', bad.length ? 'FAIL' : 'PASS', bad.length ? `broken: ${bad.join(', ')}` : `${manifests.length} manifests, ${hookCount} hooks OK`);
}

// 3. command frontmatter completeness ----------------------------------------
{
  const dir = path.join(PLUGIN, 'commands');
  const bad = [];
  for (const f of (exists(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.md'))) {
    const head = lib.safeRead(path.join(dir, f), 2000);
    const fm = head.startsWith('---') ? head.slice(3, head.indexOf('---', 3)) : '';
    if (!/^description:/m.test(fm)) bad.push(`${f} (description)`);
    if (!/^allowed-tools:/m.test(fm)) bad.push(`${f} (allowed-tools)`);
  }
  add('command frontmatter', bad.length ? 'FAIL' : 'PASS', bad.length ? `missing: ${bad.join(', ')}` : 'all commands declare description + allowed-tools');
}

// 4. control-repo layout (rstaff.json marker + profiles/) --------------------
{
  const markerOk = exists(path.join(HOME, 'rstaff.json'));
  const profilesOk = exists(path.join(HOME, 'profiles'));
  add('control repo layout', markerOk ? (profilesOk ? 'PASS' : 'WARN') : (STATIC ? 'INFO' : 'FAIL'),
    !markerOk ? (STATIC ? 'control repo absent — skipping control repo layout checks' : `no rstaff.json at ${HOME} — is this the control repo? run install/install-apply.sh --install`)
      : (profilesOk ? 'rstaff.json + profiles/' : 'no profiles/ dir yet — add profiles/<repo>.md to manage a repo'));
}

// 5b. top-level dispatch files must be parseable runs ------------------------
if (state) {
  const bad = findStatelessDispatchFiles(HOME);
  const verb = bad.length === 1 ? 'has' : 'have';
  add('dispatch state coverage', bad.length ? (STATIC ? 'WARN' : 'FAIL') : 'PASS', bad.length
    ? `${bad.join(', ')} ${verb} no parseable state: — add a state: line, or move it to briefs/`
    : 'all top-level dispatch files have a parseable state:');
} else {
  add('backlog', 'INFO', 'backlog is not installed; skipping backlog checks');
}

if (!STATIC) {
  // Read ~/.claude/settings.json once — it's the structured fallback signal.
  // A parse FAILURE on an existing file is itself worth surfacing (a broken
  // settings.json means the plugin/env won't load), so track it explicitly.
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings = null; let settingsBroken = false;
  if (exists(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch (_) { settingsBroken = true; }
  }

  // 6. marketplace registered — match this control repo's path EXACTLY.
  //    Trust the CLI when it answers; only read files if the CLI itself failed.
  {
    const r = sh('claude', ['plugin', 'marketplace', 'list']);
    if (r.status === 0) {
      const seen = r.stdout.includes(`(${HOME})`); // "Source: Directory (<path>)"
      add('marketplace registered', seen ? 'PASS' : 'FAIL', seen ? 'claude CLI' : `this repo (${HOME}) not registered — run install/install-apply.sh --install`);
    } else {
      const mk = settings && settings.extraKnownMarketplaces;
      const seen = mk && Object.values(mk).some((m) => m && m.source && m.source.path === HOME);
      add('marketplace registered', seen ? 'PASS' : 'FAIL', seen ? 'settings.json (claude CLI unavailable)' : 'run install/install-apply.sh --install');
    }
  }

  // 7. plugin installed + enabled — exact id "rstaff@rstaff", enabled === true.
  {
    const r = sh('claude', ['plugin', 'list', '--json']);
    if (r.status === 0) {
      let on = false;
      try {
        const list = pluginList(r.stdout);
        on = list.some((p) => p.id === 'rstaff@rstaff' && p.enabled === true);
      } catch (_) {}
      add('plugin installed + enabled', on ? 'PASS' : 'FAIL', on ? 'claude CLI' : 'not installed/enabled — run install/install-apply.sh --install (or: claude plugin enable rstaff@rstaff)');
    } else {
      const on = settings && settings.enabledPlugins && settings.enabledPlugins['rstaff@rstaff'] === true;
      add('plugin installed + enabled', on ? 'PASS' : 'FAIL', on ? 'settings.json (claude CLI unavailable)' : 'run install/install-apply.sh --install');
    }
  }

  // 7b. installed copy is CURRENT ------------------------------------------------
  //     "installed + enabled" is not "up to date": the plugin cache is keyed by
  //     version, so a stale copy is never re-copied and every session keeps
  //     running the hooks from whenever it was last installed. Two failure modes
  //     — versions differ (fixable with `claude plugin update`), or versions
  //     agree while plugin/ has moved (needs a release bump; nothing else can
  //     pick it up). Only meaningful from the control repo, which owns plugin/.
  const installCheck = path.join(HOME, 'maintainer', 'lib-install.js');
  if (exists(installCheck)) {
    const v = require(installCheck).checkInstall(HOME);
    add('installed copy current', v.status, v.note);

    // 7d. replay the source corpus through the INSTALLED hooks. A FAIL means the
    //      running guards are stale even when the working-tree tests pass (E14/E17).
    const selfTest = path.join(HOME, 'maintainer', 'lib-guard-selftest.js');
    const corpus = path.join(HOME, 'maintainer', 'lib-guard-payloads.js');
    if (exists(selfTest) && exists(corpus)) {
      try {
        const installed = require(installCheck).readInstalled(os.homedir());
        const payloads = require(corpus);
        const { checkGuardPayloads } = require(selfTest);
        const spawn = (script, args, input) => spawnSync(process.execPath, [script, ...args],
          { input, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000 });
        const r = checkGuardPayloads({ pluginRoot: installed && installed.path, payloads, spawn });
        add('guard self-test (installed copy)', r.status, r.note);
      } catch (error) {
        const code = error && error.code ? error.code : 'unknown';
        add('guard self-test (installed copy)', 'INFO',
          `guard payload corpus unavailable at ${corpus} (HOME=${HOME}, code=${code}) — run install/install-apply.sh --install from a 0.8.13+ checkout`);
      }
    } else {
      add('guard self-test (installed copy)', 'INFO',
        `maintainer guard tooling unavailable (self-test=${selfTest}, corpus=${corpus}, HOME=${HOME}) — skipped; run install/install-apply.sh --install from a 0.8.13+ checkout`);
    }
  } else {
    add('maintainer install checks', 'INFO', 'maintainer install/guard tooling absent — skipped');
  }

  // 7c. plugin guard delivery ---------------------------------------------------
  {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
      const commands = Object.values(manifest.hooks)
        .flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));
      // Invocations != modules: several modules are wired to more than one event
      // (usage-capture on SessionEnd + SubagentStop, secret-scan on two, …), so
      // report both or the number reads as a module count and looks wrong.
      const modules = new Set(commands.map((c) => (c.match(/\/hooks\/([\w.-]+\.js)/) || [])[1]).filter(Boolean));
      add('guard delivery: plugin', 'PASS',
        `${modules.size} module(s) / ${commands.length} invocation(s) via hooks.json`
        + " — version-keyed, currency is 'installed copy current' above");
    } catch (_) {
      add('guard delivery: plugin', 'FAIL', 'hooks.json unreadable — no plugin-delivered guard is running');
    }

  }

  // 8. RSTAFF_HOME resolution ---------------------------------------------------
  {
    if (settingsBroken) add('settings.json parses', 'FAIL', `${settingsPath} is not valid JSON — Claude Code will ignore it (fix it by hand)`);
    const envHome = (process.env.RSTAFF_HOME || '').trim();
    const envOk = envHome && exists(path.join(envHome, 'rstaff.json'));
    const settingsHome = (settings && settings.env && settings.env.RSTAFF_HOME) || '';
    const settingsOk = settingsHome && exists(path.join(settingsHome, 'rstaff.json'));
    if (envOk && settingsOk && envHome !== settingsHome) add('RSTAFF_HOME', 'WARN', `shell (${envHome}) and settings.json (${settingsHome}) disagree`);
    else if (envOk || settingsOk) add('RSTAFF_HOME', envOk && settingsOk ? 'PASS' : 'WARN', envOk && settingsOk ? envHome : `only ${envOk ? 'shell env' : 'settings.json'} sets it — run install/install-apply.sh --install to set both`);
    else add('RSTAFF_HOME', 'FAIL', 'unset/invalid in both shell and ~/.claude/settings.json — run install/install-apply.sh --install');
  }

  // 9. hooks live: SessionStart marker ------------------------------------------
  {
    const marker = path.join(HOME, 'var', 'sessions', '.last-session-start.json');
    const age = Date.now() - mtime(marker);
    if (!exists(marker)) add('hooks fired (session-start)', 'FAIL', 'no liveness marker yet — open a fresh Claude session, then re-run /health');
    else add('hooks fired (session-start)', age < DAY ? 'PASS' : 'FAIL', age < DAY ? `last fired ${Math.round(age / 60000)}m ago` : `marker is ${Math.round(age / DAY)}d old — plugin may not be loading`);
  }

  // 11. product profile for cwd ---------------------------------------------------
  {
    const cwd = process.cwd();
    if (path.resolve(cwd) === path.resolve(HOME)) add('product profile (cwd)', 'PASS', 'in the control repo itself');
    else {
      const prof = path.join(HOME, 'profiles', `${lib.slug(cwd)}.md`);
      add('product profile (cwd)', exists(prof) ? 'PASS' : 'WARN', exists(prof) ? prof : `no profiles/${lib.slug(cwd)}.md — create one so the loop knows this repo's verify/run commands`);
    }
  }

  // 12. cockpit GitHub prerequisites (backlog layer only) ---------------------
  if (backlogRoot) {
    const r = sh('gh', ['auth', 'status']);
    add('gh auth', r.status === 0 ? 'PASS' : 'WARN', r.status === 0 ? 'authenticated' : 'gh unavailable/unauthenticated — /cockpit GitHub sections will be skipped (gh auth login)');
  }

  // 13. external backend prerequisites (delegation layer only) ----------------
  if (delegationRoot) {
    const r = sh('sh', ['-c', 'command -v codex']);
    add('codex CLI', r.status === 0 ? 'PASS' : 'WARN', r.status === 0 ? r.stdout.trim()
      : 'not found — /codex unavailable AND every auto-routed task falls back to the Claude writer (codex login)');
  }

  // Installed role plugins can be disabled by a missing dependency marketplace.
  const loads = checkPluginLoads(sh);
  add('rstaff plugin loads', loads.status, loads.note);
}

// Delegation diagnostics are offline/report-only and also run under --static.
if (!delegationRoot) {
  add('delegation', 'INFO', 'delegation is not installed; skipping delegation checks');
} else {
  // 13b. Gemini document-drafting prerequisites. These are report-only: Gemini
  //       being unavailable must not take down the rest of /health or make CI fail.
  {
    const project = checkGeminiProject();
    add('gemini project', project.status, project.note);
    const cli = STATIC ? { status: 'PASS', note: `configured model ${GEMINI_DEFAULT_MODEL}; CLI probe skipped in static mode` } : checkGeminiCli();
    add('gemini CLI', cli.status, cli.note);
    const adc = STATIC ? { status: 'PASS', note: 'authentication probe skipped in static mode' } : checkGeminiAdc();
    add('gemini ADC', adc.status, adc.note);
  }

  // The one phrasing of "refresh the cache in the home rstaff actually spawns into".
  // Both codex checks hand it to the operator, and two copies is exactly how one of
  // them drifts back to naming the shared ~/.codex — the home the spawned CLI no
  // longer reads, so the fix silently never takes.
  const codexSeedHint = (home) => `any codex route through rstaff, or `
    + `\`CODEX_HOME=${home} codex exec -s read-only --skip-git-repo-check ping\``;

  // 14. codex tier support — does the INSTALLED codex accept each risk band's
  //     (model, effort) pair? `command -v codex` above only proves a binary exists.
  //     A pair the local CLI rejects dies inside a dispatched worker at spawn time,
  //     after the bad route is already persisted — so check it here, offline,
  //     against the catalog the CLI itself caches.
  {
    let route = null;
    let loadError = '';
    try { route = require(path.join(delegationRoot, 'scripts', 'route.js')); } catch (e) { loadError = e.message; }
    if (!route) {
      add('codex tier support', 'FAIL', `route.js did not load: ${loadError}`);
    } else {
      // rstaff's codex runs have their OWN CODEX_HOME, so the cache to
      // report on is that one — and the fix has to populate THAT home. "Run any codex
      // command" refreshes the operator's shared ~/.codex, which the spawned CLI no
      // longer reads, so it would look like a fix that never takes.
      const home = route.codexHome();
      const cache = path.join(home, 'models_cache.json');
      const seed = codexSeedHint(home);
      const bands = Object.entries(route.CODEX_TIER).map(([b, t]) => `${b}=${t.model}@${t.effort}`).join('  ');
      // route.loadCodexCatalog(), not a second copy of the same path + parse:
      // a diagnostic that reads a different file than the router is a diagnostic that
      // can pass while the thing it certifies is broken.
      const r = route.checkTierSupport(route.loadCodexCatalog());
      if (!r.verified) {
        add('codex tier support', STATIC ? 'PASS' : 'WARN', `no readable model catalog at ${cache} — cannot confirm ${bands} (populate it with ${seed})`);
      } else if (r.unsupported.length) {
        add('codex tier support', 'FAIL', `${r.unsupported.join('; ')} — either the tier table is wrong (fix CODEX_TIER in plugin/scripts/route.js) or this cache predates the level (codex update, then refresh ${cache} with ${seed})`);
      } else if (r.unknown.length) {
        add('codex tier support', STATIC ? 'PASS' : 'WARN', `not in the local catalog: ${r.unknown.join(', ')} — effort unconfirmed (codex update, or refresh ${cache} with ${seed})`);
      } else {
        add('codex tier support', 'PASS', bands);
      }
    }
  }

  // 14b. codex default model — what an explicit per-task `impl: codex` pin runs.
  //      That pin resolves to the `default` sentinel, so the runner omits `-m` and
  //      the model comes from codex's own config.toml. NEITHER check above sees it:
  //      `codex tier support` walks only the TIER TABLE, and `route.js resolve`
  //      checks only an OVERRIDDEN axis.
  //
  //      REPORT-ONLY on purpose. Measured 2026-09-09: config.toml
  //      named `gpt-6-astra`, which the installed codex-cli 0.146.0 refuses with
  //      HTTP 400 "requires a newer version of Codex", consuming a task attempt and
  //      writing nothing — while `gpt-5.6-sol` from the tier table ran fine on the
  //      same machine. Blocking codex routing on this condition would take the
  //      working paths down with the broken one, so this check never FAILs.
  //
  //      Note a catalog check alone would NOT have caught it: `gpt-6-astra` is
  //      present in models_cache.json offering every reasoning level, so
  //      `pairSupport` answers `ok` on the exact model that fails. The signal that
  //      does discriminate is the cache/CLI version inversion.
  {
    const bin = sh('sh', ['-c', 'command -v codex']);
    let route = null;
    try { route = require(path.join(delegationRoot, 'scripts', 'route.js')); } catch (_) { route = null; }
    // `var/` is gitignored and nothing outside delegate.run() seeds the dedicated
    // home, so a fresh clone's first `/health` reads an EMPTY directory. Reporting
    // that as "no top-level model" is the opposite of the truth: delegate.run()
    // symlinks the operator's config.toml in before it spawns, so their pin is
    // exactly what runs. Report the file codex will actually read, and say which.
    const home = route ? route.codexHome() : null;
    const source = route ? route.sharedCodexHome() : null;
    const cfg = home ? path.join(home, 'config.toml') : '<codex home>/config.toml';
    const seeded = home ? fs.existsSync(cfg) : false;
    const srcCfg = source ? path.join(source, 'config.toml') : '<operator home>/config.toml';
    if (STATIC && route) {
      const model = route.loadCodexDefaultModel(seeded ? home : source);
      add('codex default model', 'PASS', model ? `configured model ${model}; CLI probe skipped in static mode` : 'no configured model; CLI probe skipped in static mode');
    } else if (bin.status !== 0) {
      add('codex default model', 'WARN', 'codex is not installed — nothing to resolve (see `codex CLI` above)');
    } else if (!route) {
      add('codex default model', 'WARN', 'route.js did not load (see `codex tier support` above)');
    } else {
      const model = route.loadCodexDefaultModel(seeded ? home : source);
      const v = sh('codex', ['--version']);
      const parity = route.catalogParity(route.loadCodexCatalog(), (v.stdout || '') + ' ' + (v.stderr || ''));
      const reads = seeded ? cfg : cfg + ' is not seeded yet, so codex reads ' + srcCfg + ' (delegate.js links it in before the spawn), which';
      const named = model
        ? reads + ' names model = "' + model + '"'
        : reads + ' declares no top-level `model =`, so codex picks its own built-in default';
      if (parity.status === 'mismatch') {
        // Both directions are the same defect to codex, but not the same fix, so
        // the note has to say which way the skew runs.
        // The stamp is written BY the client that fetched, so EITHER direction is
        // cleared by one successful online run — measured: a refetch under 0.153.2
        // rewrote a 0.153.4 stamp to 0.153.2. Lead with that, because `codex update`
        // is not always available (a min-release-age npmrc pins the CLI behind latest).
        // Built from `home`, never from `cfg` — `cfg` may name the OPERATOR's file on
        // an unseeded home, which would send the refresh at the very shared ~/.codex
        // this check exists to steer away from.
        const fix = 'Fix: refresh the cache in the home rstaff spawns into — ' + codexSeedHint(home)
          + ' — while it can reach '
          + 'the API; it refetches and re-stamps the cache with this CLI\'s version, clearing this either way. '
          + 'rstaff\'s codex runs use that home alone, so if the WARN comes BACK, something else is '
          + 'writing there — most likely RSTAFF_CODEX_HOME points back at the shared ~/.codex, where the app\'s '
          + 'bundled `~/.codex/plugins/.plugin-appserver/codex` re-stamps the file and every other client then '
          + 'discards it. If it never clears at all, the refetch itself is failing (offline, or logged out)'
          + (parity.direction === 'newer'
            ? '. To keep the models the newer cache advertises instead, `codex update` to ' + parity.cache
              + ', or set a model this CLI accepts in ' + cfg + '.'
            : '.');
        add('codex default model', 'WARN',
          named + ' — but models_cache.json is stamped codex ' + parity.cache + ' while this CLI is ' + parity.cli
          + '. codex matches that stamp EXACTLY: it logs `cache version mismatch` then `no usable cache entry`, '
          + 'discards the whole file — a STALE cache just as readily as a newer one — and falls back to built-in '
          + 'metadata. So the `codex tier support` verdicts above are read from a file codex is ignoring, and a '
          + 'model only this cache advertises may be refused at spawn with HTTP 400 "requires a newer version of '
          + 'Codex", consuming the task attempt and writing nothing. A per-task `- impl: codex` pin is the only '
          + 'route that runs it. ' + fix);
      } else if (parity.status === 'unknown') {
        add('codex default model', 'WARN',
          named + ' — cannot compare the model cache against `codex --version` (cache='
          + (parity.cache || 'unreadable') + ', cli=' + (parity.cli || 'unreadable')
          + '), so an unusable default would not be caught here');
      } else {
        add('codex default model', 'PASS', named + '; model cache agrees with codex ' + parity.cli);
      }
    }
  }

}

// --- report -------------------------------------------------------------------
// The summary must never contradict the lines above it. "all green" printed over
// an install-drift WARN is how 4 commits of guard code sat uninstalled while this
// tool reported success — the exact "behind a success message" failure
// lib-install.js was written to end. WARN still does not fail the run (exit
// semantics unchanged); it just no longer gets to call itself green.
const failed = results.filter((r) => r.status === 'FAIL');
const warned = results.filter((r) => r.status === 'WARN');
const summary = failed.length ? `${failed.length} FAIL — fix the above, then re-run`
  : warned.length ? `no FAIL, ${warned.length} WARN — read the ⚠ line(s) above`
    : 'all green';
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ mode: STATIC ? 'static' : 'full', home: HOME, results, summary, ok: !failed.length }, null, 2) + '\n');
} else {
  const GLYPH = { PASS: '✓', WARN: '⚠', FAIL: '✗', INFO: '·' };
  const w = Math.max(...results.map((r) => r.check.length));
  console.log(`rstaff health — ${STATIC ? 'static (repo-only)' : 'full'} — control repo: ${HOME}`);
  for (const r of results) console.log(`  ${GLYPH[r.status]} ${r.check.padEnd(w)}  ${r.status.padEnd(4)}  ${r.note}`);
  console.log(`health: ${summary}`);
}
process.exit(failed.length ? 1 : 0);
}

if (require.main === module) runHealth();

module.exports = { checkNode, checkGeminiProject, checkGeminiCli, checkGeminiAdc, checkPluginLoads };
