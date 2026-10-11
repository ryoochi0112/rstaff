#!/usr/bin/env node
// rstaff backlog parser, validator, ranker, and CLI — Node built-ins only.
// Reads ledger-shaped ticket sections; summary tables remain human-facing.
'use strict';
const path = require('path');
const lib = require(path.join(__dirname, '..', 'hooks', 'lib.js'));
const fs = lib.fs;

const FIELDS = ['status', 'pri', 'route', 'deps', 'source', 'filed', 'falsifier', 'cheapest-test', 'links', 'context'];
const STATUS = new Set(['open', 'in-progress', 'blocked', 'done', 'wontfix']);
const PRIORITY = new Set(['P0', 'P1', 'P2']);
const ROUTE = new Set(['spec', 'plan', 'experiment', 'build', 'none']);
const SOURCE = new Set(['hand', 'interview']);

// route and the <TYPE> id prefix are display + validation only. The T3 ranker
// must never read either for ordering: the prefix is a human affordance and
// route says where work goes next; gating rank on them would let the two drift.
// deps, links, filed, status, and pri are retained for that later ranker; id,
// title, route, and context are also render inputs added by T3/T4.
// deps and links are multi-valued: consumers accept `,` or `;`, trim whitespace,
// and drop empty values; producers emit `;`.

function parseSection(heading, lines) {
  const hm = heading.match(/^##\s+([A-Za-z]+-\d+):\s*(\S.*)$/);
  if (!hm) {
    const im = heading.match(/^##\s+([A-Za-z]+-\d+)/);
    return { gap: { id: im ? im[1] : null, heading, reason: 'unparseable heading' } };
  }

  const values = {};
  let continuation = null;
  for (const line of lines) {
    const fm = line.match(/^-\s+([a-z-]+):\s*(.*)$/);
    if (fm) {
      continuation = null;
      if (!FIELDS.includes(fm[1])) continue;
      if (Object.prototype.hasOwnProperty.call(values, fm[1])) {
        return { gap: { id: hm[1], reason: `duplicate field: ${fm[1]}` } };
      }
      values[fm[1]] = fm[2].trim();
      if (fm[1] === 'context') continuation = 'context';
    } else if (continuation === 'context') {
      values.context += `\n${line.trim()}`;
    }
  }

  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(values, field)
      || (field === 'context' && !values[field].trim())) {
      return { gap: { id: hm[1], reason: `missing required field: ${field}` } };
    }
  }
  values.context = values.context.trim();
  return { ticket: { id: hm[1], title: hm[2].trim(), ...values } };
}

// Parse sections as the source of truth. Malformed sections are named, never
// allowed to hide the well-formed sections that follow them.
function parse(text) {
  const out = { tickets: [], gaps: [] };
  try {
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^##\s+/.test(lines[i])) continue;
      const heading = lines[i].trim();
      const body = [];
      while (++i < lines.length && !/^##\s+/.test(lines[i])) body.push(lines[i]);
      i--;
      const parsed = parseSection(heading, body);
      if (parsed.ticket) out.tickets.push(parsed.ticket);
      else out.gaps.push(parsed.gap);
    }
  } catch (_) {}
  return out;
}

function parseDir(home) {
  const out = { tickets: [], gaps: [] };
  const dir = path.join(home, 'backlog');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch (_) { return out; }
  for (const f of files) {
    const repo = lib.slug(f.replace(/\.md$/, ''));
    const parsed = parse(lib.safeRead(path.join(dir, f), 512 * 1024));
    out.tickets.push(...parsed.tickets.map((ticket) => ({ ...ticket, repo })));
    out.gaps.push(...parsed.gaps.map((gap) => ({ ...gap, repo })));
  }
  return out;
}

function validDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(m[1])
    && date.getUTCMonth() + 1 === Number(m[2])
    && date.getUTCDate() === Number(m[3]);
}

