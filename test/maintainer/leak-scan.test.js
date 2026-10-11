'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { scan, hashTerm } = require('../../maintainer/leak-scan.js');
const HASHED_TERMS = require('../../maintainer/leak-terms.json');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'maintainer', 'leak-scan.js');
const identifier = (type, number) => [type, number].join('-');
const learning = ['LEARNINGS', 'L09'].join(' ');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-leak-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'plugins', 'sample'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), '{}\n');
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8' });
}

function table(...terms) {
  const entries = terms.map(hashTerm);
  return {
    lengths: [...new Set(entries.map(entry => entry.length))].sort((a, b) => a - b),
    sha256: entries.map(entry => entry.sha256),
  };
}

const cases = [
  [['/Users', 'ryoochi'].join('/'), ['/users', 'RYOOCHI'].join('/')],
  ['PROCESS-', identifier('pRoCeSs', '042')],
  ['SKILL-', identifier('sKiLl', '019')],
  ['TP-', identifier('TP', '123')],
  ['LEARNINGS L', ['lEaRnInGs', 'L09'].join(' ')],
];

for (const [term, content] of cases) {
  test(`leak scan reports ${term} with file and line`, t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'plugins', 'sample', 'fixture.md'), `first line\n${content}\n`);
    assert.deepEqual(scan(root), [{ file: 'plugins/sample/fixture.md', line: 2, term }]);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, `plugins/sample/fixture.md:2 ${term}\n`);
  });
}

test('hashTerm lowercases before hashing and reports the normalized length', () => {
  assert.deepEqual(hashTerm('ZqXfOo'), {
    length: 6,
    sha256: createHash('sha256').update('zqxfoo').digest('hex'),
  });
});

test('seed table contains valid unique digests, sorted distinct lengths, and a word-bounded subset', () => {
  assert.deepEqual(Object.keys(HASHED_TERMS).sort(), ['lengths', 'sha256', 'wordBounded']);
  assert.ok(HASHED_TERMS.sha256.length > 0);
  assert.equal(new Set(HASHED_TERMS.sha256).size, HASHED_TERMS.sha256.length);
  assert.ok(HASHED_TERMS.sha256.every(digest => /^[a-f0-9]{64}$/.test(digest)));
  assert.ok(HASHED_TERMS.lengths.length > 0);
  assert.ok(HASHED_TERMS.lengths.every(length => Number.isInteger(length) && length > 0));
  assert.deepEqual(HASHED_TERMS.lengths, [...new Set(HASHED_TERMS.lengths)].sort((a, b) => a - b));
  assert.equal(new Set(HASHED_TERMS.wordBounded).size, HASHED_TERMS.wordBounded.length);
  assert.ok(HASHED_TERMS.wordBounded.every(digest => HASHED_TERMS.sha256.includes(digest)));
});

for (const [kind, content] of [
  ['exact', 'zqxfoo'],
  ['case variant', 'ZqXfOo'],
  ['embedded substring', 'prefixZQXFOOsuffix'],
]) {
  test(`hashed terms catch an ${kind} with an opaque label`, t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'plugins', 'sample', 'fixture.md'), `first line\n${content}\n`);
    assert.deepEqual(scan(root, { hashedTerms: table('zqxfoo') }), [
      { file: 'plugins/sample/fixture.md', line: 2, term: 'private-term#0' },
    ]);
  });
}

test('hashed terms scan distinct lengths and report each digest once per line', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'fixture.md'), 'zqxfoo vjk 178302 zqxfoo\n');
  const hashedTerms = table('zqxfoo', 'vjk', '7830');
  hashedTerms.lengths.push(6);
  assert.deepEqual(scan(root, { hashedTerms }).map(hit => hit.term).sort(), [
    'private-term#0', 'private-term#1', 'private-term#2',
  ]);
});

test('word-bounded hashes catch whole tokens with their original index labels', t => {
  const root = fixture(t);
  const hashedTerms = table('zqxfoo', 'zqxv');
  hashedTerms.wordBounded = [hashTerm('zqxv').sha256];
  const lines = ['zqxv', '(ZQXV)', '🙂zqxv🙂', 'zqxfoo'];
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'bounded.md'), lines.join('\n'));
  assert.deepEqual(scan(root, { hashedTerms }), [
    { file: 'plugins/sample/bounded.md', line: 1, term: 'private-term#1' },
    { file: 'plugins/sample/bounded.md', line: 2, term: 'private-term#1' },
    { file: 'plugins/sample/bounded.md', line: 3, term: 'private-term#1' },
    { file: 'plugins/sample/bounded.md', line: 4, term: 'private-term#0' },
  ]);
});

