'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildEvalCopy, removeEvalCopy } = require('../../maintainer/lib-eval-copy.js');

const REPO = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join('.claude-plugin', 'plugin.json');

function listing(dir) {
  const out = new Map();
  for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
    const full = path.join(dir, rel);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) out.set(rel, { link: fs.readlinkSync(full) });
    else if (st.isFile()) {
      out.set(rel, {
        sha: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
        mode: st.mode,
      });
    } else out.set(rel, { dir: true });
  }
  return out;
}

const plugins = fs.globSync('plugins/*/evals', { cwd: REPO }).map((p) => path.join(REPO, path.dirname(p)));

test('six plugins have evals', () => {
  assert.equal(plugins.length, 6);
});

for (const src of plugins) {
  test(`eval copy of ${path.basename(src)}`, () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-copy-test-'));
    try {
      const before = listing(src);
      const { root, pluginDir } = buildEvalCopy(src, tmpRoot);
      assert.equal(path.basename(pluginDir), path.basename(src));

      const srcManifest = JSON.parse(fs.readFileSync(path.join(src, MANIFEST), 'utf8'));
      const copyManifest = JSON.parse(fs.readFileSync(path.join(pluginDir, MANIFEST), 'utf8'));
      assert.ok(!('dependencies' in copyManifest));
      const expected = { ...srcManifest };
      delete expected.dependencies;
      assert.deepEqual(copyManifest, expected);

      const a = listing(src);
      const b = listing(pluginDir);
      assert.deepEqual([...b.keys()], [...a.keys()]);
      for (const [rel, info] of a) {
        if (rel === MANIFEST) continue;
        assert.deepEqual(b.get(rel), info, rel);
      }

      assert.deepEqual(listing(src), before);
      removeEvalCopy(root);
      assert.deepEqual(fs.readdirSync(tmpRoot), []);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
}