function validate(tickets) {
  const errors = [];
  const seen = new Map();
  if (!Array.isArray(tickets)) return ['(unknown): tickets must be an array'];
  for (const ticket of tickets) {
    const t = ticket && typeof ticket === 'object' ? ticket : {};
    const id = String(t.id || '(unknown)');
    const repo = String(t.repo || '');
    const key = `${repo}\0${id}`;
    if (seen.has(key)) errors.push(`${id}: duplicate id within repo${repo ? ` ${repo}` : ''}`);
    else seen.set(key, true);
    if (!STATUS.has(t.status)) errors.push(`${id}: invalid status: ${String(t.status || '')}`);
    if (!PRIORITY.has(t.pri)) errors.push(`${id}: invalid pri: ${String(t.pri || '')}`);
    if (!ROUTE.has(t.route)) errors.push(`${id}: invalid route: ${String(t.route || '')}`);
    if (!SOURCE.has(t.source)) errors.push(`${id}: invalid source: ${String(t.source || '')}`);
    if (!validDate(t.filed)) errors.push(`${id}: invalid filed date: ${String(t.filed || '')}`);
    if (!String(t.context || '').trim()) errors.push(`${id}: context must be non-empty`);
    if (t.source === 'interview') {
      if (!String(t.falsifier || '').trim() || t.falsifier === '-') errors.push(`${id}: interview source requires falsifier`);
      if (!String(t['cheapest-test'] || '').trim() || t['cheapest-test'] === '-') errors.push(`${id}: interview source requires cheapest-test`);
    }
  }
  return errors;
}

const CI_BAD = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);
const DAY_MS = 24 * 60 * 60 * 1000;

function repoKey(ticket) {
  return ticket && Object.prototype.hasOwnProperty.call(ticket, 'repo')
    ? String(ticket.repo) : '';
}

function dependencyIds(value) {
  if (!value || value === '-') return [];
  return [...new Set(String(value).split(/[\s,;]+/).filter(Boolean))];
}

function dispatchSlugs(value) {
  if (!value || value === '-') return [];
  return String(value).split(/[,;]/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = part.match(/^dispatch:(.+)$/);
    return m ? m[1].trim() : null;
  }).filter(Boolean);
}

function clockMs(now) {
  if (now === undefined || now === null || now === ''
    || (typeof now !== 'string' && typeof now !== 'number')) {
    throw new Error('now parameter is required and must be an ISO-8601 string or epoch-ms number');
  }
  const ms = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(ms)) {
    throw new Error('now parameter must be a parseable ISO-8601 string or epoch-ms number');
  }
  return ms;
}

function compareTickets(a, b) {
  // Malformed filed dates are validation errors, but rank() remains deterministic
  // when called directly: they sort after dated tickets and receive a named reason.
  const aFiled = validDate(a.filed) ? Date.parse(`${a.filed}T00:00:00Z`) : Infinity;
  const bFiled = validDate(b.filed) ? Date.parse(`${b.filed}T00:00:00Z`) : Infinity;
  return aFiled - bFiled
    || String(a.id).localeCompare(String(b.id))
    || repoKey(a).localeCompare(repoKey(b));
}

