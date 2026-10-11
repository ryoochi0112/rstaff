// lib-backlog parser and validator tests — node:test, zero deps.
// Fixtures mirror the human summary + greppable ticket-section format.
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const CORE = process.env.RSTAFF_CORE_ROOT || path.resolve(__dirname, '../../plugins/rstaff');
const B = require(path.join(CORE, 'scripts', 'lib-backlog.js'));
const BACKLOG_CLI = path.join(CORE, 'scripts', 'lib-backlog.js');

function isolatedEnv(home) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-claude-config-'));
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-user-home-'));
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    HOME: userHome,
    USERPROFILE: userHome,
    RSTAFF_HOME: home,
  };
}

function section(id, overrides) {
  const v = {
    title: `Ticket ${id}`,
    status: 'open',
    pri: 'P1',
    route: 'plan',
    deps: '-',
    source: 'hand',
    filed: '2026-07-25',
    falsifier: '-',
    'cheapest-test': '-',
    links: '-',
    context: 'Useful context.',
    ...overrides,
  };
  return `## ${id}: ${v.title}\n- status: ${v.status}\n- pri: ${v.pri}\n- route: ${v.route}\n- deps: ${v.deps}\n- source: ${v.source}\n- filed: ${v.filed}\n- falsifier: ${v.falsifier}\n- cheapest-test: ${v['cheapest-test']}\n- links: ${v.links}\n- context: ${v.context}\n`;
}

function valid(overrides) {
  return {
    id: 'FAKE-002',
    title: 'A valid ticket',
    status: 'open',
    pri: 'P1',
    route: 'plan',
    deps: '-',
    source: 'hand',
    filed: '2026-07-25',
    falsifier: '-',
    'cheapest-test': '-',
    links: '-',
    context: 'Useful context.',
    ...overrides,
  };
}

test('parse reads every field from two ticket sections, not the summary table', () => {
  const text = `# Backlog — example-co\nupdated: now\n\n| id | title | pri | status | route | deps |\n|---|---|---|---|---|---|\n| FAKE-999 | Human-only row | P0 | open | build | - |\n\n${section('FAKE-002', { title: 'Nested args', pri: 'P0', links: 'spec:var/specs/nested.md' })}\n${section('DEMO-004', { title: 'Bulk fetch', status: 'blocked', route: 'experiment', deps: 'FAKE-002', source: 'interview', filed: '2026-07-28', falsifier: 'fewer than 20% improve', 'cheapest-test': 'replay 30 requests', links: 'experiment:var/experiments/bulk.md', context: 'The example-co loops.' })}`;
  const parsed = B.parse(text);
  assert.equal(parsed.gaps.length, 0);
  assert.equal(parsed.tickets.length, 2);
  assert.deepEqual(parsed.tickets[0], {
    id: 'FAKE-002', title: 'Nested args', status: 'open', pri: 'P0', route: 'plan', deps: '-', source: 'hand', filed: '2026-07-25', falsifier: '-', 'cheapest-test': '-', links: 'spec:var/specs/nested.md', context: 'Useful context.',
  });
  assert.deepEqual(parsed.tickets[1], {
    id: 'DEMO-004', title: 'Bulk fetch', status: 'blocked', pri: 'P1', route: 'experiment', deps: 'FAKE-002', source: 'interview', filed: '2026-07-28', falsifier: 'fewer than 20% improve', 'cheapest-test': 'replay 30 requests', links: 'experiment:var/experiments/bulk.md', context: 'The example-co loops.',
  });
  assert.ok(!parsed.tickets.some((t) => t.id === 'FAKE-999'));
});

test('parse preserves context continuation lines', () => {
  const parsed = B.parse(section('BUG-003', { context: 'First line\n  second line\n  third line' }));
  assert.equal(parsed.tickets[0].context, 'First line\nsecond line\nthird line');
});

test('parse names a malformed section and continues with the rest', () => {
  const malformed = section('DEMO-009').replace('- context: Useful context.\n', '');
  const parsed = B.parse(`${section('FAKE-001')}\n${malformed}\n## whatever\n- context: nope\n\n${section('DEMO-010')}`);
  assert.deepEqual(parsed.tickets.map((t) => t.id), ['FAKE-001', 'DEMO-010']);
  assert.deepEqual(parsed.gaps, [
    { id: 'DEMO-009', reason: 'missing required field: context' },
    { id: null, heading: '## whatever', reason: 'unparseable heading' },
  ]);
});

test('parse accepts ids beyond three digits without loosening malformed headings', () => {
  const parsed = B.parse(`${section('DEMO-1000')}\n${section('DEMO_1001')}\n${section('DEMO-12x')}\n## DEMO-: Missing number\n- context: nope\n`);
  assert.deepEqual(parsed.tickets.map((ticket) => ticket.id), ['DEMO-1000']);
  assert.deepEqual(parsed.gaps, [
    { id: null, heading: '## DEMO_1001: Ticket DEMO_1001', reason: 'unparseable heading' },
    { id: 'DEMO-12', heading: '## DEMO-12x: Ticket DEMO-12x', reason: 'unparseable heading' },
    { id: null, heading: '## DEMO-: Missing number', reason: 'unparseable heading' },
  ]);
});

test('parse handles empty and header-only files without throwing', () => {
  assert.deepEqual(B.parse(''), { tickets: [], gaps: [] });
  assert.deepEqual(B.parse('# Backlog — empty\nupdated: 2026-08-02T09:00:00Z by hand\n'), { tickets: [], gaps: [] });
});

test('parseDir tolerates a missing directory and tags tickets across files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-'));
  assert.deepEqual(B.parseDir(home), { tickets: [], gaps: [] });
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'repo-one.md'), section('BUG-001'));
  fs.writeFileSync(path.join(home, 'backlog', 'repo-two.md'), section('DEMO-001'));
  const parsed = B.parseDir(home);
  assert.deepEqual(parsed.tickets.map((t) => [t.id, t.repo]), [['BUG-001', 'repo-one'], ['DEMO-001', 'repo-two']]);
  assert.equal(parsed.gaps.length, 0);
});

