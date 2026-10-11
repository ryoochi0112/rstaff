'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const cockpit = path.join(__dirname, '..', '..', 'plugins', 'rstaff-backlog', 'scripts', 'cockpit.js');

function isolatedEnv(home) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-claude-config-'));
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-user-home-'));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    HOME: userHome,
    USERPROFILE: userHome,
    RSTAFF_HOME: home,
  };
  return env;
}

function homeFixture({ backlog = true, ghStatus = 1 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-cockpit-'));
  fs.writeFileSync(path.join(home, 'rstaff.json'), '{}');
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'Aristotle.md'), '**Repo:** `/definitely-not-a-repo`\n');
  if (backlog) fs.mkdirSync(path.join(home, 'backlog'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-gh-'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexit ${ghStatus}\n`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const env = isolatedEnv(home);
  env.PATH = `${bin}:/usr/bin:/bin`;
  return { home, env };
}

function writeTicket(home, file, body) {
  fs.writeFileSync(path.join(home, 'backlog', file), body.trim() + '\n');
}

const ticket = (id, title, fields = '') => `## ${id}: ${title}\n- status: open\n- pri: P1\n- route: plan\n- deps: -\n- source: hand\n- filed: 2026-07-01\n- falsifier: -\n- cheapest-test: -\n- links: -\n- context: act\n${fields}`;

test('locate ignores a poisoned operator install when the isolated config dir is empty', () => {
  const f = homeFixture();
  const operatorInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-poisoned-usage-'));
  fs.mkdirSync(path.join(operatorInstall, 'scripts'));
  fs.writeFileSync(path.join(operatorInstall, 'scripts', 'usage.js'), "throw new Error('poisoned install');\n");
  const registry = path.join(f.env.HOME, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({
    plugins: { 'rstaff-usage@rstaff': [{ installPath: operatorInstall }] },
  }));

  const result = spawnSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.equal(result.status, 0, result.stderr);
});

test('capitalised profile token reaches dispatch and CI joins, and every rendered entry has a reason', () => {
  const f = homeFixture({ ghStatus: 0 });
  const product = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-product-'));
  execFileSync('git', ['init', '-q', product]);
  execFileSync('git', ['-C', product, 'remote', 'add', 'origin', 'https://github.com/acme/Aristotle.git']);
  fs.writeFileSync(path.join(product, 'x'), 'x');
  execFileSync('git', ['-C', product, 'add', 'x']);
  execFileSync('git', ['-C', product, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'x']);
  fs.writeFileSync(path.join(f.home, 'profiles', 'Aristotle.md'), `**Repo:** \`${product}\`\n`);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-gh-'));
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then exit 0; fi\nif [ "$1 $2" = "run list" ]; then echo \'[{"conclusion":"failure","status":"completed"}]\'; else echo "[]"; fi\n');
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  f.env.PATH = `${bin}:/usr/bin:/bin`;
  writeTicket(f.home, 'Aristotle.md', `${ticket('DEMO-001', 'dispatch ticket').replace('- links: -', '- links: dispatch:demo')}${ticket('DEMO-002', 'ci ticket')}`);
  fs.mkdirSync(path.join(f.home, 'var', 'dispatch', 'Aristotle'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'var', 'dispatch', 'Aristotle', 'demo.md'), 'state: needs_human\nnext_human_action: inspect\n');
  const out = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.match(out, /why: dispatch demo at needs_human/);
  assert.match(out, /why: red CI on main/);
  const reasons = [...out.matchAll(/^\s+why: (.+) · route:/gm)];
  assert.ok(reasons.length >= 2);
  assert.ok(reasons.every((m) => m[1].trim()));
});