test('word-bounded hashes ignore adjacent Unicode letters, numbers, and underscores', t => {
  const root = fixture(t);
  const hashedTerms = table('zqxv');
  hashedTerms.wordBounded = [hashTerm('zqxv').sha256];
  const lines = ['prefixzqxvsuffix', ...['a', '0', '_', 'é', '中', '٣', '𐐀', '𝟙']
    .flatMap(character => [`${character}zqxv`, `zqxv${character}`])];
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'bounded.md'), lines.join('\n'));
  assert.deepEqual(scan(root, { hashedTerms }), []);
});

test('ticket detection ignores standards and unrelated uppercase prefixes', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'standards.md'), [
    identifier('ISO', '8601'), identifier('UTF', '8'), identifier('SHA', '256'),
    identifier('TASK', '1'), identifier('OTHER', '42'), 'ISO-8601',
  ].join('\n'));
  assert.deepEqual(scan(root), []);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('ticket detection catches every real prefix even inside model identifiers', t => {
  const root = fixture(t);
  const prefixes = ['PROCESS', 'SKILL', 'TP', 'FEAT', 'MAINT', 'EXP', 'BLK', 'OD', 'SPIKE', 'INTEGRATION', 'AP', 'AI', 'DS', 'PM', 'ENG'];
  const lines = prefixes.flatMap(prefix => [identifier(prefix, '1'), `gpt-6.1-${identifier(prefix, '1')}`]);
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'tickets.md'), lines.join('\n'));
  assert.deepEqual(scan(root), prefixes.flatMap((prefix, index) => [
    { file: 'plugins/sample/tickets.md', line: index * 2 + 1, term: `${prefix}-` },
    { file: 'plugins/sample/tickets.md', line: index * 2 + 2, term: `${prefix}-` },
  ]));
});

test('termsFile loads replacement hashes and their boundary rules', t => {
  const root = fixture(t);
  const termsFile = path.join(root, 'override.json');
  const hashedTerms = table('zqxfoo', 'zqxv');
  hashedTerms.wordBounded = [hashTerm('zqxv').sha256];
  fs.writeFileSync(termsFile, JSON.stringify(hashedTerms));
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'fixture.md'), 'vjk\nprefixzqxfoosuffix\nzqxv\nazqxv\n');
  assert.deepEqual(scan(root, { termsFile, hashedTerms: table('vjk') }), [
    { file: 'plugins/sample/fixture.md', line: 2, term: 'private-term#0' },
    { file: 'plugins/sample/fixture.md', line: 3, term: 'private-term#1' },
  ]);
});

test('--terms replaces the default table and reports clean and hit exit codes', t => {
  const root = fixture(t);
  const copiedCLI = path.join(root, 'leak-scan.js');
  fs.copyFileSync(CLI, copiedCLI);
  fs.writeFileSync(path.join(root, 'leak-terms.json'), JSON.stringify(table('vjk')));
  const hashedTerms = table('zqxfoo', 'zqxv');
  hashedTerms.wordBounded = [hashTerm('zqxv').sha256];
  const termsFile = path.join(root, 'override.json');
  fs.writeFileSync(termsFile, JSON.stringify(hashedTerms));
  const file = path.join(root, 'plugins', 'sample', 'fixture.md');
  fs.writeFileSync(file, 'vjk\nazqxv\n');
  const invoke = (...args) => spawnSync(process.execPath, [copiedCLI, '--root', root, ...args], { encoding: 'utf8' });
  const baseline = invoke();
  assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr);
  assert.equal(baseline.stdout, 'plugins/sample/fixture.md:1 private-term#0\n');
  const clean = invoke('--terms', termsFile);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /no hits/);
  fs.appendFileSync(file, 'prefixZQXFOOsuffix\nZQXV\n');
  const hit = invoke('--terms', termsFile);
  assert.equal(hit.status, 1, hit.stdout + hit.stderr);
  assert.equal(hit.stdout, 'plugins/sample/fixture.md:3 private-term#0\nplugins/sample/fixture.md:4 private-term#1\n');
});

test('leak scan includes the marketplace manifest', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ note: learning }));
  assert.deepEqual(scan(root), [{ file: '.claude-plugin/marketplace.json', line: 1, term: 'LEARNINGS L' }]);
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '.claude-plugin/marketplace.json:1 LEARNINGS L\n');
});