test('validate accepts every allowed enum value', () => {
  const tickets = [];
  for (const status of ['open', 'in-progress', 'blocked', 'done', 'wontfix']) tickets.push(valid({ id: `BUG-10${tickets.length}`, status }));
  for (const pri of ['P0', 'P1', 'P2']) tickets.push(valid({ id: `BUG-10${tickets.length}`, pri }));
  for (const route of ['spec', 'plan', 'experiment', 'build', 'none']) tickets.push(valid({ id: `BUG-10${tickets.length}`, route }));
  tickets.push(valid({ id: 'BUG-113', source: 'interview', falsifier: 'no improvement', 'cheapest-test': 'replay ten cases' }));
  assert.deepEqual(B.validate(tickets), []);
});

test('validate rejects each invalid enum and names the ticket', () => {
  for (const [field, value] of [['status', 'pending'], ['pri', 'P3'], ['route', 'ship'], ['source', 'model']]) {
    const errors = B.validate([valid({ [field]: value })]);
    assert.ok(errors.some((e) => e.includes(`FAKE-002: invalid ${field}`)), `${field} is enforced`);
  }
});

test('validate rejects empty context and invalid or impossible filed dates', () => {
  assert.ok(B.validate([valid({ context: '  ' })]).some((e) => e === 'FAKE-002: context must be non-empty'));
  assert.ok(B.validate([valid({ filed: 'July 25, 2026' })]).some((e) => e.includes('FAKE-002: invalid filed date')));
  assert.ok(B.validate([valid({ filed: '2026-02-30' })]).some((e) => e.includes('FAKE-002: invalid filed date')));
  assert.deepEqual(B.validate([valid({ filed: '2024-02-29' })]), []);
});

test('validate requires both interview evidence fields in both directions', () => {
  const noTest = B.validate([valid({ source: 'interview', falsifier: 'no improvement', 'cheapest-test': '-' })]);
  assert.ok(noTest.some((e) => e === 'FAKE-002: interview source requires cheapest-test'));
  assert.ok(!noTest.some((e) => e.includes('requires falsifier')));
  const noFalsifier = B.validate([valid({ source: 'interview', falsifier: '-', 'cheapest-test': 'replay ten cases' })]);
  assert.ok(noFalsifier.some((e) => e === 'FAKE-002: interview source requires falsifier'));
  assert.ok(!noFalsifier.some((e) => e.includes('requires cheapest-test')));
  assert.deepEqual(B.validate([valid({ source: 'interview', falsifier: 'no improvement', 'cheapest-test': 'replay ten cases' })]), []);
});

test('validate reports duplicate ids within one repo but permits them across repos', () => {
  const parsed = B.parse(`${section('FAKE-002')}\n${section('FAKE-002', { title: 'Duplicate' })}`);
  const sameFile = B.validate(parsed.tickets);
  assert.ok(sameFile.some((e) => e.includes('FAKE-002: duplicate id within repo')));
  const sameRepo = B.validate([valid({ repo: 'alpha' }), valid({ repo: 'alpha', title: 'Duplicate' })]);
  assert.ok(sameRepo.some((e) => e.includes('FAKE-002: duplicate id within repo alpha')));
  assert.deepEqual(B.validate([valid({ repo: 'alpha' }), valid({ repo: 'beta' })]), []);
});

const NOW = '2026-08-02T12:00:00Z';

test('rank applies all six first-match precedence rules with exact reasons', () => {
  const tickets = [
    valid({ id: 'WORK-006', repo: 'zeta', pri: 'P2', filed: '2026-07-20' }),
    valid({ id: 'AAA-005', repo: 'theta', pri: 'P1' }),
    valid({ id: 'ZZZ-004', repo: 'delta', pri: 'P1' }),
    valid({ id: 'WORK-005', repo: 'epsilon', pri: 'P1' }),
    valid({ id: 'WORK-003', repo: 'gamma', pri: 'P1' }),
    valid({ id: 'WAIT-003', repo: 'gamma', status: 'blocked', deps: 'WORK-003' }),
    valid({ id: 'WORK-002', repo: 'beta', pri: 'P0' }),
    valid({ id: 'WAIT-002', repo: 'beta', status: 'blocked', deps: 'WORK-002' }),
    valid({ id: 'WORK-001', repo: 'alpha', pri: 'P0', links: 'spec:x, dispatch:run-one' }),
    valid({ id: 'WORK-007', repo: 'eta', pri: 'P2', filed: 'soon' }),
  ];
  const truth = {
    ghAvailable: true,
    dispatch: [{ repo: 'alpha', slug: 'run-one', state: 'needs_human', next: 'approve launch' }],
    repos: [
      { slug: 'alpha', branch: 'alpha-main', ci: { conclusion: 'failure' } },
      { slug: 'beta', branch: 'beta-main', ci: { conclusion: 'failure' } },
      { slug: 'gamma', branch: 'main', ci: { conclusion: 'failure' } },
      { slug: 'delta', branch: 'release', ci: { conclusion: 'timed_out' } },
      { slug: 'epsilon', branch: 'epsilon-main', ci: { conclusion: 'failure' } },
    ],
  };
  const out = B.rank(tickets, truth, NOW);
  assert.deepEqual(out.ranked.map((t) => [t.id, t.reason]), [
    ['WORK-001', 'dispatch run-one at needs_human — approve launch'],
    ['WORK-002', 'unblocked P0'],
    ['WORK-003', 'blocks 1 ticket(s): WAIT-003'],
    ['WORK-005', 'red CI on epsilon-main'],
    ['ZZZ-004', 'red CI on release'],
    ['AAA-005', 'unblocked P1'],
    ['WORK-006', 'oldest unblocked (filed 13d ago)'],
    ['WORK-007', 'oldest unblocked (filed date unknown)'],
  ]);
  assert.ok(out.ranked.length > 0);
  assert.ok(out.ranked.every((ticket) => typeof ticket.reason === 'string' && ticket.reason.length > 0));
});

test('rank ties break by oldest filed then id', () => {
  const out = B.rank([
    valid({ id: 'TIE-003', filed: '2026-07-25' }),
    valid({ id: 'TIE-002', filed: '2026-07-20' }),
    valid({ id: 'TIE-001', filed: '2026-07-20' }),
  ], {}, NOW);
  assert.deepEqual(out.ranked.map((t) => t.id), ['TIE-001', 'TIE-002', 'TIE-003']);
});

