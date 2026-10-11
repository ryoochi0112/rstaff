// rank CLI dispatch integration tests — node:test, zero deps.
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const BACKLOG_CLI = path.join(__dirname, '..', '..', 'plugins', 'rstaff', 'scripts', 'lib-backlog.js');

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


const NOW = '2026-08-02T12:00:00Z';

test('rank CLI threads --now by effect and uses local dispatch without gh', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-rank-'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{}\n');
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'), [
    section('AGE-001', { pri: 'P2', filed: '2026-07-30' }),
    section('HUMAN-001', { pri: 'P2', links: 'dispatch:parked' }),
  ].join('\n'));
  const dispatchDir = path.join(home, 'var', 'dispatch', 'alpha');
  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.writeFileSync(path.join(dispatchDir, 'parked.md'), 'state: needs_human\nnext_human_action: approve release\n');
  const run = (now) => spawnSync(process.execPath, [BACKLOG_CLI, 'rank', '--repo', 'alpha', '--now', now, '--json'], {
    cwd: home, env: isolatedEnv(home), encoding: 'utf8',
  });
  const early = run('2026-08-02T12:00:00Z');
  const late = run('2026-08-05T12:00:00Z');
  assert.equal(early.status, 0, early.stderr);
  assert.equal(late.status, 0, late.stderr);
  const earlyOut = JSON.parse(early.stdout);
  const lateOut = JSON.parse(late.stdout);
  assert.deepEqual(earlyOut.ranked.map((ticket) => [ticket.id, ticket.reason]), [
    ['HUMAN-001', 'dispatch parked at needs_human — approve release'],
    ['AGE-001', 'oldest unblocked (filed 3d ago)'],
  ]);
  assert.equal(lateOut.ranked.find((ticket) => ticket.id === 'AGE-001').reason,
    'oldest unblocked (filed 6d ago)');
  assert.notEqual(late.stdout, early.stdout);
  const invalid = run('not-a-date');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^lib-backlog: --now must be/);
});

test('rank CLI normalizes a capitalized dispatch directory to the backlog repo key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-dispatch-case-'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{}\n');
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'Aristotle.md'),
    section('HUMAN-001', { pri: 'P2', links: 'dispatch:parked' }));
  const dispatchDir = path.join(home, 'var', 'dispatch', 'Aristotle');
  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.writeFileSync(path.join(dispatchDir, 'parked.md'),
    'state: needs_human\nnext_human_action: approve release\n');

  const run = spawnSync(process.execPath, [
    BACKLOG_CLI, 'rank', '--repo', 'Aristotle', '--now', '2026-08-02T12:00:00Z', '--json',
  ], {
    cwd: home, env: isolatedEnv(home), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.deepEqual(output.ranked.map((ticket) => [ticket.repo, ticket.id, ticket.reason]), [[
    'aristotle', 'HUMAN-001', 'dispatch parked at needs_human — approve release',
  ]]);
});

test('rank CLI normalizes a mixed-case dispatch link and status filename', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-dispatch-slug-case-'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{}\n');
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'),
    section('HUMAN-001', { pri: 'P2', links: 'dispatch:pArKeD-rUn' }));
  const dispatchDir = path.join(home, 'var', 'dispatch', 'alpha');
  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.writeFileSync(path.join(dispatchDir, 'Parked-Run.md'),
    'state: needs_human\nnext_human_action: approve release\n');

  const run = spawnSync(process.execPath, [
    BACKLOG_CLI, 'rank', '--repo', 'alpha', '--now', '2026-08-02T12:00:00Z', '--json',
  ], {
    cwd: home, env: isolatedEnv(home), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.deepEqual(output.ranked.map((ticket) => [ticket.id, ticket.reason]), [[
    'HUMAN-001', 'dispatch Parked-Run at needs_human — approve release',
  ]]);
});

// the rank CLI reads the same dispatch store as /cockpit, so it must
// apply the same staleness filter. The cockpit-side twin is pinned in
// test/cockpit-queue.test.js; this is the sibling that has been missed before.
test('rank CLI does not promote a ticket linked to a dispatch row whose branch is gone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-cli-dispatch-stale-'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{}\n');
  fs.mkdirSync(path.join(home, 'backlog'));
  fs.writeFileSync(path.join(home, 'backlog', 'alpha.md'),
    section('HUMAN-001', { pri: 'P2', links: 'dispatch:parked' }));

  // A real repo holding only `main`, so for-each-ref genuinely lacks feat/gone.
  const product = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-backlog-repo-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main', product);
  fs.writeFileSync(path.join(product, 'x'), 'x');
  git('-C', product, 'add', 'x');
  git('-C', product, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'x');
  fs.mkdirSync(path.join(home, 'profiles'));
  fs.writeFileSync(path.join(home, 'profiles', 'alpha.md'), `**Repo:** \`${product}\`\n`);

  const dispatchDir = path.join(home, 'var', 'dispatch', 'alpha');
  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.writeFileSync(path.join(dispatchDir, 'parked.md'),
    'state: needs_human\nworktree: /w    branch: feat/gone\nnext_human_action: approve release\n');

  const run = spawnSync(process.execPath, [
    BACKLOG_CLI, 'rank', '--repo', 'alpha', '--now', NOW, '--json',
  ], { cwd: home, env: isolatedEnv(home), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const ticket = JSON.parse(run.stdout).ranked.find((t) => t.id === 'HUMAN-001');
  assert.ok(ticket, 'the ticket is still ranked, just not by a dead dispatch row');
  assert.doesNotMatch(ticket.reason, /dispatch parked at needs_human/);
});