test('allowlisted publisher does not produce hashed hits', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'publisher.md'), 'publisher: ryoochi0112\n');
  assert.deepEqual(scan(root, { hashedTerms: table('ryoochi') }), []);
});

test('clean model identifiers do not produce ticket hits', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'models.md'), [
    'gpt-6.1-sol claude-opus-4-1 o1 o3-mini gemini-2.5-pro',
    'deepseek-v3 llama-3.3 mistral-large-2 qwen-2.5',
    'GPT-6.1-SOL CLAUDE-OPUS-4-1 GEMINI-2.5-PRO QWEN-2.5',
  ].join('\n'));
  assert.deepEqual(scan(root), []);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no hits/);
});

for (const id of ['gpt-5.6-zqxfoo', 'claude-zqxfoo-x', 'o1-zqxfoo']) {
  test(`model identifier ${id} still reports a hashed term`, t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'plugins', 'sample', 'models.md'), `model: ${id}\n`);
    assert.deepEqual(scan(root, { hashedTerms: table('zqxfoo') }), [
      { file: 'plugins/sample/models.md', line: 1, term: 'private-term#0' },
    ]);
  });
}

test('model identifiers containing existing ticket markers still produce hits', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'models.md'), `gpt-6.1-${identifier('PROCESS', '042')}\n`);
  assert.deepEqual(scan(root), [{ file: 'plugins/sample/models.md', line: 1, term: 'PROCESS-' }]);
});

test('learning and ticket identifiers require their whole token forms', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'tokens.md'), [
    `_${learning} ${learning}_suffix`,
    'PROCESS-abc PROCESS- SKILL- SKILL-01x TASK-01x',
  ].join('\n'));
  assert.deepEqual(scan(root), []);
});

for (const domain of ['acme.test', 'example.co.jp', 'example.invalid.acme.test']) {
  test(`email domain ${domain} produces a generic label`, t => {
    const root = fixture(t);
    const email = ['person', domain].join('@');
    fs.writeFileSync(path.join(root, 'plugins', 'sample', 'email.md'), `${email}\n`);
    assert.deepEqual(scan(root), [{ file: 'plugins/sample/email.md', line: 1, term: '@company-email' }]);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, 'plugins/sample/email.md:1 @company-email\n');
    assert.ok(!result.stdout.includes(email));
  });
}

test('public email domains are allowed without suppressing private hashes', t => {
  const root = fixture(t);
  const source = ['person', 'USERS.NOREPLY.GITHUB.COM'].join('@') + '\n'
    + ['zqxfoo', 'example.invalid'].join('@') + '\n';
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'email.md'), source);
  assert.deepEqual(scan(root), []);
  assert.deepEqual(scan(root, { hashedTerms: table('zqxfoo') }), [
    { file: 'plugins/sample/email.md', line: 2, term: 'private-term#0' },
  ]);
});

test('model and publisher masking cannot hide email addresses', t => {
  const root = fixture(t);
  const addresses = [
    ['gpt-6.1-sol', 'acme.test'],
    ['ryoochi0112', 'acme.test'],
    ['person', 'gemini-2.5.acme.test'],
  ].map(parts => parts.join('@'));
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'email.md'), addresses.join('\n'));
  assert.deepEqual(scan(root), addresses.map((_, index) => ({
    file: 'plugins/sample/email.md', line: index + 1, term: '@company-email',
  })));
});

test('default scope ignores root files and files outside plugins and the marketplace', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), `${learning}\n`);
  fs.writeFileSync(path.join(root, 'test', 'outside.md'), `${learning}\n`);
  fs.writeFileSync(path.join(root, 'plugins', 'sample', 'included.md'), `${learning}\n`);
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, 'plugins/sample/included.md:1 LEARNINGS L\n');
  assert.deepEqual(scan(root), [{ file: 'plugins/sample/included.md', line: 1, term: 'LEARNINGS L' }]);
});

test('--all includes root files and directories outside the default scope', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), `${learning}\n`);
  fs.writeFileSync(path.join(root, 'test', 'outside.md'), `${learning}\n`);
  assert.deepEqual(scan(root, { all: true }), [
    { file: 'README.md', line: 1, term: 'LEARNINGS L' },
    { file: 'test/outside.md', line: 1, term: 'LEARNINGS L' },
  ]);
  const result = run(root, '--all');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, 'README.md:1 LEARNINGS L\ntest/outside.md:1 LEARNINGS L\n');
  const reversed = spawnSync(process.execPath, [CLI, '--all', '--root', root], { encoding: 'utf8' });
  assert.equal(reversed.status, 1, reversed.stdout + reversed.stderr);
  assert.equal(reversed.stdout, result.stdout);
});

