'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '../..');

for (const fixture of ['v3-outcomes.json', 'legacy-raw']) {
  test(`offline replay ${fixture}: REJECT row 3, checks and counts, no Claude call`, t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ablate-replay-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const log = path.join(tmp, 'calls');
    fs.writeFileSync(log, '');
    const shim = path.join(tmp, 'claude');
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test/fixtures/ablate/claude-shim.js')}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
    const run = spawnSync(process.execPath, [path.join(ROOT, 'maintainer/ablate/ablate.js'), '--replay', path.join(ROOT, 'test/fixtures/ablate', fixture), '--legacy'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: tmp, RSTAFF_ABLATE_TRACE: log, ABLATE_SHIM_ARGV_LOG: log },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split('\n'), [
      'K 0/5 · N 7/20 · F 19/20 · F-bridge 5/6 · P 13/20 · P−F = −6',
      'C1 PASS · C2 PASS · C3 PASS · C4 PASS · C5 PASS · C6 PASS · C7 PASS · C8 N/A',
      'verdict: REJECT (row 3: 13 <= 19-6)',
    ]);
    assert.equal(fs.readFileSync(log, 'utf8'), '');
  });
}
