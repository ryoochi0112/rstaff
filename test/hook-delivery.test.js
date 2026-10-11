// Plugin hook delivery and health reporting contracts.
'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// Modules in plugins/rstaff/hooks/ that are libraries, not hook entry points. Anything
// else living there MUST be wired in hooks.json — a hook nobody invokes is the
// same invisible-delivery failure in a different costume.
const NOT_HOOKS = new Set(['lib.js']);

for (const plugin of ['rstaff', 'rstaff-usage']) {

  test(`${plugin}: every hook module is wired in hooks.json`, () => {
    const manifest = fs.readFileSync(path.join(ROOT, 'plugins', plugin, 'hooks', 'hooks.json'), 'utf8');
    const files = fs.readdirSync(path.join(ROOT, 'plugins', plugin, 'hooks'))
      .filter((f) => f.endsWith('.js') && !NOT_HOOKS.has(f));
    assert.ok(files.length >= (plugin === 'rstaff' ? 5 : 3), `expected the hook set, found ${files.join(', ')}`);
    for (const f of files) {
      assert.ok(manifest.includes(`/hooks/${f}`),
        `plugins/${plugin}/hooks/${f} exists but no hooks.json entry invokes it — it would never run`);
    }
  });

  test(`${plugin}: every hook command names a file inside its plugin`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', plugin, 'hooks', 'hooks.json'), 'utf8'));
    for (const entries of Object.values(manifest.hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          for (const match of h.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s"']+)/g)) {
            const hookRoot = path.join(ROOT, 'plugins', plugin, 'hooks');
            const hookFile = path.resolve(hookRoot, match[1]);
            assert.ok(hookFile.startsWith(hookRoot + path.sep), `hook escapes its plugin: ${h.command}`);
            assert.ok(fs.existsSync(hookFile),
              `hooks.json command names missing hook file: ${match[1]}`);
          }
        }
      }
    }
  });

  test(`${plugin}: hooks anchor on CLAUDE_PLUGIN_ROOT, never on the working tree`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', plugin, 'hooks', 'hooks.json'), 'utf8'));
    const commands = [];
    for (const entries of Object.values(manifest.hooks)) {
      for (const entry of entries) for (const h of entry.hooks) commands.push(h.command);
    }
    assert.ok(commands.length > 0);
    for (const c of commands) {
      assert.match(c, /\$\{CLAUDE_PLUGIN_ROOT\}/,
        `hooks.json command must resolve through the plugin root: ${c}`);
      assert.doesNotMatch(c, /rev-parse|--show-toplevel/,
        `a hooks.json command must NOT anchor on the working tree — plugin hooks must resolve through the installed plugin: ${c}`);
    }
  });

}

function healthFull(home) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'rstaff', 'scripts', 'health.js'), '--json'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-dh-')), RSTAFF_HOME: home },
  });
  const report = JSON.parse(r.stdout);
  const find = (name) => report.results.find((x) => x.check === name);
  return { report, find };
}
function mkClone(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rstaff-${tag}-`));
  fs.writeFileSync(path.join(dir, 'rstaff.json'), '{"rstaff":"control-repo"}');
  fs.mkdirSync(path.join(dir, 'profiles'));
  fs.mkdirSync(path.join(dir, 'plugins', 'rstaff', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins', 'rstaff', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'plugins', 'rstaff', 'hooks', 'hooks.json'), path.join(dir, 'plugins', 'rstaff', 'hooks', 'hooks.json'));
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  return dir;
}

function mkCloneWithPluginManifest(tag) {
  const dir = mkClone(tag);
  fs.mkdirSync(path.join(dir, 'maintainer'));
  fs.copyFileSync(path.join(ROOT, 'maintainer', 'lib-install.js'), path.join(dir, 'maintainer', 'lib-install.js'));
  fs.copyFileSync(path.join(ROOT, 'plugins', 'rstaff', 'hooks', 'lib.js'), path.join(dir, 'plugins', 'rstaff', 'hooks', 'lib.js'));
  fs.mkdirSync(path.join(dir, 'plugins', 'rstaff', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'rstaff', '.claude-plugin', 'plugin.json'),
    '{"name":"rstaff","version":"0.8.13"}\n');
  return dir;
}

test('health reports plugin guard delivery with freshness and invocation counts', () => {
  const dir = mkClone('deliver-plugin');
  const { find } = healthFull(dir);
  const plugin = find('guard delivery: plugin');
  assert.match(plugin.note, /version-keyed/, 'the plugin path must be labelled version-keyed');
  assert.match(plugin.note, /module\(s\).*invocation\(s\)/, 'modules and invocations must be distinguished');
});

test('health keeps its full report when the source guard corpus is unavailable', () => {
  const dir = mkCloneWithPluginManifest('guard-payloads-missing');
  const { report, find } = healthFull(dir);
  const selfTest = find('guard self-test (installed copy)');
  assert.ok(selfTest, 'health must report the installed-copy self-test');
  assert.equal(selfTest.status, 'INFO', `${selfTest.status}: ${selfTest.note}`);
  assert.match(selfTest.note, /install-apply\.sh --install/);
  assert.ok(selfTest.note.includes(dir),
    `the degraded row must name the HOME corpus it looked in: ${selfTest.note}`);
  assert.ok(report.results.length > 10, `expected the rest of the report, got ${report.results.length} rows`);
});
