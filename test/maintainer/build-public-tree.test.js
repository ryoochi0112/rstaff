'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { hashTerm } = require('../../maintainer/leak-scan.js');

const ROOT = path.resolve(__dirname, '../..');
const BUILDER = path.join(ROOT, 'maintainer/build-public-tree.js');
const EMAIL = '31046022+ryoochi0112@users.noreply.github.com';
const COMPANY_EMAIL = ['dev', 'example-co.test'].join('@');
const GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.RSTAFF_HOME;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function git(root, ...args) {
  const result = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], {
    encoding: 'utf8', env: cleanEnv({
      GIT_AUTHOR_NAME: 'Fixture User', GIT_AUTHOR_EMAIL: EMAIL,
      GIT_COMMITTER_NAME: 'Fixture User', GIT_COMMITTER_EMAIL: EMAIL,
    }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function commit(src) {
  git(src, 'add', '--all');
  git(src, 'commit', '-m', 'Fixture snapshot');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-public-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  const out = path.join(root, 'out');
  write(src, 'README.md', 'Committed readme\n');
  write(src, 'CLAUDE.md', 'Private contributor guide\n');
  write(src, 'Makefile', `verify:\n\t@'${process.execPath}' -e 'if (process.env.RSTAFF_HOME) process.exit(9); console.log("verified-fixture")'\n`);
  write(src, 'docs/guide.md', 'Committed guide\n');
  write(src, 'docs/research/hidden.md', 'Excluded research\n');
  write(src, 'extras/hidden.md', 'Outside allowlist\n');
  write(src, 'maintainer/public-tree.allow', '# Fixture prefixes\n\nREADME.md\nCLAUDE.md\nMakefile\ndocs/\nmaintainer/\n!docs/research/\n!absent/\n');
  write(src, 'maintainer/public-overlay/CLAUDE.md', 'Public contributor guide\n');
  write(src, 'maintainer/public-overlay/docs/guide.md', 'Public guide\n');
  git(src, 'init', '-b', 'fixture');
  git(src, 'config', 'user.email', COMPANY_EMAIL);
  commit(src);
  const run = (args = [], extra = {}, script = BUILDER) => spawnSync(process.execPath, [script, '--out', out, '--src', src, ...args], {
    encoding: 'utf8', env: cleanEnv(extra),
  });
  return { root, src, out, run };
}

test('CLI rejects missing, duplicate and unknown options before creating output', t => {
  const f = fixture(t);
  for (const args of [[], ['--out'], ['--out', f.out, '--verify', '--verify'],
    ['--out', f.out, '--src'], ['--out', f.out, '--terms'],
    ['--out', f.out, '--out', f.out], ['--out', f.out, '--unknown']]) {
    const result = spawnSync(process.execPath, [BUILDER, ...args], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /Usage:/);
    assert.equal(fs.existsSync(f.out), false);
  }
});

test('allowlist copies only committed paths and preserves executable bytes', t => {
  const f = fixture(t);
  const executable = write(f.src, 'docs/tool.sh', '#!/bin/sh\necho example\n');
  fs.chmodSync(executable, 0o755);
  commit(f.src);
  write(f.src, 'README.md', 'Uncommitted readme\n');
  write(f.src, 'maintainer/public-tree.allow', 'extras/\n');
  write(f.src, 'HANDOFF.md', 'Untracked handoff\n');
  write(f.src, 'var/state.md', 'Untracked state\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /dirty.*HEAD/i);
  assert.equal(fs.readFileSync(path.join(f.out, 'README.md'), 'utf8'), 'Committed readme\n');
  assert.equal(fs.readFileSync(path.join(f.out, 'docs/tool.sh'), 'utf8'), '#!/bin/sh\necho example\n');
  assert.ok(fs.statSync(path.join(f.out, 'docs/tool.sh')).mode & 0o111);
  for (const relative of ['extras', 'HANDOFF.md', 'var']) assert.equal(fs.existsSync(path.join(f.out, relative)), false, relative);
  assert.match(result.stdout, /^leak-scan: PASS$/m);
  assert.match(result.stdout, /^identity: PASS$/m);
  assert.match(result.stdout, /^operator paths: PASS$/m);
  assert.match(result.stdout, new RegExp(`^tree ${git(f.out, 'rev-parse', 'HEAD^{tree}')}$`, 'm'));
});

test('deny prefixes exclude descendants without excluding neighbouring directories', t => {
  const f = fixture(t);
  write(f.src, 'docs/research-other/visible.md', 'Visible neighbour\n');
  commit(f.src);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.out, 'docs/research')), false);
  assert.equal(fs.readFileSync(path.join(f.out, 'docs/research-other/visible.md'), 'utf8'), 'Visible neighbour\n');
});