test('rank ready-gate is repo-scoped and fails closed on unmet and missing deps', () => {
  const out = B.rank([
    valid({ id: 'DEP-001', repo: 'alpha', status: 'done' }),
    valid({ id: 'DEP-001', repo: 'beta', status: 'open' }),
    valid({ id: 'READY-001', repo: 'alpha', deps: 'DEP-001' }),
    valid({ id: 'BLOCK-001', repo: 'beta', deps: 'DEP-001, LOST-009' }),
    valid({ id: 'BARE-001', status: 'done' }),
    valid({ id: 'BARE-002', deps: 'BARE-001' }),
  ], {}, NOW);
  assert.deepEqual(new Set(out.ranked.map((t) => t.id)), new Set(['DEP-001', 'READY-001', 'BARE-002']));
  assert.deepEqual(out.blocked.map((t) => [t.id, t.repo, t.reason]), [
    ['BLOCK-001', 'beta', 'waiting on DEP-001, LOST-009'],
  ]);
  assert.ok(!out.ranked.some((t) => t.id === 'BLOCK-001'));
});

test('rank ready-gate releases only dependencies whose status is done', () => {
  const statuses = ['open', 'in-progress', 'blocked', 'wontfix', 'done'];
  assert.ok(statuses.length > 0);
  for (const status of statuses) {
    const out = B.rank([
      valid({ id: 'DEP-001', status }),
      valid({ id: 'WORK-001', deps: 'DEP-001' }),
    ], {}, NOW);
    if (status === 'done') {
      assert.deepEqual(out.ranked.map((ticket) => ticket.id), ['WORK-001'], status);
      assert.deepEqual(out.blocked, [], status);
    } else {
      assert.ok(!out.ranked.some((ticket) => ticket.id === 'WORK-001'), status);
      assert.deepEqual(out.blocked.map((ticket) => [ticket.id, ticket.reason]), [
        ['WORK-001', 'waiting on DEP-001'],
      ], status);
    }
  }
});

test('rank detects every cycle member and gives each a closed path', () => {
  const out = B.rank([
    valid({ id: 'CYC-001', deps: 'CYC-002' }),
    valid({ id: 'CYC-002', deps: 'CYC-001' }),
    valid({ id: 'FREE-001', pri: 'P2' }),
  ], {}, NOW);
  assert.deepEqual(out.ranked.map((t) => t.id), ['FREE-001']);
  assert.deepEqual(out.blocked.map((t) => [t.id, t.reason]), [
    ['CYC-001', 'cycle: CYC-001→CYC-002→CYC-001'],
    ['CYC-002', 'cycle: CYC-002→CYC-001→CYC-002'],
  ]);
});

test('rank fan-out includes live non-open waiters but excludes done and wontfix', () => {
  const out = B.rank([
    valid({ id: 'ROOT-001', pri: 'P2' }),
    valid({ id: 'LIVE-001', status: 'in-progress', deps: 'ROOT-001 ROOT-001' }),
    valid({ id: 'LIVE-002', status: 'blocked', deps: 'ROOT-001' }),
    valid({ id: 'OLD-001', status: 'done', deps: 'ROOT-001' }),
    valid({ id: 'OLD-002', status: 'wontfix', deps: 'ROOT-001' }),
  ], {}, NOW);
  assert.deepEqual(out.ranked.map((t) => t.id), ['ROOT-001']);
  assert.equal(out.ranked[0].reason, 'blocks 2 ticket(s): LIVE-001, LIVE-002');
  assert.deepEqual(out.blocked, []);
});

test('rank fan-out dependency joins are scoped to the waiter repo', () => {
  const out = B.rank([
    valid({ id: 'ROOT-001', repo: 'alpha', pri: 'P2' }),
    valid({ id: 'ROOT-001', repo: 'beta', pri: 'P2' }),
    valid({ id: 'WAIT-001', repo: 'beta', status: 'blocked', deps: 'ROOT-001' }),
  ], {}, NOW);
  assert.deepEqual(out.ranked.map((ticket) => [ticket.repo, ticket.reason]), [
    ['beta', 'blocks 1 ticket(s): WAIT-001'],
    ['alpha', 'oldest unblocked (filed 8d ago)'],
  ]);
});

test('rank keeps the first duplicate, reports a gap, and remains total across repos', () => {
  const out = B.rank([
    valid({ id: 'DUP-001', repo: 'beta', title: 'Beta' }),
    valid({ id: 'DUP-001', repo: 'alpha', title: 'Alpha first' }),
    valid({ id: 'DUP-001', repo: 'alpha', title: 'Alpha duplicate', pri: 'P0' }),
  ], {}, NOW);
  assert.deepEqual(out.ranked.map((t) => t.title), ['Alpha first', 'Beta']);
  assert.deepEqual(out.gaps, [{
    id: 'DUP-001', repo: 'alpha', reason: 'duplicate id within repo; kept first occurrence',
  }]);
});

test('rank consumes status, pri, deps, links, and filed by observable effect', () => {
  const base = [
    valid({ id: 'A-001', repo: 'alpha', pri: 'P1', filed: '2026-07-25' }),
    valid({ id: 'B-001', repo: 'alpha', pri: 'P1', filed: '2026-07-26' }),
  ];
  assert.deepEqual(B.rank(base, {}, NOW).ranked.map((t) => t.id), ['A-001', 'B-001']);
  assert.deepEqual(B.rank([base[0], { ...base[1], pri: 'P0' }], {}, NOW).ranked.map((t) => t.id), ['B-001', 'A-001']);
  assert.deepEqual(B.rank([{ ...base[0], status: 'done' }, base[1]], {}, NOW).ranked.map((t) => t.id), ['B-001']);
  const depOut = B.rank([base[0], { ...base[1], deps: 'MISSING-001' }], {}, NOW);
  assert.deepEqual(depOut.ranked.map((t) => t.id), ['A-001']);
  assert.equal(depOut.blocked[0].id, 'B-001');
  const linked = B.rank(base, {
    ghAvailable: true,
    dispatch: [{ repo: 'alpha', slug: 'parked', state: 'needs_human', next: 'none' }],
    repos: [],
  }, NOW);
  assert.deepEqual(B.rank([base[0], { ...base[1], links: 'dispatch:parked' }], {
    ghAvailable: true,
    dispatch: [{ repo: 'alpha', slug: 'parked', state: 'needs_human', next: 'none' }],
    repos: [],
  }, NOW).ranked.map((t) => [t.id, t.reason]), [
    ['B-001', 'dispatch parked at needs_human — review parked tasks'],
    ['A-001', 'unblocked P1'],
  ]);
  assert.deepEqual(linked.ranked.map((t) => t.id), ['A-001', 'B-001']);
  assert.deepEqual(B.rank([{ ...base[0], filed: '2026-07-27' }, base[1]], {}, NOW).ranked.map((t) => t.id), ['B-001', 'A-001']);
});

