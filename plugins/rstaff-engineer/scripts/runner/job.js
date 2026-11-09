'use strict';
// The job: half a page in plain words that the runner can execute. See var/jobs/<repo>/<ticket>/job.md.
const fs = require('node:fs');

const CHECK = /^\s*(?:\d+[.)]|-)\s+`([^`]+)`\s*(?:→|->)\s*exit\s+(\d+)\s*(?:,\s*output contains\s+"([^"]*)")?\s*$/;

function section(lines, name) {
  const start = lines.findIndex((line) => /^##\s/.test(line) && line.slice(2).trim().toLowerCase().startsWith(name));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && !/^##?\s/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}
function field(lines, key) {
  const re = new RegExp(`^-\\s*${key}:\\s*(.+?)\\s*$`, 'i');
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return null;
}
function number(text, unit) {
  if (text === null) return null;
  const m = text.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${unit})\\b`, 'i'));
  return m ? Number(m[1]) : null;
}

// Parse a job.md; throws with a plain reason when it cannot be run.
function parseJob(text) {
  const lines = text.split(/\r?\n/);
  const title = (lines.find((line) => /^#\s/.test(line)) || '').replace(/^#\s*/, '').trim();
  const head = lines.slice(0, lines.findIndex((line) => /^##\s/.test(line)) < 0 ? lines.length : lines.findIndex((line) => /^##\s/.test(line)));
  const repo = field(head, 'repo');
  const ticket = field(head, 'ticket');
  const problems = [];
  if (!title) problems.push('needs a `# Job: …` title line');
  if (!repo) problems.push('needs a `- repo:` line');
  if (!ticket) problems.push('needs a `- ticket:` line');
  const checks = [];
  for (const line of section(lines, 'checks')) {
    if (!line.trim()) continue;
    const m = line.match(CHECK);
    if (!m) { problems.push(`check line not runnable: ${line.trim()}`); continue; }
    checks.push({ command: m[1], exit: Number(m[2]), contains: m[3] === undefined ? null : m[3] });
  }
  if (checks.length < 3 || checks.length > 6) problems.push(`needs three to six checks, found ${checks.length}`);
  const bullets = (name) => section(lines, name).map((line) => line.match(/^\s*-\s+`?([^`]+?)`?\s*$/)).filter(Boolean).map((m) => m[1]);
  const forbidden = bullets('do not touch');
  // `## Files`: the only paths the worker may change. Absent means no limit beyond the do-not-touch list.
  const allowed = bullets('files');
  const caps = section(lines, 'caps');
  const timeMinutes = number(field(caps, 'time'), 'minutes?|min') ?? (number(field(caps, 'time'), 'hours?|h') !== null ? number(field(caps, 'time'), 'hours?|h') * 60 : null);
  const moneyUsd = number(field(caps, 'money'), 'USD|\\$|dollars?');
  const workerTurns = number(field(caps, 'worker turns'), '(?:turns?)?') ?? 60;
  const rounds = number(field(caps, 'rounds'), '(?:rounds?)?') ?? 3;
  if (timeMinutes === null) problems.push('caps need `- time: N minutes`');
  if (moneyUsd === null) problems.push('caps need `- money: N USD`');
  if (problems.length) throw new Error(`job.md: ${problems.join('; ')}`);
  const branch = field(head, 'branch') || `rstaff/${ticket.toLowerCase()}`;
  // "Job: T-1 — stop the double count" → "stop the double count" (the PR and commit title).
  const summary = title.replace(/^Job:\s*/i, '').replace(new RegExp(`^${ticket.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*[—–:-]\\s*`), '').trim() || title;
  return { title, summary, repo, ticket, branch, checks, forbidden, allowed, caps: { timeMinutes, moneyUsd, workerTurns, rounds: Math.min(rounds, 3) }, text };
}

function readJob(file) {
  return parseJob(fs.readFileSync(file, 'utf8'));
}

// Glob → RegExp for the do-not-touch list: `**` any path, `*` within one segment, a trailing `/` means the directory.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (glob.endsWith('/')) re += '.*';
  return new RegExp(`^${re}$`);
}
function matcher(globs) {
  const rules = globs.map((glob) => ({ glob, re: globToRegExp(glob) }));
  return (p) => rules.some(({ re, glob }) => re.test(p) || p.startsWith(glob.replace(/\/$/, '') + '/'));
}
function forbiddenTouched(forbidden, paths) {
  return paths.filter(matcher(forbidden));
}
// Paths the job's `## Files` list does not cover; an empty list covers everything.
function outsideAllowed(allowed, paths) {
  if (!allowed.length) return [];
  const inside = matcher(allowed);
  return paths.filter((p) => !inside(p));
}

module.exports = { parseJob, readJob, globToRegExp, forbiddenTouched, outsideAllowed };
