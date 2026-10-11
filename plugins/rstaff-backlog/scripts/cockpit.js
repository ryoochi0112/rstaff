#!/usr/bin/env node
// /cockpit — a read-only ENGINEERING dashboard recomputed from ground truth.
// Active /dispatch runs, managed repos with GitHub activity (open PRs, last CI,
// last commit), and a top-3 attention heuristic. Company strategy is not shown
// here — it lives in a separate strategy repo.
//   node cockpit.js            # print to stdout
//   node cockpit.js --write    # + cache to var/cockpit-latest.md
//   node cockpit.js --json     # structured
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require(path.join(__dirname, '..', 'hooks', 'lib.js'));
const S = require(path.join(__dirname, 'lib-state.js'));
const coreRoot = require('./locate.js').locate('rstaff');
if (!coreRoot) throw new Error('cockpit: core plugin rstaff not found');
const B = require(path.join(coreRoot, 'scripts', 'lib-backlog.js'));
const usageRoot = require('./locate.js').locate('rstaff-usage');
const U = usageRoot ? require(path.join(usageRoot, 'scripts', 'usage.js')) : null;
const fs = lib.fs;

const WRITE = process.argv.includes('--write');
const JSON_OUT = process.argv.includes('--json');
const home = lib.resolveHome(process.cwd());
const data = S.collect(home);
const usage = U ? U.summarizeCached(path.join(home, 'var', 'usage.jsonl'), Date.now(), 30) : [];

function sh(cmd, args, cwd) {
  try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, cwd }); }
  catch (_) { return { status: 1, stdout: '', stderr: '' }; }
}
const ghOk = sh('gh', ['auth', 'status']).status === 0;

// GitHub activity per managed repo (best-effort; skips GitHub data when gh is absent).
function github(repo) {
  const remote = sh('git', ['remote', 'get-url', 'origin'], repo.path);
  if (remote.status !== 0 || !remote.stdout.trim()) return { ...repo, kind: 'local-only' };
  const m = remote.stdout.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\s*$/);
  if (!m) return { ...repo, kind: 'non-github' };
  const slug = `${m[1]}/${m[2]}`;
  const out = { ...repo, kind: 'github', slug };
  const head = sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo.path);
  out.branch = head.status === 0 ? head.stdout.trim().replace(/^origin\//, '') : 'main';
  const last = sh('git', ['log', '-1', '--format=%cr|%s'], repo.path);
  if (last.status === 0) { const [rel, ...s] = last.stdout.trim().split('|'); out.lastCommit = { rel, subject: (s.join('|') || '').slice(0, 60) }; }
  if (ghOk) {
    const prs = sh('gh', ['pr', 'list', '-R', slug, '--json', 'number,title,createdAt', '--limit', '10']);
    if (prs.status === 0) { try { out.prs = JSON.parse(prs.stdout); } catch (_) { out.prs = []; } }
    const run = sh('gh', ['run', 'list', '-R', slug, '--branch', out.branch, '--limit', '1', '--json', 'conclusion,status,displayTitle']);
    if (run.status === 0) { try { out.ci = JSON.parse(run.stdout)[0] || null; } catch (_) {} }
  } else out.ghSkipped = true;
  return out;
}
const repos = data.repos.map(github);

// Backlog joins use the profile filename token, not github()'s owner/name slug.
// Keep both sides normalized so profiles such as Aristotle.md join parseDir()
// tickets tagged as aristotle.
const groundTruth = {
  // Rows reconciled as dead are filtered at this boundary, not inside rank():
  // groundTruth is the caller's construction, and rank stays two-valued.
  // `live !== false`, not `=== true` — an unprobeable row behaves as it does today.
  dispatch: (data.dispatch || []).filter((d) => d.live !== false).map((d) => ({ ...d, repo: lib.slug(d.repo) })),
  repos: data.repos.map((original, i) => ({
    slug: lib.slug(original.slug),
    branch: repos[i].branch,
    ci: repos[i].ci || null,
  })),
  ghAvailable: ghOk,
};
const parsedBacklog = B.parseDir(home);
const queue = B.rank(parsedBacklog.tickets, groundTruth, Date.now());
queue.gaps.unshift(...parsedBacklog.gaps);
const ticketByKey = new Map(parsedBacklog.tickets.map((ticket) => [`${ticket.repo}\0${ticket.id}`, ticket]));

// --- attention heuristic: dispatch needing you → red CI → open PRs piling up ---
const attention = [];
for (const d of (data.dispatch || [])) if (d.live !== false && /needs_human|stopped/.test(d.state || '')) attention.push(`dispatch ${d.repo}/${d.slug} needs you: ${d.next || 'review parked tasks'}`);
const CI_BAD = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);
for (const r of repos) if (r.ci && CI_BAD.has(r.ci.conclusion)) attention.push(`${r.slug}: last CI on ${r.branch} = ${r.ci.conclusion} — /review or fix`);
for (const r of repos) if (r.prs && r.prs.length >= 3) attention.push(`${r.slug}: ${r.prs.length} open PRs — /review → /land the ready ones`);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ home, generatedAt: new Date().toISOString(), ...data, repos, usage, attention: attention.slice(0, 3), queue }, null, 2) + '\n');
  process.exit(0);
}