test('rank ignores route and type prefix as ranking gates', () => {
  const tickets = [
    valid({ id: 'ZZZ-001', title: 'High', pri: 'P0', route: 'none' }),
    valid({ id: 'AAA-002', title: 'Low', pri: 'P1', route: 'build' }),
  ];
  const before = B.rank(tickets, {}, NOW).ranked.map((t) => t.title);
  const routeFlipped = B.rank(tickets.map((t) => ({ ...t, route: t.route === 'none' ? 'build' : 'none' })), {}, NOW)
    .ranked.map((t) => t.title);
  const prefixesFlipped = B.rank([
    { ...tickets[0], id: 'AAA-001' },
    { ...tickets[1], id: 'ZZZ-002' },
  ], {}, NOW).ranked.map((t) => t.title);
  assert.deepEqual(before, ['High', 'Low']);
  assert.deepEqual(routeFlipped, before);
  assert.deepEqual(prefixesFlipped, before);
});

test('rank dispatch remains local without gh while CI fails closed', () => {
  const dispatchTicket = valid({ id: 'SIG-001', repo: 'profile-token', pri: 'P2', links: 'dispatch:run' });
  const ciTicket = valid({ id: 'SIG-002', repo: 'profile-token', pri: 'P2' });
  const truth = {
    dispatch: [{ repo: 'profile-token', slug: 'run', state: 'needs_human', next: '' }],
    repos: [{ slug: 'profile-token', branch: 'main', ci: { conclusion: 'failure' } }],
  };
  assert.match(B.rank([dispatchTicket], undefined, NOW).ranked[0].reason, /^oldest unblocked/);
  assert.equal(B.rank([dispatchTicket], truth, NOW).ranked[0].reason,
    'dispatch run at needs_human — review parked tasks');
  assert.equal(B.rank([dispatchTicket], { ...truth, ghAvailable: false }, NOW).ranked[0].reason,
    'dispatch run at needs_human — review parked tasks');
  assert.equal(B.rank([dispatchTicket], { dispatch: truth.dispatch }, NOW).ranked[0].reason,
    'dispatch run at needs_human — review parked tasks');
  assert.equal(B.rank([dispatchTicket], { ghAvailable: true, dispatch: truth.dispatch }, NOW).ranked[0].reason,
    'dispatch run at needs_human — review parked tasks');
  assert.match(B.rank([ciTicket], { ...truth, ghAvailable: false }, NOW).ranked[0].reason,
    /^oldest unblocked/);
  assert.equal(B.rank([ciTicket], { ghAvailable: true, repos: truth.repos }, NOW).ranked[0].reason,
    'red CI on main');
});

test('rank dispatch and CI signals require every keyed join predicate', () => {
  const dispatchTicket = valid({ id: 'JOIN-001', repo: 'profile-token', pri: 'P2', links: 'dispatch:run' });
  const dispatchBase = {
    ghAvailable: true,
    repos: [],
    dispatch: [{ repo: 'profile-token', slug: 'run', state: 'needs_human', next: 'act' }],
  };
  assert.equal(B.rank([dispatchTicket], dispatchBase, NOW).ranked[0].reason,
    'dispatch run at needs_human — act');
  assert.equal(B.rank([dispatchTicket], {
    ...dispatchBase,
    dispatch: [{ ...dispatchBase.dispatch[0], state: 'needs_human (blocked on operator input)' }],
  }, NOW).ranked[0].reason, 'dispatch run at needs_human — act');
  assert.equal(B.rank([dispatchTicket], {
    ...dispatchBase,
    dispatch: [{ ...dispatchBase.dispatch[0], state: 'needs_human: waiting on operator input' }],
  }, NOW).ranked[0].reason, 'dispatch run at needs_human — act');
  for (const dispatch of [
    [{ ...dispatchBase.dispatch[0], repo: 'owner/name' }],
    [{ ...dispatchBase.dispatch[0], slug: 'other' }],
    [{ ...dispatchBase.dispatch[0], state: 'running' }],
    [{ ...dispatchBase.dispatch[0], state: 'not_needs_human' }],
    [{ ...dispatchBase.dispatch[0], state: 'needs_humanoid' }],
  ]) {
    assert.match(B.rank([dispatchTicket], { ...dispatchBase, dispatch }, NOW).ranked[0].reason,
      /^oldest unblocked/);
  }
  assert.match(B.rank([{ ...dispatchTicket, links: 'run' }], dispatchBase, NOW).ranked[0].reason,
    /^oldest unblocked/);
  assert.match(B.rank([{ ...dispatchTicket, links: 'spec:x/dispatch:run' }], dispatchBase, NOW).ranked[0].reason,
    /^oldest unblocked/);

  const ciTicket = valid({ id: 'JOIN-002', repo: 'profile-token', pri: 'P2' });
  const ciBase = {
    ghAvailable: true,
    dispatch: [],
    repos: [{ slug: 'profile-token', branch: 'main', ci: { conclusion: 'action_required' } }],
  };
  assert.equal(B.rank([ciTicket], ciBase, NOW).ranked[0].reason, 'red CI on main');
  for (const repos of [
    [{ ...ciBase.repos[0], slug: 'owner/name' }],
    [{ ...ciBase.repos[0], ci: { conclusion: 'success' } }],
    [{ ...ciBase.repos[0], ci: null }],
  ]) {
    assert.match(B.rank([ciTicket], { ...ciBase, repos }, NOW).ranked[0].reason,
      /^oldest unblocked/);
  }
});