test('--all walks dot-directories and dot-files', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'x.yml'), `${learning}\n`);
  fs.writeFileSync(path.join(root, '.env.example'), `${learning}\n`);
  assert.deepEqual(scan(root, { all: true }), [
    { file: '.env.example', line: 1, term: 'LEARNINGS L' },
    { file: '.github/workflows/x.yml', line: 1, term: 'LEARNINGS L' },
  ]);
  const result = run(root, '--all');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '.env.example:1 LEARNINGS L\n.github/workflows/x.yml:1 LEARNINGS L\n');
  assert.deepEqual(scan(root), []);
});

test('--all skips git directories and dependencies at every depth', t => {
  const root = fixture(t);
  for (const relative of ['.git', 'node_modules', 'plugins/sample/.git', 'plugins/sample/node_modules']) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
    fs.writeFileSync(path.join(root, relative, 'ignored.md'), `${learning}\n`);
  }
  assert.deepEqual(scan(root, { all: true }), []);
  const result = run(root, '--all');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no hits in all files/);
});

test('binary and invalid UTF8 files are skipped', t => {
  const root = fixture(t);
  for (const [name, byte] of [['nul.bin', 0], ['invalid.bin', 0xff]]) {
    fs.writeFileSync(path.join(root, 'plugins', 'sample', name), Buffer.concat([Buffer.from([byte]), Buffer.from(learning)]));
  }
  assert.deepEqual(scan(root), []);
});

test('--hash prints a normalized digest entry', () => {
  const result = spawnSync(process.execPath, [CLI, '--hash', 'ZqXfOo'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    length: 6,
    sha256: createHash('sha256').update('zqxfoo').digest('hex'),
  });
});

test('CLI rejects incomplete, duplicate, and unknown options', () => {
  for (const args of [['--root'], ['--hash'], ['--all', '--all'], ['--root', '--all'], ['--unknown'],
    ['--terms'], ['--terms', '--all'], ['--terms', 'a.json', '--terms', 'b.json']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /Usage:/);
  }
});

test('public allowlist paths of the real repo have no leaks', t => {
  const entries = fs.readFileSync(path.join(ROOT, 'maintainer/public-tree.allow'), 'utf8')
    .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const allows = [];
  const overlay = 'maintainer/public-overlay/';
  const denies = [overlay];
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
  assert.ok(allows.length > 0, 'allowlist contains no allowed paths');
  const matches = (file, prefix) => prefix.endsWith('/') ? file.startsWith(prefix)
    : file === prefix || file.startsWith(prefix + '/');
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  const trackedFiles = tracked.stdout.split('\0').filter(Boolean);
  const files = trackedFiles.filter(file => allows.some(prefix => matches(file, prefix))
    && !denies.some(prefix => matches(file, prefix)));
  assert.ok(files.length > 100, `expected more than 100 public files, kept ${files.length}`);
  t.diagnostic(`kept public allowlist files: ${files.length}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-public-leak-scan-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  for (const relative of files) {
    const destination = path.join(scratch, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
  }
  const overlaySources = trackedFiles.filter(file => file.startsWith(overlay));
  let appliedOverlays = 0;
  for (const relative of overlaySources) {
    const target = relative.slice(overlay.length);
    assert.ok(!target.startsWith(overlay), 'overlay cannot contain its source directory');
    assert.ok(allows.some(prefix => matches(target, prefix))
      && !denies.some(prefix => matches(target, prefix)), `overlay target is not allowed: ${target}`);
    const destination = path.join(scratch, target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
    appliedOverlays++;
  }
  if (overlaySources.length > 0) {
    assert.equal(appliedOverlays, overlaySources.length, 'expected every tracked public overlay file to be applied');
  } else {
    t.diagnostic('no public overlay sources tracked; scanning tree as-is');
  }
  t.diagnostic(`applied public overlay files: ${appliedOverlays}`);
  const hits = scan(scratch, { all: true });
  assert.deepEqual(hits, [], `public allowlist leaks: ${JSON.stringify(hits)}`);
});

test('real plugin tree has no leaks', () => {
  const result = run(ROOT);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no hits/);
});