test('queue is top-level, gh signal is hermetic, blocker title is resolved, and legacy sections are unchanged', () => {
  const f = homeFixture();
  writeTicket(f.home, 'Aristotle.md', `${ticket('FAKE-001', 'harness not proven stable across reruns').replace('- pri: P1', '- pri: P0')}${ticket('DEMO-001', 'blocked ticket title').replace('- deps: -', '- deps: FAKE-001')}`);
  fs.mkdirSync(path.join(f.home, 'var', 'dispatch', 'Aristotle'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'var', 'dispatch', 'Aristotle', 'demo.md'), 'state: needs_human\nnext_human_action: inspect\n');
  const out = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.ok(out.indexOf('## What to work on next') < out.indexOf('## Active dispatch runs'));
  assert.match(out, /Blocked \(1\)[\s\S]*waiting on FAKE-001 \(harness not proven stable across reruns\)/);
  assert.doesNotMatch(out, /waiting on FAKE-001 \(blocked ticket title\)/);
  assert.match(out, /Signal unavailable: gh not authenticated — CI and PR rank inputs omitted\./);
  assert.match(out, /Attention next[\s\S]*dispatch Aristotle\/demo needs you/);
  const existing = out.slice(out.indexOf('## Active dispatch runs'));
  assert.equal(existing, [
    '## Active dispatch runs', '- ⚠ Aristotle/demo — needs_human · next: inspect', '',
    '## Managed repos', `- ${path.basename(f.home).toLowerCase()} — local-only (control repo) · ${f.home}`,
    '- Aristotle — local-only · /definitely-not-a-repo', '', '## Token usage (30d)', '- no captured runs', '',
    '## Attention next', '- dispatch Aristotle/demo needs you: inspect', '',
  ].join('\n'));
  const ghAvailable = homeFixture({ ghStatus: 0 });
  const available = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: ghAvailable.env });
  assert.doesNotMatch(available, /Signal unavailable:/);
});

test('missing backlog directory and empty backlog still render, including json queue', () => {
  for (const backlog of [false, true]) {
    const f = homeFixture({ backlog });
    const text = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
    assert.match(text, /## What to work on next  \(0 open · 0 blocked/);
    const json = JSON.parse(execFileSync(process.execPath, [cockpit, '--json'], { encoding: 'utf8', env: f.env }));
    assert.deepEqual(json.queue.ranked, []);
    assert.deepEqual(json.queue.blocked, []);
  }
});

test('queue surfaces gaps and every ranked entry has a reason', () => {
  const f = homeFixture();
  writeTicket(f.home, 'Aristotle.md', `${ticket('DEMO-001', 'valid ticket')}\n## BROKEN-002: malformed\n- status: open\n`);
  const out = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.match(out, /Queue gaps[\s\S]*aristotle BROKEN-002 — missing required field/);
  const json = JSON.parse(execFileSync(process.execPath, [cockpit, '--json'], { encoding: 'utf8', env: f.env }));
  assert.ok(json.queue.ranked.length > 0);
  assert.ok(json.queue.ranked.every((entry) => typeof entry.reason === 'string' && entry.reason.trim()));
});

test('blocked queue preserves every unmet dependency and resolves each blocker title', () => {
  const f = homeFixture();
  writeTicket(f.home, 'Aristotle.md', `${ticket('FAKE-001', 'first blocker')}${ticket('FAKE-002', 'second blocker')}${ticket('DEMO-001', 'blocked title').replace('- deps: -', '- deps: FAKE-001, FAKE-002')}`);
  const out = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.match(out, /waiting on FAKE-001 \(first blocker\), FAKE-002 \(second blocker\)/);
});

// --- a row whose branch is gone is stale, and must stop recommending itself ---

// A real repo, not a stub `git`: these cases are about what for-each-ref actually
// reports, so faking its output would test the fake.
function repoWithBranches(branches = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-repo-'));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@e', '-c', 'user.name=t', ...args]);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'x'), 'x');
  git('add', 'x');
  git('commit', '-qm', 'x');
  for (const b of branches) git('branch', b);
  return dir;
}

function dispatchRow(home, repo, slug, body) {
  fs.mkdirSync(path.join(home, 'var', 'dispatch', repo), { recursive: true });
  fs.writeFileSync(path.join(home, 'var', 'dispatch', repo, `${slug}.md`), body);
}