test('rank finds dispatch links at every position under both supported separators', () => {
  const truth = {
    dispatch: [{ repo: 'profile-token', slug: 'run', state: 'needs_human', next: 'approve launch' }],
  };
  const fixtures = [
    [', first', 'dispatch:run, spec:x, experiment:y'],
    [', middle', 'spec:x, dispatch:run, experiment:y'],
    [', last', 'spec:x, experiment:y, dispatch:run'],
    ['; first', 'dispatch:run; spec:x; experiment:y'],
    ['; middle', 'spec:x; dispatch:run; experiment:y'],
    ['; last', 'spec:x; experiment:y; dispatch:run'],
    ['mixed separators', 'spec:x; dispatch:run, experiment:y'],
  ];
  for (const [label, links] of fixtures) {
    const ticket = valid({ id: 'LINK-001', repo: 'profile-token', pri: 'P2', links });
    assert.equal(B.rank([ticket], truth, NOW).ranked[0].reason,
      'dispatch run at needs_human — approve launch', label);
  }
});

test('rank parses every real dependency id under both supported separators', () => {
  for (const [label, deps] of [
    ['comma', 'FAKE-001, FAKE-002'],
    ['semicolon', 'FAKE-001; FAKE-002'],
    ['leading', '; FAKE-001; FAKE-002'],
    ['trailing', 'FAKE-001; FAKE-002;'],
    ['doubled', 'FAKE-001;; FAKE-002'],
    ['leading comma', ', FAKE-001, FAKE-002'],
  ]) {
    const ticket = valid({ id: 'WORK-001', deps });
    const out = B.rank([ticket], {}, NOW);
    assert.equal(out.blocked[0].reason, 'waiting on FAKE-001, FAKE-002', label);
    assert.ok(!out.blocked[0].reason.includes('FAKE-001;'), `${label}: no phantom dependency`);
    assert.ok(!/waiting on ,|, ,|, $/.test(out.blocked[0].reason),
      `${label}: no empty dependency`);
  }
});

test('rank uses exactly the cockpit red-CI conclusion set', () => {
  const bad = ['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required'];
  assert.ok(bad.length > 0);
  const ticket = valid({ id: 'CI-001', repo: 'alpha', pri: 'P2' });
  for (const conclusion of bad) {
    const out = B.rank([ticket], {
      ghAvailable: true,
      dispatch: [],
      repos: [{ slug: 'alpha', branch: 'main', ci: { conclusion } }],
    }, NOW);
    assert.equal(out.ranked[0].reason, 'red CI on main', conclusion);
  }
  for (const conclusion of ['success', 'neutral', 'skipped', '']) {
    const out = B.rank([ticket], {
      ghAvailable: true,
      dispatch: [],
      repos: [{ slug: 'alpha', branch: 'main', ci: { conclusion } }],
    }, NOW);
    assert.match(out.ranked[0].reason, /^oldest unblocked/, conclusion || '(empty)');
  }
});

test('rank is deterministic for an injected clock and changes when the clock moves', () => {
  const tickets = [valid({ id: 'AGE-001', pri: 'P2', filed: '2026-07-30' })];
  const first = JSON.stringify(B.rank(tickets, {}, '2026-08-02T12:00:00Z'));
  const repeat = JSON.stringify(B.rank(tickets, {}, '2026-08-02T12:00:00Z'));
  const moved = JSON.stringify(B.rank(tickets, {}, '2026-08-05T12:00:00Z'));
  assert.equal(repeat, first);
  assert.notEqual(moved, first);
  assert.match(moved, /filed 6d ago/);
  assert.match(JSON.stringify(B.rank(tickets, {}, '2026-07-01T00:00:00Z')), /filed 0d ago/);
});

test('rank requires a parseable injected now string or epoch-ms number', () => {
  assert.throws(() => B.rank([], {}, undefined), /now parameter/);
  assert.throws(() => B.rank([], {}, 'not-a-date'), /now parameter/);
  const tickets = [valid({ id: 'CLOCK-001', pri: 'P2', filed: '2026-07-30' })];
  assert.deepEqual(B.rank(tickets, {}, Date.parse(NOW)), B.rank(tickets, {}, NOW));
  assert.equal(B.rank(tickets, {}, Date.parse(NOW)).ranked[0].reason,
    'oldest unblocked (filed 3d ago)');
});

test('rank sorts an unparseable filed date last regardless of input order', () => {
  const badFiled = valid({ id: 'BAD-002', pri: 'P2', filed: 'soon' });
  const goodFiled = valid({ id: 'GOOD-001', pri: 'P2', filed: '2026-07-30' });
  assert.deepEqual(B.rank([badFiled, goodFiled], {}, NOW).ranked.map((ticket) => ticket.id), [
    'GOOD-001',
    'BAD-002',
  ]);
});

test('parseArgs accepts each CLI shape and rejects bad now and missing add values', () => {
  assert.deepEqual(B.parseArgs(['list', '--repo', 'alpha', '--json']), {
    command: 'list', repo: 'alpha', json: true,
  });
  assert.deepEqual(B.parseArgs(['rank', '--now', NOW]), {
    command: 'rank', now: NOW, json: false,
  });
  assert.deepEqual(B.parseArgs([
    'add', '--repo', 'alpha', '--type', 'BUG', '--title', 'Fix it', '--pri', 'P0',
    '--route', 'build', '--context', 'Enough to act cold.',
  ]), {
    command: 'add', repo: 'alpha', type: 'BUG', title: 'Fix it', pri: 'P0',
    route: 'build', context: 'Enough to act cold.', json: false,
  });
  assert.deepEqual(B.parseArgs([
    'add', '--repo', 'alpha', '--id', 'DEMO-003', '--title', 'Migrate it', '--pri', 'P1',
    '--route', 'experiment', '--context', 'Preserve this id.',
  ]), {
    command: 'add', repo: 'alpha', id: 'DEMO-003', title: 'Migrate it', pri: 'P1',
    route: 'experiment', context: 'Preserve this id.', json: false,
  });
  assert.equal(B.parseArgs([
    'add', '--repo', 'alpha', '--id', 'demo-003', '--title', 'Lowercase id', '--pri', 'P1',
    '--route', 'experiment', '--context', 'Parser shape permits lowercase letters.',
  ]).id, 'demo-003');
  assert.deepEqual(B.parseArgs(['validate', '--json']), { command: 'validate', json: true });
  assert.throws(() => B.parseArgs(['rank', '--now', 'never']), /--now/);
  assert.throws(() => B.parseArgs([
    'add', '--repo', 'alpha', '--title', 'No id source', '--pri', 'P1', '--route', 'plan',
    '--context', 'Enough context.',
  ]), /exactly one of --type or --id/);
  assert.throws(() => B.parseArgs([
    'add', '--repo', 'alpha', '--type', 'DEMO', '--id', 'DEMO-003', '--title', 'Two id sources',
    '--pri', 'P1', '--route', 'plan', '--context', 'Enough context.',
  ]), /exactly one of --type or --id/);
  for (const id of ['demo3', 'DEMO-', '123', 'DEMO_-003']) {
    assert.throws(() => B.parseArgs([
      'add', '--repo', 'alpha', '--id', id, '--title', 'Malformed id', '--pri', 'P1',
      '--route', 'plan', '--context', 'Enough context.',
    ]), /--id must match/);
  }
  assert.throws(() => B.parseArgs(['list', '--repo', '../escape']), /profile-filename token/);
  assert.throws(() => B.parseArgs(['list', '--now', NOW]), /does not accept --now/);
  assert.throws(() => B.parseArgs(['unknown']), /command must be one of/);
  assert.throws(() => B.parseArgs(['list', '--repo', 'alpha', '--repo', 'beta']), /--repo may only be specified once/);
  assert.throws(() => B.parseArgs([
    'add', '--repo', 'alpha', '--type', 'BUG', '--title', 'First line\nSecond line',
    '--pri', 'P1', '--route', 'build', '--context', 'Enough context.',
  ]), /--title must be a single line/);
});

