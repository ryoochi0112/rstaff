'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = process.env.RSTAFF_CORE_ROOT || path.resolve(__dirname, '../../plugins/rstaff');
const script = path.join(core, 'scripts/setup.js');
const { setup } = require(script);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'control home');
  const product = path.join(root, 'acme-api');
  fs.mkdirSync(product);
  const write = (name, text) => fs.writeFileSync(path.join(product, name), text);
  const cli = (...args) => spawnSync(process.execPath,
    [script, '--home', home, '--product', product, ...args], { encoding: 'utf8' });
  const nameCli = (...args) => spawnSync(process.execPath,
    [script, '--home', home, ...args], { encoding: 'utf8', cwd: root });
  return { root, home, product, write, cli, nameCli };
}

function snapshot(dir) {
  const files = {};
  function walk(current) {
    for (const name of fs.readdirSync(current)) {
      const target = path.join(current, name);
      if (fs.statSync(target).isDirectory()) walk(target);
      else files[path.relative(dir, target)] = fs.readFileSync(target).toString('base64');
    }
  }
  walk(dir);
  return files;
}

// Inline read of the embedded block; the real reader (rstaff-ai adapter.js) is exercised in
// test/ai/setup-adapter.test.js, since core tests must not reach sibling plugins.
function adapterBlock(text) {
  const match = text.match(/\n## experiment\.adapters\n```json\n([\s\S]*?)\n```\n$/);
  return match && JSON.parse(match[1]);
}

test('adapter setup sets cwd on every entry and preserves the declared fields', t => {
  const f = fixture(t);
  const declared = {
    first: { run: 'node first.js', grader: 'code', cwd: 'old-path' },
    second: { run: 'node second.js', holdout: 'cases.jsonl' },
  };
  f.write('rstaff-adapter.json', JSON.stringify(declared));
  const result = setup({ ...f, verify: 'true' });
  assert.deepEqual(result.adapters, ['first', 'second']);
  assert.deepEqual(adapterBlock(fs.readFileSync(result.profile, 'utf8')), {
    first: { ...declared.first, cwd: f.product }, second: { ...declared.second, cwd: f.product },
  });
});

test('adapter setup reports an empty declaration as an empty adapters list', t => {
  const f = fixture(t);
  f.write('rstaff-adapter.json', '{}');
  const result = setup({ ...f, verify: 'true' });
  assert.deepEqual(result.adapters, []);
  assert.deepEqual(adapterBlock(fs.readFileSync(result.profile, 'utf8')), {});
});

test('invalid adapter JSON throws naming the file and the CLI writes no profile', t => {
  const f = fixture(t);
  f.write('rstaff-adapter.json', '{broken');
  assert.throws(() => setup({ ...f, verify: 'true' }), /rstaff-adapter\.json/);
  const cli = f.cli('--verify', 'true');
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /rstaff-adapter\.json/);
  assert.equal(fs.existsSync(path.join(f.home, 'profiles/acme-api.md')), false);
});

test('adapter setup reruns preserve existing profiles with and without a block', t => {
  const f = fixture(t);
  const first = setup({ ...f, verify: 'true' });
  for (const content of [fs.readFileSync(first.profile, 'utf8'),
    'custom profile\n\n## experiment.adapters\n```json\n{"custom":{"cwd":"keep"}}\n```\n']) {
    fs.writeFileSync(first.profile, content);
    f.write('rstaff-adapter.json', JSON.stringify({ fresh: { run: 'node fresh.js' } }));
    const result = setup({ ...f, verify: 'new check' });
    assert.deepEqual(result.adapters, ['fresh']);
    assert.deepEqual(result.created, []);
    assert.ok(result.unchanged.includes('profiles/acme-api.md'));
    assert.equal(fs.readFileSync(first.profile, 'utf8'), content);
  }
});

