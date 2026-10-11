'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');
const { checkInstall } = require('../../maintainer/lib-install.js');
const { lintTree } = require('../../maintainer/lib-skill-lint.js');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-maintainer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

test('marketplace drift compares every plugin: clean core, content drift and version drift layers', t => {
  const home = temporary(t);
  const configDir = path.join(home, 'config');
  const names = ['rstaff', 'rstaff-ai', 'rstaff-usage', 'rstaff-backlog'];
  const records = {};
  for (const name of names) {
    const source = path.join(home, 'plugins', name);
    write(path.join(source, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
    write(path.join(source, 'payload.js'), 'clean');
    const installed = path.join(home, 'cache', name);
    fs.cpSync(source, installed, { recursive: true });
    records[`${name}@rstaff`] = [{ version: name === 'rstaff-backlog' ? '0.9.0' : '1.0.0', installPath: installed }];
    if (name === 'rstaff-usage') write(path.join(installed, 'payload.js'), 'stale');
  }
  write(path.join(home, '.claude-plugin/marketplace.json'), JSON.stringify({
    name: 'rstaff', plugins: names.map(name => ({ name, source: `./plugins/${name}` })),
  }));
  write(path.join(configDir, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: records }));
  const verdict = checkInstall(home, path.join(home, 'fake-home'), { configDir });
  assert.deepEqual(verdict.plugins.map(p => p.name), names);
  assert.deepEqual(verdict.plugins.map(p => p.status), ['PASS', 'PASS', 'WARN', 'FAIL']);
  assert.equal(verdict.plugins[0].copy.differs, false);
  assert.deepEqual(verdict.plugins[2].copy.changed, ['payload.js']);
  assert.equal(verdict.status, 'FAIL');
  assert.equal(verdict.action, 'update');
  assert.equal(verdict.sourceVersion, '1.0.0');
  assert.match(verdict.note, /claude plugin update rstaff-backlog@rstaff/);
  // An absent plugin's informational WARN must not hide another layer's bump.
  delete records['rstaff@rstaff'];
  records['rstaff-backlog@rstaff'][0].version = '1.0.0';
  write(path.join(configDir, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: records }));
  const mixed = checkInstall(home, path.join(home, 'fake-home'), { configDir });
  assert.equal(mixed.status, 'WARN');
  assert.equal(mixed.action, 'bump');
});

test('lintTree and its CLI detect a defect in a non-core plugin', t => {
  const home = temporary(t);
  for (const name of ['rstaff', 'rstaff-fixture']) {
    write(path.join(home, 'plugins', name, '.claude-plugin/plugin.json'), JSON.stringify({ name }));
    write(path.join(home, 'plugins', name, 'commands/good.md'), '---\ndescription: good\n---\nbody\n');
  }
  const defect = path.join(home, 'plugins/rstaff-fixture/commands/bad.md');
  write(defect, 'missing frontmatter\n');
  const result = lintTree(home);
  assert.equal(result.counts.commands, 3);
  assert.ok(result.violations.some(v => v.file === defect && v.code === 'F1'));
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'maintainer/lib-skill-lint.js'), home], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.ok(cli.stdout.includes(`F1 ${defect}`), cli.stdout + cli.stderr);
});

test('plugins have no static maintainer require and dynamic loads are existence guarded', () => {
  const files = walk(path.join(ROOT, 'plugins')).filter(file => file.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const calls = source.match(/require\s*\([^;\n]*\)/g) || [];
    for (const call of calls) assert.doesNotMatch(call, /maintainer/, `${file}: ${call}`);
    if (!source.includes("'maintainer'")) continue;
    assert.ok(['hooks/session-start.js', 'scripts/health.js'].some(suffix => file === path.join(ROOT, 'plugins/rstaff', suffix)), file);
    assert.match(source, /if \((?:fs\.existsSync|exists)\(installCheck\)\)\s*\{\s*const v = require\(installCheck\)/, file);
    if (file.endsWith('health.js')) {
      assert.match(source, /if \(exists\(selfTest\) && exists\(corpus\)\)/);
    }
  }
});

test('core session-start without maintainer skips its load silently and preserves the profile', t => {
  const home = temporary(t);
  const core = path.join(home, 'plugins/rstaff');
  fs.cpSync(path.join(ROOT, 'plugins/rstaff'), core, { recursive: true });
  write(path.join(home, 'rstaff.json'), '{}');
  write(path.join(home, 'profiles', `${require('../../plugins/rstaff/hooks/lib.js').slug(home)}.md`), '# Profile sentinel\n');
  // Observe load attempts as well as errors: the hook catches failures, so stderr
  // alone cannot prove that the missing module was skipped before require.
  const preload = path.join(home, 'observe.js');
  write(preload, `const Module = require('node:module');
const original = Module._load;
Module._load = function(request, ...args) {
  if (request.includes('lib-install.js')) process.stderr.write('INSTALL_LOAD_ATTEMPT');
  return original.call(this, request, ...args);
};\n`);
  const result = spawnSync(process.execPath, ['--require', preload, path.join(core, 'hooks/session-start.js')], {
    input: JSON.stringify({ cwd: home }), encoding: 'utf8', cwd: home,
    env: { PATH: process.env.PATH, HOME: home, RSTAFF_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'config') },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Profile sentinel/);
  assert.doesNotMatch(context, /install drift/);
});