test('slashless allow entries exclude sibling files and include directory descendants', t => {
  const f = fixture(t);
  write(f.src, '.gitignore', '# Fixture ignore rules\n');
  write(f.src, '.gitignore2', 'Excluded sibling\n');
  write(f.src, 'CLAUDE.md.bak', 'Excluded backup\n');
  write(f.src, 'guides/deep/visible.md', 'Allowed descendant\n');
  write(f.src, 'guides-other/hidden.md', 'Excluded neighbour\n');
  fs.appendFileSync(path.join(f.src, 'maintainer/public-tree.allow'), '.gitignore\nguides\n');
  commit(f.src);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.out, '.gitignore'), 'utf8'), '# Fixture ignore rules\n');
  assert.equal(fs.readFileSync(path.join(f.out, 'guides/deep/visible.md'), 'utf8'), 'Allowed descendant\n');
  for (const relative of ['.gitignore2', 'CLAUDE.md.bak', 'guides-other']) {
    assert.equal(fs.existsSync(path.join(f.out, relative)), false, relative);
  }
});

test('slashless deny entries exclude a directory and descendants but preserve neighbours', t => {
  const f = fixture(t);
  write(f.src, 'docs/research/deep/hidden.md', 'Excluded descendant\n');
  write(f.src, 'docs/research-other/visible.md', 'Visible neighbour\n');
  const allowFile = path.join(f.src, 'maintainer/public-tree.allow');
  fs.writeFileSync(allowFile, fs.readFileSync(allowFile, 'utf8').replace('!docs/research/\n', '!docs/research\n'));
  commit(f.src);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.out, 'docs/research')), false);
  assert.equal(fs.readFileSync(path.join(f.out, 'docs/research-other/visible.md'), 'utf8'), 'Visible neighbour\n');
});

test('overlays replace archived counterparts and their source directory is always denied', t => {
  const f = fixture(t);
  write(f.src, 'maintainer/public-overlay/CLAUDE.md', 'Uncommitted overlay\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.out, 'CLAUDE.md'), 'utf8'), 'Public contributor guide\n');
  assert.equal(fs.readFileSync(path.join(f.out, 'docs/guide.md'), 'utf8'), 'Public guide\n');
  assert.equal(fs.existsSync(path.join(f.out, 'maintainer/public-overlay')), false);
});

test('overlay targets outside the allowlist fail before being copied', t => {
  for (const target of ['extras/hidden.md', 'CLAUDE.md.bak']) {
    const f = fixture(t);
    write(f.src, `maintainer/public-overlay/${target}`, 'Excluded overlay\n');
    commit(f.src);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(`overlay target is not allowed: ${target}`), result.stderr);
    assert.equal(fs.existsSync(path.join(f.out, target)), false);
    assert.doesNotMatch(result.stdout, /^tree /m);
  }
});

test('overlay targets denied by the allowlist fail before being copied', t => {
  for (const target of ['docs/research/planted.md', 'docs/blocked.md']) {
    const f = fixture(t);
    fs.appendFileSync(path.join(f.src, 'maintainer/public-tree.allow'), '!docs/blocked.md\n');
    write(f.src, `maintainer/public-overlay/${target}`, 'Denied overlay\n');
    commit(f.src);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(`overlay target is not allowed: ${target}`), result.stderr);
    assert.equal(fs.existsSync(path.join(f.out, target)), false);
    assert.doesNotMatch(result.stdout, /^tree /m);
  }
});

test('unmatched allow entries fail clearly while unmatched denies are permitted', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.src, 'maintainer/public-tree.allow'), 'missing/\n');
  commit(f.src);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /allowlist entry matches nothing: missing\//);
  assert.doesNotMatch(result.stdout, /^tree /m);
});

test('slashless stale allow entries fail even when sibling files exist', t => {
  const f = fixture(t);
  write(f.src, 'stale.md.bak', 'Sibling of missing entry\n');
  fs.appendFileSync(path.join(f.src, 'maintainer/public-tree.allow'), 'stale.md\n');
  commit(f.src);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /allowlist entry matches nothing: stale\.md/);
  assert.equal(fs.existsSync(f.out), false);
  assert.doesNotMatch(result.stdout, /^tree /m);
});

test('non-empty output is refused with exit 2 without deleting or overwriting', t => {
  const f = fixture(t);
  write(f.out, '.sentinel', 'Keep this\n');
  const result = f.run();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /non-empty/);
  assert.deepEqual(fs.readdirSync(f.out), ['.sentinel']);
  assert.equal(fs.readFileSync(path.join(f.out, '.sentinel'), 'utf8'), 'Keep this\n');
});