test('empty home CLI creates the scaffold and a profile rendered from the core template', t => {
  const f = fixture(t);
  f.write('Makefile', '.PHONY: verify\nverify:\n\ttrue\n');
  // Both signals exist: Makefile must take precedence.
  f.write('package.json', JSON.stringify({ scripts: { verify: 'node check.js' } }));
  const cli = f.cli();
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  assert.equal(cli.stdout.trim().split('\n').length, 1);
  const result = JSON.parse(cli.stdout);
  assert.deepEqual(result.created, ['rstaff.json', 'profiles/', 'backlog/', 'backlog/.gitkeep',
    'profiles/acme-api.md', '.gitignore', 'git init']);
  assert.deepEqual(result.unchanged, []);
  assert.equal(result.profile, path.join(f.home, 'profiles/acme-api.md'));
  assert.equal(result.verify, 'make verify');
  assert.equal(result.verifySource, 'Makefile');
  assert.equal(result.needsVerify, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'rstaff.json'))), {
    rstaff: 'control-repo', version: require(path.join(core, '.claude-plugin/plugin.json')).version,
    layout: { profiles: './profiles', backlog: './backlog', var: './var' },
  });
  assert.ok(fs.statSync(path.join(f.home, 'backlog')).isDirectory());
  assert.equal(fs.readFileSync(path.join(f.home, 'backlog/.gitkeep'), 'utf8'), '');
  assert.match(fs.readFileSync(path.join(f.home, '.gitignore'), 'utf8'), /^var\/$/m);
  assert.ok(fs.statSync(path.join(f.home, '.git')).isDirectory());
  const profile = fs.readFileSync(result.profile, 'utf8');
  const template = fs.readFileSync(path.join(core, 'templates/profile.sample.md'), 'utf8');
  assert.deepEqual(profile.match(/^## .+$/gm), template.match(/^## .+$/gm));
  assert.match(profile, /^\*\*What it is:\*\*/m);
  assert.ok(profile.includes(`**Repo:** \`${f.product}\``));
  assert.match(profile, /^\*\*Verify \(DoD\):\*\* `make verify`$/m);
});

test('identical rerun creates nothing and preserves every file byte for byte', t => {
  const f = fixture(t);
  f.write('Makefile', 'verify:\n\ttrue\n');
  const first = setup(f);
  const before = snapshot(f.home);
  const second = setup(f);
  assert.deepEqual(second.created, []);
  assert.deepEqual([...second.unchanged].sort(), [...first.created].sort());
  assert.deepEqual(snapshot(f.home), before);
});

test('existing rstaff marker and custom profile are never overwritten even with a new verify', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, 'profiles'), { recursive: true });
  const marker = '{"rstaff":"control-repo","custom":"keep me"}\n';
  fs.writeFileSync(path.join(f.home, 'rstaff.json'), marker);
  const profile = path.join(f.home, 'profiles/acme-api.md');
  fs.writeFileSync(profile, 'custom profile\n');
  const result = setup({ ...f, verify: 'custom check' });
  assert.ok(result.unchanged.includes('profiles/acme-api.md'));
  assert.ok(result.unchanged.includes('rstaff.json'));
  assert.equal(fs.readFileSync(profile, 'utf8'), 'custom profile\n');
  assert.equal(fs.readFileSync(path.join(f.home, 'rstaff.json'), 'utf8'), marker);
});

test('foreign and unparseable rstaff.json refuse via CLI before any write', t => {
  const f = fixture(t);
  fs.mkdirSync(f.home);
  for (const content of ['{}', '{"rstaff":"other"}', '{broken', 'null']) {
    fs.writeFileSync(path.join(f.home, 'rstaff.json'), content);
    const before = snapshot(f.home);
    const cli = f.cli('--verify', 'true');
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /^refusing foreign rstaff.json in --home\n$/);
    assert.deepEqual(snapshot(f.home), before);
    assert.deepEqual(fs.readdirSync(f.home), ['rstaff.json']);
  }
});

test('package.json verify is detected when Makefile has no verify target', t => {
  const f = fixture(t);
  f.write('Makefile', '# verify:\nverify := false\ncheck:\n\ttrue\n');
  f.write('package.json', JSON.stringify({ scripts: { verify: 'node check.js' } }));
  const result = setup(f);
  assert.equal(result.verify, 'npm run verify');
  assert.equal(result.verifySource, 'package.json');
  assert.equal(result.needsVerify, false);
  assert.match(fs.readFileSync(result.profile, 'utf8'), /\*\*Verify \(DoD\):\*\* `npm run verify`/);
});