// --- render ---
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const L = [];
const p = (s) => L.push(s);
p(`# rstaff eng cockpit — ${stamp}`);
p(`control repo: ${home}${ghOk ? '' : ' · (gh unavailable — GitHub sections skipped)'}`);

p(`\n## What to work on next  (${queue.ranked.length + queue.blocked.length} open · ${queue.blocked.length} blocked · ranked from ground truth)`);
if (queue.ranked.length) {
  for (const [i, ticket] of queue.ranked.entries()) {
    p(`${i + 1}. ${ticket.repo}  ${ticket.id}  ${ticket.pri}  ${ticket.title}`);
    p(`   why: ${ticket.reason} · route: ${ticket.route}`);
  }
} else p('- none');
if (queue.blocked.length) {
  p(`\nBlocked (${queue.blocked.length})`);
  for (const ticket of queue.blocked) {
    const blockerIds = (ticket.reason.match(/^waiting on (.+)$/)?.[1] || ticket.reason.replace(/^waiting on /, ''))
      .split(',').map((id) => id.trim()).filter(Boolean);
    const blockers = blockerIds.map((blockerId) => {
      const blocker = ticketByKey.get(`${ticket.repo}\0${blockerId}`);
      return `${blockerId}${blocker ? ` (${blocker.title})` : ''}`;
    });
    p(`- ${ticket.repo} ${ticket.id}  waiting on ${blockers.join(', ')}`);
  }
}
if (!ghOk) p('\nSignal unavailable: gh not authenticated — CI and PR rank inputs omitted.');
if (queue.gaps.length) {
  p('\nQueue gaps');
  for (const gap of queue.gaps) p(`- ${gap.repo || '-'} ${gap.id || gap.heading || '(unknown)'} — ${gap.reason}`);
}

if (data.dispatch && data.dispatch.length) {
  p('\n## Active dispatch runs');
  for (const d of data.dispatch) {
    // Only re-derive rows that declare a state we understand, so task briefs and
    // other non-run files under var/dispatch/ render exactly as they do today.
    const stale = d.live === false && !!d.state;
    const flag = !stale && /needs_human|stopped/.test(d.state || '') ? '⚠ ' : '';
    // Show the normalized ref, not the raw field: real files trail prose after the
    // branch name ("feat/x (merged, deleted)", or a whole paragraph). Fall back to
    // the raw value when it names no ref, since then the prose is the only signal.
    const branchLabel = d.ref || d.branch;
    const branchSeg = branchLabel ? ` · ${branchLabel}${stale ? ' (gone — row is stale)' : ''}` : '';
    p(`- ${flag}${d.repo}/${d.slug} — ${d.state || '?'}${d.tasks ? ` · ${d.tasks}` : ''}${branchSeg}${d.next && d.next !== 'none' ? ` · next: ${d.next}` : ''}`);
  }
} else {
  p('\n## Active dispatch runs\n- none in flight');
}

p('\n## Managed repos');
for (const r of repos) {
  if (r.kind !== 'github') { p(`- ${r.slug} — ${r.kind}${r.control ? ' (control repo)' : ''} · ${r.path}`); continue; }
  const ci = r.ci ? `CI(${r.branch}): ${r.ci.conclusion || r.ci.status || '?'}` : (r.ghSkipped ? 'CI: (gh skipped)' : 'CI: —');
  const prs = r.prs ? `${r.prs.length} open PR${r.prs.length === 1 ? '' : 's'}` : (r.ghSkipped ? 'PRs: (gh skipped)' : 'PRs: —');
  p(`- ${r.slug}${r.control ? ' (control)' : ''} — ${prs} · ${ci} · last commit ${r.lastCommit ? r.lastCommit.rel : '?'}`);
  if (r.prs) for (const pr of r.prs.slice(0, 5)) p(`    #${pr.number} ${String(pr.title).slice(0, 60)}`);
}

if (U) {
  p('\n## Token usage (30d)');
  if (usage.length) {
    for (const g of usage.slice(0, 5)) {
      const tokens = g.measuredRuns ? `${g.totalTokens.toLocaleString('en-US')} tokens` : 'tokens —';
      p(`- ${g.route} — ${g.measuredRuns}/${g.runs} measured · ${tokens}${g.unmeasuredRuns ? ` · ${g.unmeasuredRuns} unmeasured` : ''}`);
    }
  } else p('- no captured runs');
}

p('\n## Attention next');
if (attention.length) for (const a of attention.slice(0, 3)) p(`- ${a}`);
else p('- nothing urgent');

const report = L.join('\n') + '\n';
process.stdout.write(report);

if (WRITE) {
  try {
    const varDir = path.join(home, 'var');
    lib.ensureDir(varDir);
    fs.writeFileSync(path.join(varDir, 'cockpit-latest.md'), report);
  } catch (e) { lib.warn(`cannot write var/cockpit-latest.md: ${e.code || e.message}`); }
}
