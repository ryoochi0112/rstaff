'use strict';
// Read what the runner needs from profiles/<repo>.md: where the repo is, how to test it, how to install it.
const fs = require('node:fs');
const path = require('node:path');

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function backtick(line) {
  const m = line && line.match(/`([^`]+)`/);
  return m ? m[1] : null;
}
function fencedUnder(lines, heading) {
  const start = lines.findIndex((line) => /^##\s/.test(line) && heading.test(line));
  if (start < 0) return null;
  let inFence = false;
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    if (/^```/.test(lines[i])) { if (inFence) return null; inFence = true; continue; }
    if (inFence && lines[i].trim()) return lines[i].replace(/\s+#.*$/, '').trim();
  }
  return null;
}
// Verify command: the gate's `**Verify (DoD):**` line, then `- verify:`, then the first command of a
// fenced block under a `## verify` heading, then `make verify` when the Makefile has the target.
function resolveVerify(text, repoPath) {
  const lines = text.split(/\r?\n/);
  const dod = backtick(lines.find((line) => /^\s*(?:-\s*)?\*\*Verify \(DoD\):\*\*/.test(line)));
  if (dod) return dod;
  const dash = backtick(lines.find((line) => /^\s*-\s*verify:/i.test(line)));
  if (dash) return dash;
  const fenced = fencedUnder(lines, /^##\s*verify\b/i);
  if (fenced) return fenced;
  if (/^verify:/m.test(readOptional(path.join(repoPath, 'Makefile')))) return 'make verify';
  return null;
}
// Install command: `- install:` line, else `make setup`, else by lockfile. Null means nothing to install.
function resolveInstall(text, tree) {
  const dash = backtick(text.split(/\r?\n/).find((line) => /^\s*-\s*install:/i.test(line)));
  if (dash) return dash;
  if (/^setup:/m.test(readOptional(path.join(tree, 'Makefile')))) return 'make setup';
  if (fs.existsSync(path.join(tree, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile --prefer-offline';
  if (fs.existsSync(path.join(tree, 'package-lock.json'))) return 'npm ci';
  if (fs.existsSync(path.join(tree, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  if (fs.existsSync(path.join(tree, 'uv.lock'))) return 'uv sync';
  return null;
}
function readProfile(home, repo) {
  const file = path.join(home, 'profiles', `${repo}.md`);
  const text = readOptional(file);
  if (!text) throw new Error(`no profile for ${repo}: expected ${file}`);
  const repoLine = text.split(/\r?\n/).find((line) => /\*\*Repo:\*\*/.test(line));
  const repoPath = repoLine && backtick(repoLine);
  if (!repoPath) throw new Error(`profile ${file} has no \`**Repo:** \`/path\`\` line`);
  const cwdLine = text.split(/\r?\n/).find((line) => /cwd for all commands:/i.test(line));
  const cwd = (cwdLine && backtick(cwdLine)) || '.';
  const verify = resolveVerify(text, path.join(repoPath, cwd));
  return { file, text, repoPath, cwd, verify, install: (tree) => resolveInstall(text, path.join(tree, cwd)) };
}

module.exports = { readProfile, resolveVerify, resolveInstall };