test('missing verify defers the profile until a rerun with the supplied command', t => {
  const f = fixture(t);
  const result = setup(f);
  assert.equal(result.verify, null);
  assert.equal(result.verifySource, null);
  assert.equal(result.needsVerify, true);
  assert.equal(result.profile, path.join(f.home, 'profiles/acme-api.md'));
  assert.equal(fs.existsSync(result.profile), false);
  const next = setup({ ...f, verify: 'node check.js' });
  assert.deepEqual(next.created, ['profiles/acme-api.md']);
  assert.equal(next.needsVerify, false);
  assert.match(fs.readFileSync(next.profile, 'utf8'), /`node check.js`/);
});

test('--verify overrides both detection signals through the CLI', t => {
  const f = fixture(t);
  f.write('Makefile', 'verify:\n\ttrue\n');
  f.write('package.json', JSON.stringify({ scripts: { verify: 'false' } }));
  const cli = f.cli('--verify', 'node custom.js --all');
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.verify, 'node custom.js --all');
  assert.equal(result.verifySource, '--verify');
  assert.equal(result.needsVerify, false);
  assert.match(fs.readFileSync(result.profile, 'utf8'), /`node custom.js --all`/);
});

test('existing gitignore gets only the missing var line appended and is stable on rerun', t => {
  const f = fixture(t);
  fs.mkdirSync(f.home);
  fs.writeFileSync(path.join(f.home, '.gitignore'), 'custom/');
  const result = setup({ ...f, verify: 'true' });
  assert.ok(result.created.includes('.gitignore (var/)'));
  assert.equal(fs.readFileSync(path.join(f.home, '.gitignore'), 'utf8'), 'custom/\nvar/\n');
  const second = setup({ ...f, verify: 'true' });
  assert.deepEqual(second.created, []);
  assert.ok(second.unchanged.includes('.gitignore'));
  assert.equal(fs.readFileSync(path.join(f.home, '.gitignore'), 'utf8'), 'custom/\nvar/\n');
});

test('bad CLI arguments fail with one stderr line and no scaffold writes', t => {
  const f = fixture(t);
  for (const args of [[], ['--home', f.home], ['--product', f.product],
    ['--home', f.home, '--product', f.product, '--unknown', 'x'],
    ['--home', f.home, '--product', f.product, '--verify'],
    ['--home', f.home, '--product', f.product, '--verify', ''],
    ['--home', f.home, '--home', f.home, '--product', f.product]]) {
    const cli = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(cli.status, 1, JSON.stringify(args));
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /^[^\r\n]+\n$/);
    assert.equal(fs.existsSync(f.home), false);
  }
});

test('C1 name mode creates exactly the PM scaffold and result keys', t => {
  const f = fixture(t);
  const cli = f.nameCli('--name', 'acme');
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  assert.equal(cli.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(cli.stdout), {
    created: ['rstaff.json', 'profiles/', 'backlog/', 'backlog/acme.md', '.gitignore', 'git init'],
    unchanged: [], mode: 'pm', backlog: 'backlog/acme.md',
  });
  assert.deepEqual(fs.readdirSync(f.home).sort(), ['.git', '.gitignore', 'backlog', 'profiles', 'rstaff.json']);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'profiles')), []);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'backlog')), ['acme.md']);
  const files = snapshot(f.home);
  const scaffold = Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith('.git/')));
  const marker = JSON.stringify({
    rstaff: 'control-repo', version: require(path.join(core, '.claude-plugin/plugin.json')).version,
    layout: { profiles: './profiles', backlog: './backlog', var: './var' },
  }, null, 2) + '\n';
  assert.deepEqual(scaffold, Object.fromEntries(Object.entries({
    '.gitignore': 'var/\n', 'backlog/acme.md': '# Backlog — acme\n', 'rstaff.json': marker,
  }).map(([name, content]) => [name, Buffer.from(content).toString('base64')])));
});

