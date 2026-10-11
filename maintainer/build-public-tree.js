#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scan } = require('./leak-scan.js');

const EMAIL = '31046022+ryoochi0112@users.noreply.github.com';
const OVERLAY = 'maintainer/public-overlay/';
const OPERATOR_PATHS = ['backlog', 'profiles', 'specs', 'var', 'rstaff.json', 'HANDOFF.md',
  'LEARNINGS.md', 'docs/research', '.claude', 'maintainer/public-overlay'];
const USAGE = 'Usage: node maintainer/build-public-tree.js --out <dir> [--verify] [--src <git repo root>] [--terms <file>]';

class UsageError extends Error {}

function parse(argv) {
  const options = { verify: false };
  options.src = path.resolve(__dirname, '..');
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new UsageError('duplicate option');
    seen.add(flag);
    if (flag === '--verify') options.verify = true;
    else if (['--out', '--src', '--terms'].includes(flag) && argv[index + 1]
      && !argv[index + 1].startsWith('--')) options[flag.slice(2)] = path.resolve(argv[++index]);
    else throw new UsageError('invalid option');
  }
  if (!options.out) throw new UsageError('--out is required');
  return options;
}

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Ryo Ochi', GIT_AUTHOR_EMAIL: EMAIL,
    GIT_COMMITTER_NAME: 'Ryo Ochi', GIT_COMMITTER_EMAIL: EMAIL };
}

function run(command, args, env, inherit = false) {
  const result = spawnSync(command, args, { env, encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.find(arg => !arg.startsWith('-')) || ''} failed`);
  return result.stdout || '';
}

function git(root, args, env) {
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false', '-c', 'init.templateDir=', '-C', root, ...args], env).trim();
}

function filesUnder(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    return entry.isDirectory() ? filesUnder(path.join(root, entry.name), relative + '/') : [relative];
  });
}

function allowlist(archive) {
  const file = path.join(archive, 'maintainer/public-tree.allow');
  if (!fs.lstatSync(file).isFile()) throw new Error('unsupported archive file: maintainer/public-tree.allow');
  const entries = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const allows = [];
  const denies = [];
  denies.push(OVERLAY);
  for (const entry of entries) {
    const denied = entry.startsWith('!');
    const prefix = denied ? entry.slice(1) : entry;
    const parts = prefix.replace(/\/$/, '').split('/');
    if (!prefix || path.posix.isAbsolute(prefix) || prefix.includes('\\')
      || parts.some(part => !part || part === '.' || part === '..' || part === '.git')) {
      throw new Error('invalid allowlist path');
    }
    (denied ? denies : allows).push(prefix);
  }
  if (!allows.length) throw new Error('allowlist contains no allowed paths');
  return { allows, denies };
}

function matches(file, prefix) {
  return prefix.endsWith('/') ? file.startsWith(prefix)
    : file === prefix || file.startsWith(prefix + '/');
}

function copyFile(archive, relative, out, target = relative) {
  const source = path.join(archive, relative);
  const stat = fs.lstatSync(source);
  if (!stat.isFile()) throw new Error(`unsupported archive file: ${relative}`);
  const destination = path.join(out, target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, stat.mode & 0o777);
}

function gate(label, check) {
  try {
    check();
    process.stdout.write(`${label}: PASS\n`);
  } catch (error) {
    process.stdout.write(`${label}: FAIL\n`);
    throw error;
  }
}

function executableOnPath(command, env) {
  return (env.PATH || '').split(path.delimiter).some(dir => {
    try {
      const file = path.resolve(dir || '.', command);
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch (_) { return false; }
  });
}

function build(options) {
  if (fs.existsSync(options.out)) {
    if (!fs.lstatSync(options.out).isDirectory()) throw new UsageError('--out must be a directory');
    if (fs.readdirSync(options.out).length) throw new UsageError('--out is non-empty; nothing was changed');
  }
  const env = gitEnv();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-public-archive-'));
  try {
    if (git(options.src, ['status', '--porcelain', '--untracked-files=normal'], env)) {
      process.stderr.write('Warning: source is dirty; the build uses HEAD.\n');
    }
    const tar = path.join(temporary, 'head.tar');
    const archive = path.join(temporary, 'archive');
    fs.mkdirSync(archive);
    git(options.src, ['archive', '--format=tar', '--output', tar, 'HEAD'], env);
    run('tar', ['-xf', tar, '-C', archive], env);
    const files = filesUnder(archive);
    const { allows, denies } = allowlist(archive);
    for (const prefix of allows) {
      if (!files.some(file => matches(file, prefix))) throw new Error(`allowlist entry matches nothing: ${prefix}`);
    }
    fs.mkdirSync(options.out, { recursive: true });
    for (const file of files) {
      if (!allows.some(prefix => matches(file, prefix))) continue;
      if (denies.some(prefix => matches(file, prefix))) continue;
      copyFile(archive, file, options.out);
    }
    for (const file of files.filter(file => file.startsWith(OVERLAY))) {
      const target = file.slice(OVERLAY.length);
      if (target.startsWith(OVERLAY)) throw new Error('overlay cannot contain its source directory');
      if (!allows.some(prefix => matches(target, prefix)) || denies.some(prefix => matches(target, prefix))) {
        throw new Error(`overlay target is not allowed: ${target}`);
      }
      const destination = path.join(options.out, target);
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      copyFile(archive, file, options.out, target);
    }
    git(options.out, ['init', '-b', 'main'], env);
    git(options.out, ['add', '--force', '--all'], env);
    git(options.out, ['commit', '-m', 'Initial public release tree'], env);
    gate('leak-scan', () => {
      const hits = scan(options.out, { all: true, termsFile: options.terms });
      for (const hit of hits) process.stdout.write(`${hit.file}:${hit.line} ${hit.term}\n`);
      if (hits.length) throw new Error('leak scan found prohibited content');
    });
    gate('identity', () => {
      const emails = git(options.out, ['log', '--format=%ae%n%ce'], env).split(/\r?\n/);
      if (emails.length !== 2 || emails.some(email => email !== EMAIL)) throw new Error('unexpected author or committer');
    });
    gate('operator paths', () => {
      for (const relative of OPERATOR_PATHS) {
        if (fs.existsSync(path.join(options.out, relative))) throw new Error(`operator path present: ${relative}`);
      }
    });
    if (options.verify) {
      if (!executableOnPath('claude', env)) process.stdout.write('strict validate: SKIPPED\n');
      gate('verify', () => run('env', [
        '-u', 'RSTAFF_HOME',
        'make', '-C', options.out, 'verify',
      ], env, true));
    }
    process.stdout.write(`tree ${git(options.out, ['rev-parse', 'HEAD^{tree}'], env)}\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main(argv) {
  try {
    build(parse(argv));
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error instanceof UsageError) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