// The ground-truth repo key is the profile-filename token used by parseDir(),
// not cockpit.js's later owner/name reassignment. T6 must preserve that token
// when it constructs this argument or these joins will deliberately not match.
function rank(tickets, groundTruth, now) {
  const nowMs = clockMs(now);
  const input = Array.isArray(tickets) ? tickets : [];
  const truth = groundTruth && typeof groundTruth === 'object' ? groundTruth : {};
  // Dispatch is local ground truth and remains available without gh; only CI is
  // gated by ghAvailable. Missing signal arrays are handled independently.
  const dispatch = Array.isArray(truth.dispatch) ? truth.dispatch : [];
  const repos = truth.ghAvailable === true && Array.isArray(truth.repos) ? truth.repos : [];

  const unique = [];
  const gaps = [];
  const byKey = new Map();
  for (const ticket of input) {
    const key = `${repoKey(ticket)}\0${String(ticket && ticket.id)}`;
    if (byKey.has(key)) {
      gaps.push({
        id: ticket.id,
        repo: repoKey(ticket),
        reason: 'duplicate id within repo; kept first occurrence',
      });
      continue;
    }
    byKey.set(key, ticket);
    unique.push(ticket);
  }

  const depsByKey = new Map();
  for (const ticket of unique) {
    depsByKey.set(`${repoKey(ticket)}\0${ticket.id}`, dependencyIds(ticket.deps));
  }

  // Only open tickets participate in the ready graph. done/wontfix tickets
  // satisfy or terminate dependency edges; in-progress/blocked tickets remain
  // unavailable, but none of those four statuses belongs in either output list.
  const openKeys = new Set(unique.filter((ticket) => ticket.status === 'open')
    .map((ticket) => `${repoKey(ticket)}\0${ticket.id}`));
  const cyclePathByKey = new Map();
  const state = new Map();
  const stack = [];
  const visit = (key) => {
    if (state.get(key) === 2) return;
    if (state.get(key) === 1) {
      const start = stack.indexOf(key);
      const cycle = stack.slice(start);
      for (let i = 0; i < cycle.length; i++) {
        const rotated = cycle.slice(i).concat(cycle.slice(0, i), cycle[i]);
        cyclePathByKey.set(cycle[i], rotated.map((item) => byKey.get(item).id).join('→'));
      }
      return;
    }
    state.set(key, 1);
    stack.push(key);
    const ticket = byKey.get(key);
    const nextKeys = (depsByKey.get(key) || [])
      .map((id) => `${repoKey(ticket)}\0${id}`)
      .filter((depKey) => openKeys.has(depKey))
      .sort();
    for (const nextKey of nextKeys) visit(nextKey);
    stack.pop();
    state.set(key, 2);
  };
  for (const key of [...openKeys].sort()) visit(key);

  const fanOut = new Map();
  for (const ticket of unique) {
    // A done or wontfix ticket no longer waits on a dependency. Explicitly
    // blocked and in-progress tickets still count because the dependency is live.
    if (ticket.status === 'done' || ticket.status === 'wontfix') continue;
    for (const depId of dependencyIds(ticket.deps)) {
      const depKey = `${repoKey(ticket)}\0${depId}`;
      if (!byKey.has(depKey) || depKey === `${repoKey(ticket)}\0${ticket.id}`) continue;
      const ids = fanOut.get(depKey) || [];
      ids.push(ticket.id);
      fanOut.set(depKey, ids);
    }
  }
  for (const ids of fanOut.values()) ids.sort();

  const ranked = [];
  const blocked = [];
  for (const ticket of unique) {
    if (ticket.status !== 'open') continue;
    const key = `${repoKey(ticket)}\0${ticket.id}`;
    if (cyclePathByKey.has(key)) {
      blocked.push({ ...ticket, reason: `cycle: ${cyclePathByKey.get(key)}` });
      continue;
    }
    const unmet = dependencyIds(ticket.deps).filter((id) => {
      const dep = byKey.get(`${repoKey(ticket)}\0${id}`);
      return !dep || dep.status !== 'done';
    }).sort();
    if (unmet.length) {
      blocked.push({ ...ticket, reason: `waiting on ${unmet.join(', ')}` });
      continue;
    }

    let rule = 6;
    let reason = '';
    const linkedDispatch = dispatchSlugs(ticket.links).map((slug) =>
      dispatch.find((entry) => entry && lib.slug(entry.slug) === lib.slug(slug)
        && String(entry.repo) === repoKey(ticket)
        && /^needs_human\b/.test(String(entry.state || ''))))
      .find(Boolean);
    if (linkedDispatch) {
      rule = 1;
      const next = String(linkedDispatch.next || '').trim();
      reason = `dispatch ${linkedDispatch.slug} at needs_human — ${next && next !== 'none' ? next : 'review parked tasks'}`;
    } else if (ticket.pri === 'P0') {
      rule = 2;
      reason = 'unblocked P0';
    } else if ((fanOut.get(key) || []).length) {
      rule = 3;
      const ids = fanOut.get(key);
      reason = `blocks ${ids.length} ticket(s): ${ids.join(', ')}`;
    } else {
      const repo = repos.find((entry) => entry && String(entry.slug) === repoKey(ticket));
      if (repo && repo.ci && CI_BAD.has(repo.ci.conclusion)) {
        rule = 4;
        reason = `red CI on ${repo.branch}`;
      } else if (ticket.pri === 'P1') {
        rule = 5;
        reason = 'unblocked P1';
      } else {
        const filedMs = Date.parse(`${ticket.filed}T00:00:00Z`);
        if (Number.isFinite(filedMs)) {
          const days = Math.max(0, Math.floor((nowMs - filedMs) / DAY_MS));
          reason = `oldest unblocked (filed ${days}d ago)`;
        } else {
          reason = 'oldest unblocked (filed date unknown)';
        }
      }
    }
    ranked.push({ ...ticket, reason, _rule: rule });
  }

  ranked.sort((a, b) => a._rule - b._rule || compareTickets(a, b));
  blocked.sort(compareTickets);
  return {
    ranked: ranked.map(({ _rule, ...ticket }) => ticket),
    blocked,
    gaps,
  };
}