for (const token of ['Acme', 'a/b', 'acme-', 'a--b', '-a', '']) {
  test(`C1 invalid name ${JSON.stringify(token)} refuses before writing`, t => {
    const f = fixture(t);
    const cli = f.nameCli('--name', token);
    assert.equal(cli.status, 1, `invalid token ${JSON.stringify(token)} must exit 1`);
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /^[^\r\n]+\n$/);
    assert.ok(cli.stderr.includes('^[a-z0-9][a-z0-9-]*$'));
    assert.ok(cli.stderr.includes('slug(token) === token'));
    assert.equal(fs.existsSync(f.home), false);
    assert.throws(() => setup({ home: f.home, name: token }), /--name must match/);
    assert.equal(fs.existsSync(f.home), false);
  });
}

test('C1 name mode rejects product and verify flags and requires home', t => {
  const f = fixture(t);
  for (const extra of [['--product', f.product], ['--verify', 'true']]) {
    const cli = f.nameCli('--name', 'acme', ...extra);
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /^usage: [^\r\n]+\n$/);
    assert.equal(fs.existsSync(f.home), false);
    const key = extra[0].slice(2);
    assert.throws(() => setup({ home: f.home, name: 'acme', [key]: extra[1] }), /^Error: usage:/);
  }
  const cli = spawnSync(process.execPath, [script, '--name', 'acme'], { encoding: 'utf8', cwd: f.root });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /^usage: [^\r\n]+\n$/);
  assert.deepEqual(fs.readdirSync(f.root), ['acme-api']);
});

test('C1 name mode rerun lists all entries unchanged and preserves every byte', t => {
  const f = fixture(t);
  const first = JSON.parse(f.nameCli('--name', 'acme').stdout);
  const before = snapshot(f.home);
  const cli = f.nameCli('--name', 'acme');
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), {
    created: [], unchanged: first.created, mode: 'pm', backlog: 'backlog/acme.md',
  });
  assert.deepEqual(snapshot(f.home), before);
});

test('C1 name mode preserves custom backlog content and appends only missing var ignore', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, 'backlog'), { recursive: true });
  const backlog = path.join(f.home, 'backlog/acme.md');
  const content = Buffer.from('# Custom backlog\r\nKeep these bytes.\n');
  fs.writeFileSync(backlog, content);
  fs.writeFileSync(path.join(f.home, '.gitignore'), 'custom/');
  const result = setup({ home: f.home, name: 'acme' });
  assert.ok(result.unchanged.includes('backlog/acme.md'));
  assert.deepEqual(fs.readFileSync(backlog), content);
  assert.ok(result.created.includes('.gitignore (var/)'));
  assert.equal(fs.readFileSync(path.join(f.home, '.gitignore'), 'utf8'), 'custom/\nvar/\n');
  const before = snapshot(f.home);
  assert.deepEqual(setup({ home: f.home, name: 'acme' }).created, []);
  assert.deepEqual(snapshot(f.home), before);
});

test('C1 name mode refuses foreign markers without changing any byte', t => {
  const f = fixture(t);
  fs.mkdirSync(f.home);
  for (const content of ['{}', '{"rstaff":"other"}', '{broken', 'null']) {
    fs.writeFileSync(path.join(f.home, 'rstaff.json'), content);
    const before = snapshot(f.home);
    const cli = f.nameCli('--name', 'acme');
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, '');
    assert.equal(cli.stderr, 'refusing foreign rstaff.json in --home\n');
    assert.deepEqual(snapshot(f.home), before);
  }
});

test('C2 path mode after name mode reuses the backlog and creates the matching profile', t => {
  const f = fixture(t);
  const first = f.nameCli('--name', 'acme');
  assert.equal(first.status, 0, first.stderr);
  const backlog = path.join(f.home, 'backlog/acme.md');
  const before = fs.readFileSync(backlog);
  const product = path.join(f.root, 'acme');
  fs.mkdirSync(product);
  fs.writeFileSync(path.join(product, 'Makefile'), 'verify:\n\ttrue\n');
  const cli = f.nameCli('--product', product);
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.deepEqual(result.created, ['backlog/.gitkeep', 'profiles/acme.md']);
  assert.equal(result.profile, path.join(f.home, 'profiles/acme.md'));
  assert.match(fs.readFileSync(result.profile, 'utf8'), /\*\*Verify \(DoD\):\*\* `make verify`/);
  assert.deepEqual(fs.readFileSync(backlog), before);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'backlog')).filter(name => name.endsWith('.md')), ['acme.md']);
  assert.deepEqual(Object.keys(result), ['created', 'unchanged', 'profile', 'verify', 'verifySource', 'needsVerify']);
});

