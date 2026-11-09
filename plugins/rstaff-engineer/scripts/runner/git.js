'use strict';
// Thin git helpers; every call records nothing and throws on failure unless told otherwise.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  if (!extra.GIT_INDEX_FILE) delete env.GIT_INDEX_FILE;
  return env;
}
function git(cwd, args, { allowFail = false, env = {}, input } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(env), input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function defaultBranch(repo) {
  const r = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (r.status === 0) return r.stdout.trim().replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true }).status === 0) return name;
  }
  throw new Error('cannot find the default branch (no origin/HEAD, main or master)');
}
// Whether git can name a committer here (config or GIT_* env). `git var` applies the same strict check
// as `git commit`, so a "no" here is the "Author identity unknown" that would otherwise hit after the worker was paid.
function hasIdentity(repo, env = {}) {
  return git(repo, ['var', 'GIT_COMMITTER_IDENT'], { allowFail: true, env }).status === 0;
}
function hasRemote(repo) {
  return git(repo, ['remote', 'get-url', 'origin'], { allowFail: true }).status === 0;
}
// A fresh worktree on a new branch from the freshest base we can reach (origin/<default>, else local).
function addWorktree(repo, tree, branch, base) {
  let start = base;
  if (hasRemote(repo) && git(repo, ['fetch', '--quiet', 'origin', base], { allowFail: true }).status === 0) start = `origin/${base}`;
  if (git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).status === 0) {
    throw new Error(`branch ${branch} already exists in ${repo}; remove it or pick another ticket branch`);
  }
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  git(repo, ['worktree', 'add', '--quiet', '-b', branch, tree, start]);
  return start;
}
// A detached scratch checkout of the freshest base (origin/<default>, else local); nothing is branched.
function addScratchWorktree(repo, tree, base) {
  let start = base;
  if (hasRemote(repo) && git(repo, ['fetch', '--quiet', 'origin', base], { allowFail: true }).status === 0) start = `origin/${base}`;
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  git(repo, ['worktree', 'add', '--quiet', '--detach', tree, start]);
  return start;
}
function removeWorktree(repo, tree) {
  git(repo, ['worktree', 'remove', '--force', tree], { allowFail: true });
  git(repo, ['worktree', 'prune'], { allowFail: true });
  fs.rmSync(tree, { recursive: true, force: true });
}
function head(tree) { return git(tree, ['rev-parse', 'HEAD']).stdout.trim(); }
// Hash of the working tree content (tracked + untracked, not ignored) without touching the real index.
function treeHash(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-runner-index-'));
  try {
    const index = path.join(dir, 'index');
    const env = { GIT_INDEX_FILE: index };
    git(tree, ['read-tree', 'HEAD'], { env });
    git(tree, ['add', '-A'], { env });
    return git(tree, ['write-tree'], { env }).stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// Stage everything the worker did and report it: the paths and the patch the referee reads.
function stageAll(tree) {
  git(tree, ['add', '-A']);
  const paths = git(tree, ['diff', '--cached', '--name-only', '-z']).stdout.split('\0').filter(Boolean);
  const patch = git(tree, ['diff', '--cached']).stdout;
  return { paths, patch };
}
// The run's own environment decides the identity and credentials, not the runner process's.
function commit(tree, message, env = {}) {
  git(tree, ['commit', '--quiet', '-m', message], { env });
  return head(tree);
}
function push(tree, branch, env = {}) {
  return git(tree, ['push', '--quiet', '-u', 'origin', branch], { allowFail: true, env });
}

module.exports = { git, defaultBranch, hasIdentity, hasRemote, addWorktree, addScratchWorktree, removeWorktree, head, treeHash, stageAll, commit, push };