const COMMAND_OPTIONS = {
  list: new Set(['repo', 'json']),
  rank: new Set(['repo', 'now', 'json']),
  add: new Set(['repo', 'type', 'id', 'title', 'pri', 'route', 'deps', 'links', 'source',
    'filed', 'falsifier', 'cheapest-test', 'context', 'json']),
  validate: new Set(['repo', 'json']),
};

function parseArgs(argv) {
  const input = Array.isArray(argv) ? argv : [];
  const command = input[0];
  if (!Object.prototype.hasOwnProperty.call(COMMAND_OPTIONS, command)) {
    throw new Error('command must be one of: list, rank, add, validate');
  }
  const out = { command, json: false };
  const seen = new Set();
  for (let i = 1; i < input.length; i++) {
    const token = input[i];
    if (!/^--[a-z-]+$/.test(token)) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!COMMAND_OPTIONS[command].has(name)) throw new Error(`${command} does not accept --${name}`);
    if (seen.has(name)) throw new Error(`--${name} may only be specified once`);
    seen.add(name);
    if (name === 'json') {
      out.json = true;
      continue;
    }
    if (i + 1 >= input.length || /^--[a-z-]+$/.test(input[i + 1])) {
      throw new Error(`--${name} requires a value`);
    }
    out[name] = input[++i];
  }

  if (out.repo !== undefined) validateRepoToken(out.repo);
  if (command === 'rank' && out.now !== undefined && !Number.isFinite(Date.parse(out.now))) {
    throw new Error('--now must be a parseable ISO-8601 value');
  }
  if (command === 'add') {
    for (const name of ['repo', 'title', 'pri', 'route', 'context']) {
      if (!String(out[name] || '').trim()) throw new Error(`add requires --${name}`);
    }
    const hasType = out.type !== undefined;
    const hasId = out.id !== undefined;
    if (hasType === hasId) throw new Error('add requires exactly one of --type or --id');
    if (hasType && !/^[A-Z]+$/.test(out.type)) throw new Error('--type must contain uppercase letters only');
    if (hasId && !/^[A-Za-z]+-\d+$/.test(out.id)) throw new Error('--id must match [A-Za-z]+-\\d+');
    for (const name of ['title', 'pri', 'route', 'deps', 'links', 'source', 'filed',
      'falsifier', 'cheapest-test']) {
      if (out[name] !== undefined && /[\r\n]/.test(out[name])) {
        throw new Error(`--${name} must be a single line`);
      }
    }
  }
  return out;
}

function validateRepoToken(repo) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(repo || ''))) {
    throw new Error('--repo must be a profile-filename token');
  }
  return String(repo);
}