function nbEnv(root) {
  return { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'), GIT_CONFIG_GLOBAL: '/dev/null' };
}
function gitInit(f, dir = f.product) {
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', env: nbEnv(f.root) });
  assert.equal(r.status, 0, r.stderr);
}
function nbCli(f, product = f.product) {
  const r = spawnSync(process.execPath, [script, '--home', f.home, '--product', product],
    { encoding: 'utf8', env: nbEnv(f.root) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('notebooks in a git repo select rstaff:nbgate and write it to the profile', t => {
  const f = fixture(t);
  gitInit(f);
  f.write('a.ipynb', '{}');
  const result = nbCli(f);
  assert.equal(result.verify, 'rstaff:nbgate');
  assert.equal(result.verifySource, 'notebooks');
  assert.equal(result.needsVerify, false);
  assert.equal(result.notebooks, 1);
  assert.match(fs.readFileSync(result.profile, 'utf8'), /^\*\*Verify \(DoD\):\*\* `rstaff:nbgate`$/m);
});

test('a Makefile verify target wins over notebooks', t => {
  const f = fixture(t);
  gitInit(f);
  f.write('a.ipynb', '{}');
  f.write('Makefile', 'verify:\n\ttrue\n');
  const result = nbCli(f);
  assert.equal(result.verify, 'make verify');
  assert.equal(result.verifySource, 'Makefile');
  assert.equal(result.notebooks, undefined);
});

test('notebooks outside a git repo, or only in .ipynb_checkpoints, still need a verify command', t => {
  const f = fixture(t);
  f.write('a.ipynb', '{}');
  assert.equal(nbCli(f).needsVerify, true);
  const g = fixture(t);
  gitInit(g);
  fs.mkdirSync(path.join(g.product, '.ipynb_checkpoints'));
  g.write('.ipynb_checkpoints/x.ipynb', '{}');
  const result = nbCli(g);
  assert.equal(result.needsVerify, true);
  assert.equal(result.verify, null);
});

test('a product below the git top-level counts only notebooks under it', t => {
  const f = fixture(t);
  gitInit(f, f.root);
  fs.writeFileSync(path.join(f.root, 'outside.ipynb'), '{}');
  assert.equal(nbCli(f).needsVerify, true);
  const g = fixture(t);
  gitInit(g, g.root);
  fs.writeFileSync(path.join(g.root, 'outside.ipynb'), '{}');
  g.write('in.ipynb', '{}');
  fs.mkdirSync(path.join(g.root, 'acme-api-other'));
  fs.writeFileSync(path.join(g.root, 'acme-api-other', 'sib.ipynb'), '{}');
  assert.equal(nbCli(g).notebooks, 1);
});

test('a notebook product below the git top-level carries a verifyNote naming the top-level; at the top-level it does not', t => {
  const f = fixture(t);
  gitInit(f, f.root);
  f.write('a.ipynb', '{}');
  const nested = nbCli(f);
  assert.equal(nested.verify, 'rstaff:nbgate');
  assert.equal(nested.verifyNote,
    `nbgate runs every notebook from the git top-level ${fs.realpathSync(f.root)}; the completion gate reads profiles/${path.basename(f.root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.md`);
  const deep = path.join(f.root, 'x', 'y');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'd.ipynb'), '{}');
  assert.match(nbCli(f, deep).verifyNote, /^nbgate runs every notebook from the git top-level /);
  const g = fixture(t);
  gitInit(g);
  g.write('a.ipynb', '{}');
  const top = nbCli(g);
  assert.equal(top.verify, 'rstaff:nbgate');
  assert.equal(top.verifyNote, undefined);
});
