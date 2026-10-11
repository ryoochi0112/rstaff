#!/usr/bin/env node
// SessionStart injects install drift, the matching product profile,
// credential preflight, and backlog counts.
'use strict';
const { path, readEvent, resolveHome, isControlRepo, slug, safeRead, ensureDir, warn, emitContext, fs } = require('./lib');

const ev = readEvent();
const cwd = ev.cwd || process.cwd();
const home = resolveHome(cwd);

// No control repo anywhere → memory is OFF. Say so once, loudly — silent
// no-op is silent memory loss. RSTAFF_QUIET=1 restores the old silence.
if (!fs.existsSync(path.join(home, 'rstaff.json'))) {
  if (process.env.RSTAFF_QUIET === '1') process.exit(0);
  const why = process.env.RSTAFF_HOME
    ? `RSTAFF_HOME=${process.env.RSTAFF_HOME} is invalid`
    : 'RSTAFF_HOME unset, no rstaff.json found walking up';
  const msg = `rstaff: control repo NOT found (${why}) — memory OFF. Fix: install/install-apply.sh --install, then /health.`;
  warn(msg);
  emitContext('SessionStart', msg);
}

// Liveness marker: proof for /health that this hook actually fired. Only write
// into a genuine rstaff control repo (see lib.isControlRepo) — otherwise a bare
// walk-up hit on a foreign repo would drop untracked files into its tree.
if (isControlRepo(home)) {
  try {
    const sess = path.join(home, 'var', 'sessions');
    ensureDir(sess);
    fs.writeFileSync(path.join(sess, '.last-session-start.json'),
      JSON.stringify({ ts: new Date().toISOString(), cwd, home }) + '\n');
  } catch (e) { warn(`cannot write session marker: ${e.code || e.message}`); }
}

// Warn (non-blocking) about dev tokens whose profile-recorded `expires:` date is
// past or within WARN_DAYS. Parses the profile's `## credentials` section, which
// holds metadata only (persona / expiry / refresh) — never the token value.
function credentialWarnings(profileText, nowMs = Date.now()) {
  if (!profileText) return [];
  const WARN_DAYS = 7;
  const out = [];
  let inSec = false;
  for (const line of profileText.split('\n')) {
    if (/^##\s+credentials\b/i.test(line)) { inSec = true; continue; }
    if (inSec && /^##\s/.test(line)) break;
    if (!inSec) continue;
    const m = line.match(/`?([A-Za-z0-9_]+)`?[^\n]*?expires:\s*(\d{4}-\d{2}-\d{2})/i);
    if (!m) continue;
    const exp = Date.parse(`${m[2]}T23:59:59Z`);
    if (Number.isNaN(exp)) continue;
    const days = Math.floor((exp - nowMs) / 864e5);
    if (days < 0) out.push(`- ❌ \`${m[1]}\` EXPIRED ${m[2]} (${-days}d ago) — refresh before /build or /qa.`);
    else if (days <= WARN_DAYS) out.push(`- ⚠ \`${m[1]}\` expires ${m[2]} (${days}d left) — refresh soon.`);
  }
  return out;
}

const parts = [];

// Install drift — FIRST, because everything below it is advice from a copy of
// rstaff that may not be the one running. The detector already existed
// (maintainer/lib-install.js) and /health already reported it; it was invoked 0
// times in the 3 days when 4 commits of guard code sat uninstalled, and
// `claude plugin update` answered "already at the latest version" the whole
// time. An on-demand check cannot catch a continuous condition, so it moves to
// the one hook that fires every session.
//
// Deliberately NOT gated on cwd being the control repo: a stale hook misfires in
// every repo, and most sessions are not here. Bounded git timeout so a locked
// index can't spend the hook's whole 10s budget and take memory down with it.
try {
  const installCheck = path.join(home, 'maintainer', 'lib-install.js');
  if (fs.existsSync(installCheck)) {
    const v = require(installCheck).checkInstall(home, undefined, { timeoutMs: 1500 });
    if (v.status === 'FAIL' || v.status === 'WARN') {
      parts.push(`## ${v.status === 'FAIL' ? '⛔' : '⚠'} rstaff install drift — the hooks running are NOT the ones in this repo\n`
        + `- ${v.note}\n`
        + `- Until that is done, edits to plugins/ (hooks, commands, guards) do not take effect. Say so if the human relies on one.\n`);
    }
  }
} catch (_) {}

// Per-product profile (the loop's brain for this repo: verify/run/QA commands).
// Matched by repo dir name → profiles/<slug(cwd)>.md.
try {
  const prof = path.join(home, 'profiles', `${slug(cwd)}.md`);
  let body = safeRead(prof, 4000).trim();
  // Show the agent the exact verify string the recorder matches (aliases expanded).
  try {
    const { expandVerify } = require('../scripts/lib-gate.js');
    let done = false;
    body = body.split('\n').map((line) => {
      if (done || !/^\s*\*\*Verify \(DoD\):\*\*/.test(line)) return line;
      done = true;
      return line.replace(/`([^`]+)`/, (span, cmd) => `\`${expandVerify(cmd)}\``);
    }).join('\n');
  } catch (_) {}
  if (body) parts.push(`## Product profile — ${slug(cwd)} (USE these verify/run/QA commands as the DoD)\n${body}\n`);
  // Credential preflight (non-blocking): warn if a dev token in the profile's
  // `## credentials` section is past / near its recorded expiry. Metadata only.
  const cw = credentialWarnings(safeRead(prof));
  if (cw.length) parts.push(`## ⚠ Credential preflight — refresh before /build or /qa\n${cw.join('\n')}\n`);
} catch (_) {}

// Backlog stays pull-only: inject counts and a /cockpit pointer, never the queue.
try {
  const backlogRoot = require('../scripts/locate.js').locate('rstaff-backlog');
  if (backlogRoot) {
    const tickets = require(path.join(__dirname, '..', 'scripts', 'lib-backlog.js')).parseDir(home).tickets;
    const open = tickets.filter((ticket) => ticket.status === 'open');
    if (open.length) {
      const p0 = open.filter((ticket) => ticket.pri === 'P0').length;
      const repos = new Set(open.map((ticket) => ticket.repo)).size;
      parts.push(`${p0} P0 · ${open.length} open across ${repos} repos — /rstaff-backlog:cockpit\n`);
    }
  }
} catch (_) {}

if (!parts.length) {
  // Control repo present but nothing to say for this repo — stay silent.
  process.exit(0);
}

const header = `# rstaff memory (control repo: ${home})
Engineering-team memory below. Give a repo a profile at profiles/<repo>.md so the loop knows its verify/run/QA commands.
Human-read docs (README/ADR/design doc/Notion): propose \`/write\` in one line first; AI-read artifacts stay on Claude.

`;
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: header + parts.join('\n') },
}));
process.exit(0);