function readBacklog(home, repo) {
  if (!repo) return parseDir(home);
  const token = validateRepoToken(repo);
  const parsed = parse(lib.safeRead(path.join(home, 'backlog', `${token}.md`), 512 * 1024));
  const key = lib.slug(token);
  return {
    tickets: parsed.tickets.map((ticket) => ({ ...ticket, repo: key })),
    gaps: parsed.gaps.map((gap) => ({ ...gap, repo: key })),
  };
}

function idsInText(text) {
  return [...String(text || '').matchAll(/^##\s+([A-Za-z]+-\d+):/gm)].map((match) => match[1]);
}

function renderSection(ticket) {
  const context = String(ticket.context).split(/\r?\n/);
  const lines = [
    `## ${ticket.id}: ${ticket.title}`,
    `- status: ${ticket.status}`,
    `- pri: ${ticket.pri}`,
    `- route: ${ticket.route}`,
    `- deps: ${ticket.deps}`,
    `- source: ${ticket.source}`,
    `- filed: ${ticket.filed}`,
    `- falsifier: ${ticket.falsifier}`,
    `- cheapest-test: ${ticket['cheapest-test']}`,
    `- links: ${ticket.links}`,
    `- context: ${context.shift()}`,
    ...context.map((line) => `  ${line}`),
  ];
  return lines.join('\n') + '\n';
}

function addTicket(home, options, now, seams = {}) {
  const repo = validateRepoToken(options && options.repo);
  const type = String(options.type || '');
  const requestedId = String(options.id || '');
  const title = String(options.title || '').trim();
  const hasType = options && options.type !== undefined;
  const hasId = options && options.id !== undefined;
  if (hasType === hasId) throw new Error('add requires exactly one of --type or --id');
  if (hasType && !/^[A-Z]+$/.test(type)) throw new Error('--type must contain uppercase letters only');
  if (hasId && !/^[A-Za-z]+-\d+$/.test(requestedId)) throw new Error('--id must match [A-Za-z]+-\\d+');
  if (!title || /[\r\n]/.test(title)) throw new Error('--title must be a non-empty single line');
  const nowMs = clockMs(now);
  const file = path.join(home, 'backlog', `${repo}.md`);
  let initial = '';
  try { initial = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let id = requestedId;
  if (hasType) {
    const numbers = idsInText(initial).map((existingId) => {
      const match = existingId.match(/^([A-Za-z]+)-(\d+)$/);
      return match && match[1].toUpperCase() === type ? Number(match[2]) : null;
    }).filter((number) => number !== null);
    const next = numbers.length ? Math.max(...numbers) + 1 : 1;
    id = `${type}-${String(next).padStart(3, '0')}`;
  }
  const ticket = {
    id,
    title,
    status: 'open',
    pri: options.pri,
    route: options.route,
    deps: options.deps === undefined ? '-' : options.deps,
    source: options.source === undefined ? 'hand' : options.source,
    filed: options.filed === undefined ? new Date(nowMs).toISOString().slice(0, 10) : options.filed,
    falsifier: options.falsifier === undefined ? '-' : options.falsifier,
    'cheapest-test': options['cheapest-test'] === undefined ? '-' : options['cheapest-test'],
    links: options.links === undefined ? '-' : options.links,
    context: String(options.context || '').trim(),
    repo: lib.slug(repo),
  };
  const errors = validate([ticket]);
  if (errors.length) throw new Error(errors.join('; '));
  for (const field of ['pri', 'route', 'deps', 'source', 'filed', 'falsifier', 'cheapest-test', 'links']) {
    if (/[\r\n]/.test(String(ticket[field]))) throw new Error(`${field} must be a single line`);
  }
  const text = renderSection(ticket);
  const roundTrip = parse(text);
  const roundTripErrors = validate(roundTrip.tickets);
  if (roundTrip.gaps.length || roundTripErrors.length || roundTrip.tickets.length !== 1) {
    throw new Error(`refusing to write an invalid ticket: ${roundTripErrors.join('; ') || 'section did not parse'}`);
  }

  if (typeof seams.beforeWrite === 'function') seams.beforeWrite({ file, id, text });
  let current = '';
  let exists = true;
  try { current = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    exists = false;
  }
  if (idsInText(current).some((existing) => existing.toUpperCase() === id.toUpperCase())) {
    throw new Error(`${id} was taken before write; re-run add`);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = current
    ? `${current.endsWith('\n') ? '' : '\n'}\n`
    : `# Backlog — ${repo}\n\n`;
  if (exists) fs.appendFileSync(file, prefix + text);
  else {
    try { fs.writeFileSync(file, prefix + text, { flag: 'wx' }); }
    catch (e) {
      if (e.code === 'EEXIST') throw new Error(`${id} may have been taken before write; re-run add`);
      throw e;
    }
  }
  return { file, ticket };
}

function gapErrors(gaps) {
  return gaps.map((gap) => {
    const name = gap.id || gap.heading || '(unknown section)';
    return `${gap.repo ? `${gap.repo} ` : ''}${name}: ${gap.reason}`;
  });
}

function renderList(parsed) {
  const lines = parsed.tickets.length
    ? parsed.tickets.map((ticket) => `${ticket.repo || '-'}  ${ticket.id}  ${ticket.pri}  ${ticket.status}  ${ticket.title}`)
    : ['no tickets'];
  for (const gap of parsed.gaps) lines.push(`gap: ${gap.repo || '-'} ${gap.id || gap.heading || '(unknown)'} — ${gap.reason}`);
  return lines.join('\n') + '\n';
}

function renderRanked(result) {
  const lines = ['Ranked'];
  if (!result.ranked.length) lines.push('- none');
  for (const ticket of result.ranked) lines.push(`- ${ticket.repo || '-'} ${ticket.id} ${ticket.pri} ${ticket.title} — ${ticket.reason}`);
  lines.push('', 'Blocked');
  if (!result.blocked.length) lines.push('- none');
  for (const ticket of result.blocked) lines.push(`- ${ticket.repo || '-'} ${ticket.id} — ${ticket.reason}`);
  lines.push('', 'Gaps');
  if (!result.gaps.length) lines.push('- none');
  for (const gap of result.gaps) lines.push(`- ${gap.repo || '-'} ${gap.id || gap.heading || '(unknown)'} — ${gap.reason}`);
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const home = lib.resolveHome(process.cwd());
    if (args.command === 'add') {
      const result = addTicket(home, args, Date.now());
      if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      else process.stdout.write(`Filed ${result.ticket.id} in ${path.relative(home, result.file)}.\n`);
    } else {
      const parsed = readBacklog(home, args.repo);
      if (args.command === 'list') {
        if (args.json) process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
        else process.stdout.write(renderList(parsed));
      } else if (args.command === 'rank') {
        const backlogRoot = require('./locate.js').locate('rstaff-backlog');
        const state = backlogRoot ? require(path.join(backlogRoot, 'scripts', 'lib-state.js')) : null;
        const ranked = rank(parsed.tickets, {
          dispatch: state ? state.collectDispatch(home).filter((d) => d.live !== false)
            .map((d) => ({ ...d, repo: lib.slug(d.repo) })) : [],
          repos: [], ghAvailable: false,
        }, args.now === undefined ? Date.now() : args.now);
        ranked.gaps = [...parsed.gaps, ...ranked.gaps];
        if (args.json) process.stdout.write(JSON.stringify(ranked, null, 2) + '\n');
        else process.stdout.write(renderRanked(ranked));
      } else {
        const errors = [...gapErrors(parsed.gaps), ...validate(parsed.tickets)];
        if (args.json) process.stdout.write(JSON.stringify({ errors }, null, 2) + '\n');
        else if (errors.length) process.stdout.write(errors.join('\n') + '\n');
        if (errors.length) process.exit(1);
      }
    }
  } catch (e) {
    process.stderr.write(`lib-backlog: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  parse, parseDir, validate, rank, parseArgs, readBacklog, renderSection, addTicket,
  renderList, renderRanked,
};