test('readBacklog --repo selection filters to one file and preserves its repo key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-filter-'));
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'), section('BUG-001'));
  fs.writeFileSync(path.join(home, 'backlog', 'beta.md'), section('BUG-002'));
  assert.deepEqual(B.readBacklog(home, 'beta').tickets.map((ticket) => [ticket.id, ticket.repo]), [
    ['BUG-002', 'beta'],
  ]);
});

test('add assigns max plus one per prefix and file from non-monotonic input', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-add-'));
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'), [
    '# Backlog — alpha\n',
    section('DEMO-004'),
    section('FAKE-002'),
    section('DEMO-001'),
  ].join('\n'));
  const neighbourFile = path.join(home, 'backlog', 'aardvark.md');
  fs.writeFileSync(neighbourFile, `# Backlog — aardvark\n\n${section('DEMO-009')}`);
  const neighbourBefore = fs.readFileSync(neighbourFile, 'utf8');
  const base = { repo: 'alpha', title: 'New ticket', pri: 'P1', route: 'plan', context: 'Act on this.' };
  const exp = B.addTicket(home, { ...base, type: 'DEMO' }, Date.parse(NOW));
  const blk = B.addTicket(home, { ...base, type: 'FAKE' }, Date.parse(NOW));
  const bug = B.addTicket(home, { ...base, type: 'BUG' }, Date.parse(NOW));
  assert.deepEqual([exp.ticket.id, blk.ticket.id, bug.ticket.id], ['DEMO-005', 'FAKE-003', 'BUG-001']);
  assert.equal(fs.readFileSync(neighbourFile, 'utf8'), neighbourBefore);
});

test('add with an explicit migration id preserves that exact id in an empty file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-explicit-id-'));
  const result = B.addTicket(home, {
    repo: 'alpha', id: 'DEMO-003', title: 'Preserved ticket', pri: 'P1', route: 'experiment',
    context: 'The migration must not derive DEMO-001.',
  }, Date.parse(NOW));
  assert.equal(result.ticket.id, 'DEMO-003');
  const parsed = B.parse(fs.readFileSync(result.file, 'utf8'));
  assert.deepEqual(parsed.tickets.map((ticket) => ticket.id), ['DEMO-003']);
});

test('add accepts a lowercase explicit id allowed by the parser id shape', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-lowercase-id-'));
  const result = B.addTicket(home, {
    repo: 'alpha', id: 'demo-003', title: 'Lowercase prefix', pri: 'P1', route: 'experiment',
    context: 'The parser id shape permits an alphabetic lowercase prefix.',
  }, Date.parse(NOW));
  assert.equal(result.ticket.id, 'demo-003');
  assert.deepEqual(B.parse(fs.readFileSync(result.file, 'utf8')).tickets.map((ticket) => ticket.id), ['demo-003']);
});

test('add with an explicit id refuses a collision and leaves the file byte-unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-explicit-collision-'));
  const request = {
    repo: 'alpha', id: 'DEMO-003', title: 'Original ticket', pri: 'P1', route: 'experiment',
    context: 'Only one copy may land.',
  };
  const first = B.addTicket(home, request, Date.parse(NOW));
  const before = fs.readFileSync(first.file);
  assert.ok(before.length > 0);
  assert.throws(() => B.addTicket(home, {
    ...request, title: 'Duplicate ticket', context: 'This copy must be refused.',
  }, Date.parse(NOW)), /DEMO-003 was taken.*re-run/);
  assert.deepEqual(fs.readFileSync(first.file), before);
});

test('add refuses a case-variant explicit id collision and leaves the file byte-unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-case-collision-'));
  const first = B.addTicket(home, {
    repo: 'alpha', id: 'DEMO-003', title: 'Original ticket', pri: 'P1', route: 'experiment',
    context: 'Case variants must not duplicate this ticket.',
  }, Date.parse(NOW));
  const before = fs.readFileSync(first.file);
  assert.ok(before.length > 0);
  assert.throws(() => B.addTicket(home, {
    repo: 'alpha', id: 'demo-003', title: 'Case-variant duplicate', pri: 'P1', route: 'experiment',
    context: 'This copy must be refused.',
  }, Date.parse(NOW)), /demo-003 was taken.*re-run/);
  assert.deepEqual(fs.readFileSync(first.file), before);
});

