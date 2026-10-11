#!/usr/bin/env node
'use strict';
// nbgate: the DS done signal. Every git-listed notebook must have run-order
// execution counts and survive a fresh-kernel run inside a throwaway copy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function cleanEnv(env = process.env) {
  const out = { ...env };
  delete out.GIT_DIR;
  delete out.GIT_WORK_TREE;
  delete out.GIT_INDEX_FILE;
  return out;
}

function gitFiles(top) {
  const r = spawnSync('git', ['-C', top, 'ls-files', '-co', '--exclude-standard', '-z'],
    { env: cleanEnv(), encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error || r.status !== 0) throw new Error('git ls-files failed');
  return r.stdout.split('\0').filter(Boolean);
}

function ignoreGlobs(top) {
  let text;
  try { text = fs.readFileSync(path.join(top, '.rstaff-nbignore'), 'utf8'); } catch (_) { return []; }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function scan(top, { ignoreFile = true } = {}) {
  const globs = ignoreFile ? ignoreGlobs(top) : [];
  if (globs.length && typeof path.matchesGlob !== 'function') {
    throw new Error(`node >= 22.5 required (found ${process.version})`);
  }
  const notebooks = [];
  let skipped = 0;
  for (const f of gitFiles(top)) {
    if (!f.endsWith('.ipynb')) continue;
    if (f.split('/').includes('.ipynb_checkpoints')) continue;
    try { fs.lstatSync(path.join(top, f)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; } // tracked but deleted
    if (globs.some((g) => path.matchesGlob(f, g))) { skipped += 1; continue; }
    notebooks.push(f);
  }
  notebooks.sort();
  return { notebooks, skipped };
}

function listNotebooks(top, opts) { return scan(top, opts).notebooks; }

function checkCounts(nb) {
  const cells = nb && Array.isArray(nb.cells) ? nb.cells : [];
  let expected = 0;
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i];
    if (!c || c.cell_type !== 'code') continue;
    const src = Array.isArray(c.source) ? c.source.join('') : String(c.source || '');
    if (!src.trim()) continue;
    expected += 1;
    if (c.execution_count === null || c.execution_count === undefined) {
      return { ok: false, reason: `cell ${i + 1} never run; Restart & Run All, then save` };
    }
    if (c.execution_count !== expected) {
      return { ok: false, reason: `cell ${i + 1} has ${c.execution_count}, expected ${expected}` };
    }
  }
  return { ok: true };
}

function summarize(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd()).filter((l) => l.trim());
  const hit = [...lines].reverse().find((l) => /^\w[\w.]*(Error|Exception)\b/.test(l));
  return hit || lines[lines.length - 1] || 'nbconvert failed';
}

function main(argv, env = process.env) {
  const out = (s) => process.stdout.write(`${s}\n`);
  const err = (s) => process.stderr.write(`${s}\n`);
  const top0 = spawnSync('git', ['rev-parse', '--show-toplevel'], { env: cleanEnv(env), encoding: 'utf8' });
  if (top0.error || top0.status !== 0) { err('nbgate: not a git repository'); return 2; }
  const top = top0.stdout.trim();
  let found;
  try { found = scan(top); } catch (e) { err(`nbgate: ${e.message}`); return 2; }
  const { notebooks, skipped } = found;
  if (notebooks.length === 0) {
    out(skipped ? `nbgate: 0 notebooks (${skipped} skipped by .rstaff-nbignore)` : 'nbgate: 0 notebooks');
    return 0;
  }
  const py = env.RSTAFF_NBGATE_PYTHON || 'python3';
  const timeout = env.RSTAFF_NBGATE_TIMEOUT || 600;
  const pre = spawnSync(py, ['-c', 'import nbconvert, ipykernel'], { encoding: 'utf8', env: cleanEnv(env) });
  if (pre.error || pre.status !== 0) {
    err('nbgate: python with nbconvert and ipykernel is required: pip install nbconvert ipykernel');
    return 2;
  }
  let tmp;
  const rows = [];
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-nbgate-'));
    const copy = path.join(tmp, 'tree');
    for (const f of gitFiles(top)) {
      const src = path.join(top, f);
      const dst = path.join(copy, f);
      let st;
      try {
        st = fs.lstatSync(src);
      } catch (_) { continue; } // listed but deleted
      if (st.isDirectory()) continue; // submodule gitlink or nested repo listed as sub/
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { verbatimSymlinks: true });
    }
    const outDir = path.join(tmp, '.nbgate-out');
    notebooks.forEach((nb, i) => {
      const problems = [];
      let counts = 'counts ok';
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(path.join(top, nb), 'utf8')); } catch (_) { counts = 'counts: invalid notebook JSON'; }
      if (parsed) {
        const c = checkCounts(parsed);
        if (!c.ok) counts = `counts: ${c.reason}`;
      }
      if (!counts.endsWith('ok')) problems.push(counts);
      const target = path.join(copy, nb);
      const r = spawnSync(py, ['-m', 'nbconvert', '--to', 'notebook', '--execute',
        `--ExecutePreprocessor.timeout=${timeout}`, '--output-dir', outDir, '--output', String(i), target],
      { cwd: path.dirname(target), encoding: 'utf8', env: cleanEnv(env), maxBuffer: 1 << 28 });
      let fresh = 'fresh run ok';
      if (r.error || r.status !== 0) {
        fresh = `fresh run: ${r.error ? r.error.message : summarize(r.stderr)}`;
        problems.push(fresh);
      }
      rows.push({ nb, text: `${counts} · ${fresh}`, red: problems.length > 0 });
    });
  } catch (e) {
    err(`nbgate: ${e.message}`);
    return 2;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  out(`nbgate: ${notebooks.length} notebooks${skipped ? ` (${skipped} skipped by .rstaff-nbignore)` : ''}`);
  const width = Math.max(...rows.map((r) => r.nb.length)) + 3;
  for (const r of rows) out(`  ${r.nb.padEnd(width)}${r.text}`);
  const red = rows.filter((r) => r.red).length;
  if (red) { out(`nbgate: RED (${red} of ${notebooks.length} notebooks)`); return 1; }
  out('nbgate: GREEN');
  return 0;
}

module.exports = { listNotebooks, checkCounts, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2), process.env);
