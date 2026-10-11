'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const CORE = process.env.RSTAFF_CORE_ROOT || path.resolve(__dirname, '../../plugins/rstaff');
const script = path.join(CORE, 'scripts/locate.js');
const { locate } = require(script);

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-locate-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const selfRoot = path.join(root, 'plugins', 'rstaff');
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
  fs.mkdirSync(selfRoot, { recursive: true });
  const source = path.join(root, 'plugins', 'target');
  const installed = path.join(root, 'cache', 'target');
  fs.mkdirSync(installed, { recursive: true });
  const registry = value => fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'),
    typeof value === 'string' ? value : JSON.stringify(value));
  const sourcePlugin = () => {
    fs.mkdirSync(path.join(source, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), '{}');
  };
  return { root, configDir, selfRoot, source, installed, registry, sourcePlugin };
}

test('installed path wins over source and uses first existing entry', t => {
  const f = fixture(t);
  f.sourcePlugin();
  f.registry({ version: 2, plugins: { 'target@rstaff': [
    { installPath: path.join(f.root, 'missing') }, { installPath: f.installed },
    { installPath: f.source },
  ] } });
  assert.equal(locate('target', f), f.installed);
});

test('source plugin resolves without an installed registry', t => {
  const f = fixture(t);
  f.sourcePlugin();
  assert.equal(locate('target', f), f.source);
});

test('absent plugin and unmarked sibling return null', t => {
  const f = fixture(t);
  assert.equal(locate('target', f), null);
  fs.mkdirSync(f.source);
  assert.equal(locate('target', f), null);
});

test('stale installed path falls through to source or null', t => {
  const f = fixture(t);
  f.registry({ version: 2, plugins: { 'target@rstaff': [{ installPath: f.source }] } });
  assert.equal(locate('target', f), null);
  f.sourcePlugin();
  assert.equal(locate('target', f), f.source);
});

test('malformed JSON falls through without throwing', t => {
  const f = fixture(t);
  f.registry('{broken');
  assert.equal(locate('target', f), null);
  f.sourcePlugin();
  assert.equal(locate('target', f), f.source);
});

test('wrong registry shapes fall through without throwing', t => {
  const f = fixture(t);
  f.sourcePlugin();
  for (const value of [null, [], {}, { plugins: null }, { plugins: 'bad' },
    { plugins: [] }, { plugins: { 'target@rstaff': { installPath: f.installed } } }]) {
    f.registry(value);
    assert.equal(locate('target', f), f.source, JSON.stringify(value));
  }
});

test('invalid entries do not hide later valid installed entries', t => {
  const f = fixture(t);
  f.registry({ plugins: { 'target@rstaff': [null, {}, { installPath: 42 },
    { installPath: f.installed }] } });
  assert.equal(locate('target', f), f.installed);
});

test('caller marketplace derives from any matching entry with normalized paths', t => {
  const f = fixture(t);
  f.registry({ version: 2, plugins: {
    'unrelated@rstaff': [{ installPath: f.installed }],
    'rstaff@other': [null, {}, { installPath: path.join(f.root, 'missing') },
      { installPath: f.selfRoot + '/.' }],
    'target@rstaff': [{ installPath: f.source }],
    'target@other': [{ installPath: f.installed }],
  } });
  f.sourcePlugin();
  assert.equal(locate('target', { ...f, selfRoot: f.selfRoot + '/../rstaff' }), f.installed);
});

test('caller from other marketplace never uses rstaff installed entry', t => {
  const f = fixture(t);
  f.registry({ plugins: {
    'rstaff@other': [{ installPath: f.selfRoot }],
    'target@rstaff': [{ installPath: f.installed }],
  } });
  assert.equal(locate('target', f), null);
  f.sourcePlugin();
  assert.equal(locate('target', f), f.source);
});