test('add rejects malformed explicit ids and mutually exclusive id sources before writing', () => {
  const cases = [
    { id: 'demo3' },
    { id: 'DEMO-' },
    { id: '123' },
    { id: 'DEMO_-003' },
    { id: 'DEMO-003', type: 'DEMO' },
    {},
  ];
  assert.ok(cases.length > 0);
  for (const ids of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-invalid-id-'));
    assert.throws(() => B.addTicket(home, {
      repo: 'alpha', title: 'Invalid id request', pri: 'P1', route: 'plan',
      context: 'Nothing may be written.', ...ids,
    }, Date.parse(NOW)), /--id must match|exactly one of --type or --id/);
    assert.equal(fs.existsSync(path.join(home, 'backlog', 'alpha.md')), false);
  }
});

test('add with an explicit id still refuses context that cannot round-trip', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-explicit-roundtrip-'));
  const file = path.join(home, 'backlog', 'alpha.md');
  assert.throws(() => B.addTicket(home, {
    repo: 'alpha', id: 'DEMO-003', title: 'Must round-trip', pri: 'P1', route: 'experiment',
    context: `Before line separator${String.fromCharCode(0x2028)}after it.`,
  }, Date.parse(NOW)), /refusing to write an invalid ticket/);
  assert.equal(fs.existsSync(file), false);
});

test('add collision between scan and write fails and leaves the interleaving bytes unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-collision-'));
  const dir = path.join(home, 'backlog');
  const file = path.join(dir, 'alpha.md');
  fs.mkdirSync(dir);
  fs.writeFileSync(file, `# Backlog — alpha\n\n${section('DEMO-001')}`);
  let afterInterleaving = '';
  assert.throws(() => B.addTicket(home, {
    repo: 'alpha', type: 'DEMO', title: 'Losing writer', pri: 'P1', route: 'plan', context: 'Must not land.',
  }, Date.parse(NOW), {
    beforeWrite({ id }) {
      assert.equal(id, 'DEMO-002');
      fs.appendFileSync(file, `\n${section(id, { title: 'Winning writer' })}`);
      afterInterleaving = fs.readFileSync(file, 'utf8');
    },
  }), /DEMO-002 was taken.*re-run/);
  assert.ok(afterInterleaving.length > 0);
  assert.equal(fs.readFileSync(file, 'utf8'), afterInterleaving);
  const parsed = B.parse(afterInterleaving);
  assert.deepEqual(parsed.tickets.map((ticket) => ticket.title), ['Ticket DEMO-001', 'Winning writer']);
});

test('add emits an exact valid round-trip ticket and creates the store header', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-roundtrip-'));
  const result = B.addTicket(home, {
    repo: 'alpha', type: 'DEMO', title: 'Test the premise', pri: 'P0', route: 'experiment',
    source: 'interview', falsifier: 'No improvement', 'cheapest-test': 'Replay ten cases',
    deps: 'FAKE-002', links: 'spec:var/specs/test.md', context: 'First line\nSecond line',
  }, Date.parse('2026-08-02T23:59:00Z'));
  const written = fs.readFileSync(result.file, 'utf8');
  assert.match(written, /^# Backlog — alpha\n\n/);
  const parsed = B.parse(written);
  assert.deepEqual(parsed.gaps, []);
  assert.deepEqual(B.validate(parsed.tickets), []);
  assert.deepEqual(parsed.tickets, [{
    id: 'DEMO-001', title: 'Test the premise', status: 'open', pri: 'P0', route: 'experiment',
    deps: 'FAKE-002', source: 'interview', filed: '2026-08-02', falsifier: 'No improvement',
    'cheapest-test': 'Replay ten cases', links: 'spec:var/specs/test.md',
    context: 'First line\nSecond line',
  }]);
});

test('add treats ticket-shaped multiline context as context, not a caller-chosen section', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-injection-'));
  const injected = [
    'Real context.',
    '## X-999: Injected ticket',
    '- status: done',
    '- pri: P0',
    '- route: build',
    '- deps: -',
    '- source: hand',
    '- filed: 2026-08-02',
    '- falsifier: -',
    '- cheapest-test: -',
    '- links: -',
    '- context: Caller-controlled ticket',
  ].join('\n');
  const result = B.addTicket(home, {
    repo: 'alpha', type: 'DEMO', title: 'Requested ticket', pri: 'P2', route: 'plan',
    context: injected,
  }, Date.parse(NOW));
  const parsed = B.parse(fs.readFileSync(result.file, 'utf8'));
  assert.deepEqual(parsed.gaps, []);
  assert.equal(parsed.tickets.length, 1);
  assert.deepEqual(parsed.tickets.map((ticket) => [ticket.id, ticket.status, ticket.pri]), [
    ['DEMO-001', 'open', 'P2'],
  ]);
  assert.equal(parsed.tickets[0].context, injected);
});

test('add refuses context separators that cannot round-trip and creates no file', () => {
  const contexts = [
    'Before lone carriage return\rafter it.',
    `Before line separator${String.fromCharCode(0x2028)}after it.`,
  ];
  assert.ok(contexts.length > 0);
  for (const context of contexts) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-invalid-context-'));
    const file = path.join(home, 'backlog', 'alpha.md');
    assert.throws(() => B.addTicket(home, {
      repo: 'alpha', type: 'DEMO', title: 'Must round-trip', pri: 'P1', route: 'experiment', context,
    }, Date.parse(NOW)), /refusing to write an invalid ticket/);
    assert.equal(fs.existsSync(file), false);
  }
});

test('add reuses validation and refuses every invalid requested ticket before writing', () => {
  const cases = [
    [{ pri: 'P3' }, /invalid pri/],
    [{ route: 'ship' }, /invalid route/],
    [{ context: '  ' }, /context must be non-empty/],
    [{ source: 'interview', falsifier: '-', 'cheapest-test': 'Run it' }, /requires falsifier/],
    [{ source: 'interview', falsifier: 'No change', 'cheapest-test': '-' }, /requires cheapest-test/],
  ];
  assert.ok(cases.length > 0);
  for (const [override, pattern] of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-invalid-add-'));
    assert.throws(() => B.addTicket(home, {
      repo: 'alpha', type: 'BUG', title: 'Invalid ticket', pri: 'P1', route: 'build',
      context: 'Useful context.', ...override,
    }, Date.parse(NOW)), pattern);
    assert.equal(fs.existsSync(path.join(home, 'backlog', 'alpha.md')), false);
  }
});







