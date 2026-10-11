'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const script = path.join(repo, 'plugins/rstaff/scripts/setup.js');
const { setup } = require(script);
const { readAdapters } = require(path.join(repo, 'plugins/rstaff-ai/scripts/adapter.js'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-setup-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'control home');
  const product = path.join(root, 'acme-api');
  return { home, product };
}

test('setup on a sample copy embeds a block that readAdapters returns with resolved cwd', t => {
  const f = fixture(t);
  fs.cpSync(path.join(repo, 'plugins/rstaff-ai/samples/label-task'), f.product, { recursive: true });
  const declared = JSON.parse(fs.readFileSync(path.join(f.product, 'rstaff-adapter.json'), 'utf8'));
  const cli = spawnSync(process.execPath,
    [script, '--home', f.home, '--product', `${f.product}/../acme-api`], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.verify, 'npm run verify');
  assert.equal(result.verifySource, 'package.json');
  assert.deepEqual(result.adapters, ['label-exact-match']);
  assert.deepEqual(readAdapters(fs.readFileSync(result.profile, 'utf8')), {
    'label-exact-match': { ...declared['label-exact-match'], cwd: f.product },
  });
});

test('readAdapters reads back every entry setup embeds', t => {
  const f = fixture(t);
  fs.mkdirSync(f.product);
  const declared = { first: { run: 'node first.js', cwd: 'old-path' }, second: { run: 'node second.js' } };
  fs.writeFileSync(path.join(f.product, 'rstaff-adapter.json'), JSON.stringify(declared));
  const result = setup({ ...f, verify: 'true' });
  assert.deepEqual(readAdapters(fs.readFileSync(result.profile, 'utf8')), {
    first: { ...declared.first, cwd: f.product }, second: { ...declared.second, cwd: f.product },
  });
});