test('a dead branch marks the row stale, withholds it from Attention, and demotes its ticket out of rule 1', () => {
  const f = homeFixture();
  fs.writeFileSync(path.join(f.home, 'profiles', 'Aristotle.md'), `**Repo:** \`${repoWithBranches()}\`\n`);
  writeTicket(f.home, 'Aristotle.md', ticket('DEMO-001', 'dispatch ticket').replace('- links: -', '- links: dispatch:dead'));
  dispatchRow(f.home, 'Aristotle', 'dead',
    '# Aristotle / dead\nstate: needs_human\nworktree: /w    branch: feat/gone\nnext_human_action: inspect\n');
  const out = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.match(out, /^- Aristotle\/dead — needs_human · feat\/gone \(gone — row is stale\) · next: inspect$/m);
  assert.doesNotMatch(out, /dispatch Aristotle\/dead needs you/);
  assert.doesNotMatch(out, /why: dispatch dead at needs_human/);
  assert.match(out, /why: unblocked P1/);
});

test('a repo that cannot be probed never claims staleness', () => {
  const f = homeFixture();   // profile points at /definitely-not-a-repo
  dispatchRow(f.home, 'Aristotle', 'unknown',
    '# Aristotle / unknown\nstate: needs_human\nbranch: feat/gone\nnext_human_action: inspect\n');
  const out = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.match(out, /^- ⚠ Aristotle\/unknown — needs_human · feat\/gone · next: inspect$/m);
  assert.doesNotMatch(out, /row is stale/);
  assert.match(out, /dispatch Aristotle\/unknown needs you/);
});

test('an in-flight branch not yet pushed to origin reads live, not stale', () => {
  const f = homeFixture();
  fs.writeFileSync(path.join(f.home, 'profiles', 'Aristotle.md'), `**Repo:** \`${repoWithBranches(['feat/wip'])}\`\n`);
  dispatchRow(f.home, 'Aristotle', 'wip', '# Aristotle / wip\nstate: building\nworktree: /w    branch: feat/wip\n');
  const out = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.match(out, /^- Aristotle\/wip — building · feat\/wip$/m);
  assert.doesNotMatch(out, /row is stale/);
});

test('a stateless brief is excluded, and the branch segment shows the ref rather than its trailing prose', () => {
  const f = homeFixture();
  fs.writeFileSync(path.join(f.home, 'profiles', 'Aristotle.md'), `**Repo:** \`${repoWithBranches()}\`\n`);
  // A brief or other non-run file declares no state, so it is excluded rather than
  // rendered as a dispatch row, even if its branch is gone.
  dispatchRow(f.home, 'Aristotle', 'x.T4.brief', '# brief\ncwd: /w    branch: feat/gone    HEAD: abc1234\n');
  // A run whose branch value trails prose renders the ref, not the prose.
  dispatchRow(f.home, 'Aristotle', 'wordy', '# Aristotle / wordy\nstate: shipped\nworktree: /w    branch: feat/gone (merged, deleted)\n');
  const out = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.doesNotMatch(out, /Aristotle\/x\.T4\.brief/);
  assert.match(out, /^- Aristotle\/wordy — shipped · feat\/gone \(gone — row is stale\)$/m);
});

test('a branch value naming no ref still shows its prose, and is never called stale', () => {
  const f = homeFixture();
  fs.writeFileSync(path.join(f.home, 'profiles', 'Aristotle.md'), `**Repo:** \`${repoWithBranches()}\`\n`);
  dispatchRow(f.home, 'Aristotle', 'merged',
    '# Aristotle / merged\nstate: merged\nworktree: /w    branch: (deleted — merged to main)\n');
  const out = execFileSync(process.execPath, [cockpit], { encoding: 'utf8', env: f.env });
  assert.match(out, /^- Aristotle\/merged — merged · \(deleted — merged to main\)$/m);
  assert.doesNotMatch(out, /row is stale/);
});