test('add CLI resolves the control home when invoked from a product repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-add-'));
  const controlHome = path.join(root, 'control');
  const productHome = path.join(root, 'product');
  fs.mkdirSync(controlHome);
  fs.mkdirSync(productHome);
  fs.writeFileSync(path.join(controlHome, 'rstaff.json'), '{}\n');
  const result = spawnSync(process.execPath, [
    BACKLOG_CLI, 'add', '--repo', 'alpha', '--type', 'BUG', '--title', 'CLI ticket',
    '--pri', 'P1', '--route', 'build', '--context', 'Filed from a product repo.',
  ], {
    cwd: productHome, env: isolatedEnv(controlHome), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Filed BUG-001 in backlog\/alpha\.md\./);
  const controlFile = path.join(controlHome, 'backlog', 'alpha.md');
  assert.equal(fs.existsSync(controlFile), true);
  assert.deepEqual(B.parse(fs.readFileSync(controlFile, 'utf8')).tickets.map((ticket) => ticket.id), [
    'BUG-001',
  ]);
  assert.equal(fs.existsSync(path.join(productHome, 'backlog')), false);
});

test('add CLI preserves --id and exits one on explicit-id usage errors without writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-id-'));
  fs.writeFileSync(path.join(root, 'rstaff.json'), '{}\n');
  const env = isolatedEnv(root);
  const base = ['add', '--repo', 'alpha', '--title', 'CLI migration', '--pri', 'P1',
    '--route', 'experiment', '--context', 'Preserve the source id.'];
  const filed = spawnSync(process.execPath, [BACKLOG_CLI, ...base, '--id', 'DEMO-003'], {
    cwd: root, env, encoding: 'utf8',
  });
  assert.equal(filed.status, 0, filed.stderr);
  assert.match(filed.stdout, /^Filed DEMO-003 in backlog\/alpha\.md\./);
  assert.deepEqual(B.parse(fs.readFileSync(path.join(root, 'backlog', 'alpha.md'), 'utf8'))
    .tickets.map((ticket) => ticket.id), ['DEMO-003']);

  for (const extra of [
    ['--id', 'demo3'],
    ['--id', 'DEMO-'],
    ['--id', '123'],
    ['--id', 'DEMO-004', '--type', 'DEMO'],
  ]) {
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-bad-id-'));
    fs.writeFileSync(path.join(clean, 'rstaff.json'), '{}\n');
    const result = spawnSync(process.execPath, [BACKLOG_CLI, ...base, ...extra], {
      cwd: clean, env: isolatedEnv(clean), encoding: 'utf8',
    });
    assert.equal(result.status, 1, extra.join(' '));
    assert.equal(fs.existsSync(path.join(clean, 'backlog')), false, extra.join(' '));
  }
  const neitherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-no-id-'));
  fs.writeFileSync(path.join(neitherHome, 'rstaff.json'), '{}\n');
  const neither = spawnSync(process.execPath, [BACKLOG_CLI, ...base], {
    cwd: neitherHome, env: isolatedEnv(neitherHome), encoding: 'utf8',
  });
  assert.equal(neither.status, 1);
  assert.equal(fs.existsSync(path.join(neitherHome, 'backlog')), false);
});

test('list CLI emits the selected repo as JSON and rejects unknown commands', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-list-'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{}\n');
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'), section('BUG-001'));
  fs.writeFileSync(path.join(home, 'backlog', 'beta.md'), section('BUG-002'));
  const env = isolatedEnv(home);
  const listed = spawnSync(process.execPath, [BACKLOG_CLI, 'list', '--repo', 'beta', '--json'], {
    cwd: home, env, encoding: 'utf8',
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).tickets.map((ticket) => [ticket.repo, ticket.id]), [
    ['beta', 'BUG-002'],
  ]);
  const human = spawnSync(process.execPath, [BACKLOG_CLI, 'list', '--repo', 'beta'], {
    cwd: home, env, encoding: 'utf8',
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^beta  BUG-002  P1  open  Ticket BUG-002\n$/);
  const unknown = spawnSync(process.execPath, [BACKLOG_CLI, 'unknown'], {
    cwd: home, env, encoding: 'utf8',
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^lib-backlog: command must be one of/);
});

test('validate CLI exits non-zero on ticket or parse errors and emits structured errors', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-validate-'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{}\n');
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'), `${section('BAD-001', { pri: 'P9' })}\n## broken\n`);
  const result = spawnSync(process.execPath, [BACKLOG_CLI, 'validate', '--repo', 'alpha', '--json'], {
    cwd: home, env: isolatedEnv(home), encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const body = JSON.parse(result.stdout);
  assert.ok(body.errors.length > 0);
  assert.ok(body.errors.some((error) => error.includes('unparseable heading')));
  assert.ok(body.errors.some((error) => error.includes('BAD-001: invalid pri')));
});

test('validate CLI exits zero with empty stderr for a clean store', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-valid-'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{}\n');
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'), section('GOOD-001'));
  const result = spawnSync(process.execPath, [BACKLOG_CLI, 'validate', '--repo', 'alpha', '--json'], {
    cwd: home, env: isolatedEnv(home), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { errors: [] });
});

test('rank CLI without rstaff-backlog ranks with an empty dispatch list', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-core-rank-no-backlog-plugin-'));
  const copiedCore = path.join(fixture, 'plugins', 'rstaff');
  fs.mkdirSync(path.dirname(copiedCore), { recursive: true });
  fs.cpSync(CORE, copiedCore, { recursive: true });

  const home = path.join(fixture, 'home');
  fs.mkdirSync(path.join(home, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{}\n');
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'),
    section('HUMAN-001', { pri: 'P2', links: 'dispatch:parked' }));
  const dispatchDir = path.join(home, 'var', 'dispatch', 'alpha');
  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.writeFileSync(path.join(dispatchDir, 'parked.md'), 'state: needs_human\n');

  const result = spawnSync(process.execPath, [
    path.join(copiedCore, 'scripts', 'lib-backlog.js'),
    'rank', '--repo', 'alpha', '--now', NOW, '--json',
  ], { cwd: home, env: isolatedEnv(home), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const ticket = JSON.parse(result.stdout).ranked.find((entry) => entry.id === 'HUMAN-001');
  assert.ok(ticket, 'the ticket remains ranked without a dispatch plugin');
  assert.doesNotMatch(ticket.reason, /dispatch parked/);
});