test('CLI uses config env and default selfRoot, prints success and fails silently', t => {
  const f = fixture(t);
  const copy = path.join(f.selfRoot, 'scripts', 'locate.js');
  fs.mkdirSync(path.dirname(copy));
  fs.copyFileSync(script, copy);
  f.registry({ plugins: {
    'rstaff@other': [{ installPath: f.selfRoot }],
    'target@other': [{ installPath: f.installed }],
  } });
  const run = args => spawnSync(process.execPath, [copy, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir }, encoding: 'utf8',
  });
  const hit = run(['target']);
  assert.equal(hit.status, 0);
  assert.equal(hit.stdout, f.installed + '\n');
  assert.equal(hit.stderr, '');
  for (const args of [['absent'], []]) {
    const miss = run(args);
    assert.equal(miss.status, 1);
    assert.equal(miss.stdout, '');
    assert.equal(miss.stderr, '');
  }
  fs.unlinkSync(path.join(f.configDir, 'plugins', 'installed_plugins.json'));
  f.sourcePlugin();
  assert.equal(run(['target']).stdout, f.source + '\n');
});

test('default config directory uses homedir when config env is absent', t => {
  const f = fixture(t);
  const homeConfig = path.join(f.root, '.claude', 'plugins');
  fs.mkdirSync(homeConfig, { recursive: true });
  fs.writeFileSync(path.join(homeConfig, 'installed_plugins.json'), JSON.stringify({
    plugins: { 'target@rstaff': [{ installPath: f.installed }] },
  }));
  const env = { ...process.env, HOME: f.root, USERPROFILE: f.root };
  delete env.CLAUDE_CONFIG_DIR;
  const result = spawnSync(process.execPath, [script, 'target'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, f.installed + '\n');
  assert.equal(result.stderr, '');
});

function settings(f, value) {
  fs.writeFileSync(path.join(f.configDir, 'settings.json'),
    typeof value === 'string' ? value : JSON.stringify(value));
}
const registered = f => f.registry({ plugins: { 'target@rstaff': [{ installPath: f.installed }] } });

test('registered plugin disabled in settings.json returns null like an absent one', t => {
  const f = fixture(t);
  registered(f);
  settings(f, { enabledPlugins: { 'target@rstaff': false } });
  assert.equal(locate('target', f), null);
});

test('disabled registered plugin exits 1 silently through the CLI', t => {
  const f = fixture(t);
  const copy = path.join(f.selfRoot, 'scripts', 'locate.js');
  fs.mkdirSync(path.dirname(copy));
  fs.copyFileSync(script, copy);
  registered(f);
  settings(f, { enabledPlugins: { 'target@rstaff': false } });
  const result = spawnSync(process.execPath, [copy, 'target'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('registered plugin enabled true or key missing still resolves', t => {
  const f = fixture(t);
  registered(f);
  settings(f, { enabledPlugins: { 'target@rstaff': true } });
  assert.equal(locate('target', f), f.installed);
  settings(f, { enabledPlugins: { 'other@rstaff': false } });
  assert.equal(locate('target', f), f.installed);
  settings(f, {});
  assert.equal(locate('target', f), f.installed);
});

test('absent or malformed settings.json counts as enabled without throwing', t => {
  const f = fixture(t);
  registered(f);
  assert.equal(locate('target', f), f.installed);
  for (const value of ['{broken', 'null', '[]', '{"enabledPlugins":null}', '{"enabledPlugins":"x"}']) {
    settings(f, value);
    assert.equal(locate('target', f), f.installed, value);
  }
});

test('disabled registered plugin still falls back to the sibling dev checkout', t => {
  const f = fixture(t);
  registered(f);
  f.sourcePlugin();
  settings(f, { enabledPlugins: { 'target@rstaff': false } });
  assert.equal(locate('target', f), f.source);
});

test('disabled flag is scoped to the caller marketplace key', t => {
  const f = fixture(t);
  f.registry({ plugins: {
    'rstaff@other': [{ installPath: f.selfRoot }],
    'target@other': [{ installPath: f.installed }],
  } });
  settings(f, { enabledPlugins: { 'target@rstaff': false } });
  assert.equal(locate('target', f), f.installed);
  settings(f, { enabledPlugins: { 'target@other': false } });
  assert.equal(locate('target', f), null);
});