test('allowed symlinks fail instead of reading files outside the archive', t => {
  for (const relative of ['README.md', 'maintainer/public-tree.allow']) {
    const f = fixture(t);
    const external = write(f.root, 'external', '../outside/\n');
    fs.unlinkSync(path.join(f.src, relative));
    fs.symlinkSync(external, path.join(f.src, relative));
    commit(f.src);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /unsupported archive file:/);
    assert.doesNotMatch(result.stdout, /^tree /m);
  }
});

test('empty output is accepted and the single main commit has explicit public identities', t => {
  const f = fixture(t);
  fs.mkdirSync(f.out);
  const config = write(f.root, 'global.gitconfig', `[user]\n\tname = Company User\n\temail = ${COMPANY_EMAIL}\n[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${path.join(f.root, 'hooks')}\n\tautocrlf = true\n`);
  write(f.root, 'hooks/pre-commit', '#!/bin/sh\nexit 99\n');
  fs.chmodSync(path.join(f.root, 'hooks/pre-commit'), 0o755);
  const result = f.run([], {
    GIT_CONFIG_GLOBAL: config, GIT_AUTHOR_NAME: 'Company User', GIT_AUTHOR_EMAIL: COMPANY_EMAIL,
    GIT_COMMITTER_NAME: 'Company User', GIT_COMMITTER_EMAIL: COMPANY_EMAIL,
    GIT_DIR: path.join(f.root, 'wrong-git-dir'), GIT_WORK_TREE: path.join(f.root, 'wrong-work-tree'),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(f.out, 'branch', '--show-current'), 'main');
  assert.equal(git(f.out, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(f.out, 'log', '--format=%an%n%ae%n%cn%n%ce'), `Ryo Ochi\n${EMAIL}\nRyo Ochi\n${EMAIL}`);
  assert.equal(git(f.out, 'log', '--format=%B'), 'Initial public release tree');
  assert.equal(fs.readFileSync(path.join(f.out, 'README.md'), 'utf8'), 'Committed readme\n');
});

function identityWrapper(f) {
  const bin = path.join(f.root, 'bin');
  const script = write(f.root, 'bin/git', `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nconst args = process.argv.slice(2);\nif (args.includes('log') && args.some(arg => arg.includes('%ae'))) {\n  const emails = [${JSON.stringify(EMAIL)}, ${JSON.stringify(EMAIL)}];\n  emails[Number(process.env.SPOOF_IDENTITY)] = ['dev', 'example-co.test'].join('@');\n  process.stdout.write(emails.join('\\n') + '\\n');\n} else {\n  const result = spawnSync(${JSON.stringify(GIT)}, args, { stdio: 'inherit', env: process.env });\n  process.exit(result.status === null ? 1 : result.status);\n}\n`);
  fs.chmodSync(script, 0o755);
  return bin;
}

test('identity gate rejects either a foreign author or a foreign committer', t => {
  for (const index of [0, 1]) {
    const f = fixture(t);
    const bin = identityWrapper(f);
    const result = f.run([], { PATH: `${bin}:${process.env.PATH}`, SPOOF_IDENTITY: String(index) });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^identity: FAIL$/m);
    assert.match(result.stderr, /unexpected author or committer/);
    assert.doesNotMatch(result.stdout, /^tree /m);
  }
});

test('operator gate rejects every prohibited path even when explicitly allowlisted', t => {
  for (const relative of ['backlog/x', 'profiles/x', 'specs/x', 'var/x', 'rstaff.json',
    'HANDOFF.md', 'LEARNINGS.md', 'docs/research/x', '.claude/x']) {
    const f = fixture(t);
    write(f.src, relative, 'Planted operator state\n');
    const allowFile = path.join(f.src, 'maintainer/public-tree.allow');
    let entries = fs.readFileSync(allowFile, 'utf8');
    if (relative.startsWith('docs/research/')) entries = entries.replace('!docs/research/\n', '');
    fs.writeFileSync(allowFile, `${entries}${relative}\n`);
    commit(f.src);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^operator paths: FAIL$/m);
    assert.match(result.stderr, /operator path present:/);
    assert.doesNotMatch(result.stdout, /^tree /m);
  }
});

test('leak gate scans root files with replacement hashes and opaque labels', t => {
  const f = fixture(t);
  write(f.src, 'README.md', 'prefixZQXFOOsuffix\n');
  commit(f.src);
  const entry = hashTerm('zqxfoo');
  const terms = write(f.root, 'terms.json', JSON.stringify({ lengths: [entry.length], sha256: [entry.sha256] }));
  const result = f.run(['--terms', terms]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^leak-scan: FAIL$/m);
  assert.match(result.stdout, /^README.md:1 private-term#0$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /zqxfoo/i);
  assert.doesNotMatch(result.stdout, /^tree /m);
});

test('leak gate scans dot-paths admitted by the allowlist', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.src, 'maintainer/public-tree.allow'), '.github/\n');
  write(f.src, '.github/x.yml', 'prefixZQXFOOsuffix\n');
  commit(f.src);
  const entry = hashTerm('zqxfoo');
  const terms = write(f.root, 'terms.json', JSON.stringify({ lengths: [entry.length], sha256: [entry.sha256] }));
  const result = f.run(['--terms', terms]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^leak-scan: FAIL$/m);
  assert.match(result.stdout, /^\.github\/x\.yml:1 private-term#0$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /zqxfoo/i);
  assert.doesNotMatch(result.stdout, /^tree /m);
});

function isolatedPath(f) {
  const bin = path.join(f.root, 'isolated-bin');
  fs.mkdirSync(bin);
  for (const command of ['git', 'tar', 'make', 'env']) {
    const executable = spawnSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(executable, path.join(bin, command));
  }
  return bin;
}

test('verify unsets operator home and reports absent strict validation as SKIPPED', t => {
  const f = fixture(t);
  const result = f.run(['--verify'], { PATH: isolatedPath(f), RSTAFF_HOME: path.join(f.root, 'operator') });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /verified-fixture/);
  assert.match(result.stdout, /^verify: PASS$/m);
  assert.match(result.stdout, /^strict validate: SKIPPED$/m);
  assert.doesNotMatch(result.stdout, /strict validate: PASS/);
});

test('a failed verify gate exits 1 and prints no success receipt', t => {
  const f = fixture(t);
  write(f.src, 'Makefile', 'verify:\n\t@exit 7\n');
  commit(f.src);
  const result = f.run(['--verify'], { PATH: isolatedPath(f) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^verify: FAIL$/m);
  assert.doesNotMatch(result.stdout, /^tree /m);
});

test('default source is the repository containing the builder', t => {
  const f = fixture(t);
  for (const file of ['build-public-tree.js', 'leak-scan.js', 'leak-terms.json']) {
    fs.copyFileSync(path.join(ROOT, 'maintainer', file), path.join(f.src, 'maintainer', file));
  }
  commit(f.src);
  const result = spawnSync(process.execPath, [path.join(f.src, 'maintainer/build-public-tree.js'), '--out', f.out], {
    cwd: f.root, encoding: 'utf8', env: cleanEnv(),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.out, 'README.md'), 'utf8'), 'Committed readme\n');
});

test('v1 allowlist matches the contracted public prefixes and denies', () => {
  const entries = fs.readFileSync(path.join(ROOT, 'maintainer/public-tree.allow'), 'utf8')
    .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.deepEqual(entries, ['.claude-plugin/', '.github/', '.gitignore', 'AGENTS.md', 'CHANGELOG.md',
    'CLAUDE.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'LICENSE', 'Makefile', 'README.md',
    'SECURITY.md', 'THIRD_PARTY.md', 'docs/', 'install/', 'maintainer/',
    'plugins/', 'test/', '!docs/research/', '!maintainer/public-overlay/']);
});

test('make selects whole-tree leaks only without operator config and routes public-tree', t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(ROOT, 'Makefile'), path.join(f.root, 'Makefile'));
  const make = (...args) => spawnSync('make', ['-n', '-C', f.root, ...args], { encoding: 'utf8', env: cleanEnv() });
  const publicVerify = make('verify');
  assert.equal(publicVerify.status, 0, publicVerify.stdout + publicVerify.stderr);
  assert.match(publicVerify.stdout, /^node maintainer\/leak-scan\.js --all$/m);
  write(f.root, 'rstaff.json', '{}\n');
  const privateVerify = make('verify');
  assert.equal(privateVerify.status, 0, privateVerify.stdout + privateVerify.stderr);
  assert.match(privateVerify.stdout, /^node maintainer\/leak-scan\.js\s*$/m);
  const publicTree = make('public-tree', 'OUT=example-output');
  assert.equal(publicTree.status, 0, publicTree.stdout + publicTree.stderr);
  assert.match(publicTree.stdout, /node maintainer\/build-public-tree\.js --out ['"]example-output['"] --verify/);
});
