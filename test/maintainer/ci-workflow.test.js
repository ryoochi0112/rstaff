'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { readWorkflow, check, WorkflowSyntaxError } = require('../../maintainer/ci-workflow.js');

const CLI = path.join(__dirname, '../../maintainer/ci-workflow.js');
const GOOD = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - name: Set up Node
        uses: actions/setup-node@v7
        with:
          node-version: '24'
      - name: make check
        run: make check
`;

function assertCriteria(text, failed = []) {
  const results = check(readWorkflow(text));
  assert.deepEqual(results.map(({ id, ok }) => ({ id, ok })),
    ['C1', 'C2', 'C3', 'C4'].map(id => ({ id, ok: !failed.includes(id) })));
  for (const result of results) assert.equal(typeof result.reason, 'string');
  for (const result of results.filter(result => !result.ok)) assert.ok(result.reason.length > 0);
}

test('repository workflow passes all four criteria', () => {
  assertCriteria(fs.readFileSync(path.join(__dirname, '../../.github/workflows/ci.yml'), 'utf8'));
});

test('reader preserves ordered steps, scalar quotes, flow lists and permissions', () => {
  const text = GOOD.replace('branches: [main]', 'branches: [release, main]')
    .replace('run: make check', 'run: "make verify --flag"')
    .replace('    steps:', '    permissions:\n      contents: \'read\'\n    steps:');
  assert.deepEqual(readWorkflow(`\n# comment\n${text.replace(/\n/g, '\r\n')}`), {
    on: { push: { branches: ['release', 'main'] }, pull_request: { branches: ['main'] } },
    permissions: { contents: 'read' },
    jobs: [{ id: 'check', name: '', runsOn: 'ubuntu-24.04', permissions: { contents: 'read' }, steps: [
      { name: '', uses: 'actions/checkout@v7', run: '', with: { 'persist-credentials': 'false' } },
      { name: 'Set up Node', uses: 'actions/setup-node@v7', run: '', with: { 'node-version': '24' } },
      { name: 'make check', uses: '', run: 'make verify --flag', with: {} },
    ] }],
  });
  assertCriteria(text, ['C2']);
  assertCriteria(GOOD.replace("node-version: '24'", 'node-version: 22'));
  assertCriteria(GOOD.replace("node-version: '24'", 'node-version: "24"'));
  assertCriteria(GOOD.replace('run: make check', 'run: make verify'));
});

test('reader keeps the job name scalar', () => {
  const repositoryWorkflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  assert.equal(readWorkflow(repositoryWorkflow).jobs[0].name, 'make check (plugin verify)');
  assert.equal(readWorkflow(GOOD).jobs[0].name, '');
  assert.equal(readWorkflow(GOOD.replace('    runs-on:', "    name: 'a # b'\n    runs-on:")).jobs[0].name, 'a # b');
  assert.throws(() => readWorkflow(GOOD.replace('    runs-on:', '    name:\n    runs-on:')), WorkflowSyntaxError);
  assert.throws(() => readWorkflow(GOOD.replace('    runs-on:', '    name: [x]\n    runs-on:')), WorkflowSyntaxError);
});

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

test('reader strips trailing comments the way YAML does', () => {
  const steps = text => readWorkflow(text).jobs[0].steps;
  assert.equal(steps(GOOD.replace('actions/checkout@v7', `actions/checkout@${SHA} # v7`))[0].uses,
    `actions/checkout@${SHA}`);
  const commented = GOOD.replace('run: make check', 'run: make check # x');
  assert.equal(steps(commented)[2].run, 'make check');
  assertCriteria(commented);
  assertCriteria(GOOD.replace('run: make check', 'run: make check#x'), ['C2']);
  assert.equal(steps(GOOD.replace('name: make check', "name: 'a # b'"))[2].name, 'a # b');
  const node = GOOD.replace("node-version: '24'", "node-version: '24' # lts");
  assert.equal(steps(node)[1].with['node-version'], '24');
  assertCriteria(node);
  assert.deepEqual(readWorkflow(GOOD.replace('branches: [main]', 'branches: [main] # c')).on.push.branches, ['main']);
  assert.equal(steps(GOOD.replace('    steps:', '    steps: # c')).length, 3);
  assert.throws(() => readWorkflow(GOOD.replace("node-version: '24'", "node-version: '24' x")),
    error => error instanceof WorkflowSyntaxError && error.message === 'unsupported workflow syntax at line 19');
});

test('repository workflow pins every action by full commit SHA with a version comment', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  const uses = readWorkflow(text).jobs[0].steps.filter(step => step.uses).map(step => step.uses);
  assert.ok(uses.length >= 2);
  for (const ref of uses) assert.match(ref, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/);
  const lines = text.split(/\r?\n/).filter(line => /^\s*(?:- )?uses:/.test(line));
  assert.equal(lines.length, uses.length);
  for (const line of lines) assert.match(line, /@[0-9a-f]{40} # v\d+$/);
});

const failures = [
  ['C1', 'missing push', GOOD.replace('  push:\n    branches: [main]\n', '')],
  ['C1', 'missing pull_request', GOOD.replace('  pull_request:\n    branches: [main]\n', '')],
  ['C1', 'missing on', GOOD.replace(/on:\n(?:  .*\n|    .*\n)+/, '')],
  ['C1', 'push excludes main', GOOD.replace('branches: [main]', 'branches: [release]')],
  ['C1', 'pull_request excludes main', GOOD.replace('  pull_request:\n    branches: [main]', '  pull_request:\n    branches: []')],
  ['C1', 'missing branches', GOOD.replace('    branches: [main]\n', '')],
  ['C2', 'missing verify command', GOOD.replace('run: make check', 'run: echo check')],
  ['C2', 'command prefix differs', GOOD.replace('run: make check', 'run: echo make check')],
  ['C2', 'target suffix differs', GOOD.replace('run: make check', 'run: make checker')],
  ...['make check || true', 'make check; true', 'make check && true', 'make check | cat',
    'make check & true', 'make check -i', 'make verify $(true)', 'make check ; true'].map(value =>
    ['C2', `command ${value}`, GOOD.replace('run: make check', `run: ${value}`)]),
  ['C2', 'verify before checkout', GOOD.replace('      - uses: actions/checkout@v7', '      - run: make check\n      - uses: actions/checkout@v7').replace('        run: make check\n', '        run: echo done\n')],
  ['C2', 'missing checkout', GOOD.replace('actions/checkout@v7', 'example/checkout@v7')],
  ['C2', 'missing setup-node', GOOD.replace('actions/setup-node@v7', 'example/setup-node@v7')],
  ['C2', 'missing node-version', GOOD.replace("          node-version: '24'\n", '')],
  ...['lts/*', 'latest', 'node', '22.x', '>=22', '', 'v24', '24.0'].map(value =>
    ['C2', `node-version ${JSON.stringify(value)}`, GOOD.replace("node-version: '24'", `node-version: '${value}'`)]),
  ...['ubuntu-latest', 'windows-latest', 'macos-15', 'ubuntu-24.4', 'ubuntu-024.04', 'prefixubuntu-24.04', 'ubuntu-24.04suffix'].map(value =>
    ['C3', `runner ${value}`, GOOD.replace('ubuntu-24.04', value)]),
  ['C3', 'missing runner', GOOD.replace('    runs-on: ubuntu-24.04\n', '')],
  ['C4', 'secret in comment', `${GOOD}# secrets.TOKEN\n`],
  ['C4', 'API key in comment', `${GOOD}# ANTHROPIC_API_KEY\n`],
  ['C4', 'evals in run', GOOD.replace('        run: make check\n', '        run: make check\n      - run: make evals\n')],
  ['C4', 'model call in run', GOOD.replace('        run: make check\n', '        run: make check\n      - run: claude prompt\n')],
  ...['claude', '/usr/bin/claude -p x', 'claude; echo'].map(value =>
    ['C4', `model call ${value}`, GOOD.replace('        run: make check\n', `        run: make check\n      - run: ${value}\n`)]),
  ['C4', 'missing permissions', GOOD.replace('permissions:\n  contents: read\n', '')],
  ['C4', 'empty permissions', GOOD.replace('  contents: read\n', '')],
  ['C4', 'scalar permissions', GOOD.replace('permissions:\n  contents: read', 'permissions: write-all')],
  ['C4', 'contents write', GOOD.replace('contents: read', 'contents: write')],
  ['C4', 'extra permission', GOOD.replace('  contents: read', '  contents: read\n  issues: read')],
  ['C4', 'wrong permission key', GOOD.replace('contents: read', 'issues: read')],
  ...['      contents: write', '      issues: read', '      contents: read\n      issues: read', ''].map(value =>
    ['C4', `job permissions ${JSON.stringify(value)}`, GOOD.replace('    steps:', `    permissions:\n${value}\n    steps:`)]),
  ['C4', 'scalar job permissions', GOOD.replace('    steps:', '    permissions: write-all\n    steps:')],
];

for (const [id, description, text] of failures) {
  test(`${id} rejects ${description} only`, () => assertCriteria(text, [id]));
}

test('C4 rejects a model call followed by a tab', () => {
  const workflow = readWorkflow(GOOD);
  workflow.jobs[0].steps.push({ name: '', uses: '', run: 'claude\t-p', with: {} });
  assert.equal(check(workflow).find(result => result.id === 'C4').ok, false);
});

test('C3 rejects an expression runner', () => {
  const workflow = readWorkflow(GOOD);
  workflow.jobs[0].runsOn = '${{ matrix.os }}';
  assert.deepEqual(check(workflow).map(result => result.ok), [true, true, false, true]);
});

const syntax = [
  ['tab', 'name:\tCI', 1],
  ['tab in comment', '#\tcomment', 1],
  ['odd indentation', ' name: CI', 1],
  ['literal block', 'name: |', 1],
  ['folded block', 'name: >', 1],
  ['anchor', 'name: &value', 1],
  ['alias', 'name: *value', 1],
  ['merge key', '<<: value', 1],
  ['document start', '---', 1],
  ['document end', '...', 1],
  ['flow mapping', 'name: {value}', 1],
  ['quoted mapping', 'name: "{value}"', 1],
  ['single quoted key', "'name': CI", 1],
  ['double quoted key', '"name": CI', 1],
  ['invalid key', 'na.me: CI', 1],
  ['indent jump', '    name: CI', 1],
  ['continuation', 'name: CI\n  continued', 2],
  ['run continuation', GOOD.replace('        run: make check', '        run: make check\n          echo continued'), 22],
  ['second job', `${GOOD}  other:\n    runs-on: ubuntu-24.04`, 22],
  ['no job', 'jobs:', 1],
  ['list outside steps', '- name: CI', 1],
  ['step without list marker', GOOD.replace('      - uses:', '      uses:'), 13],
  ['duplicate key', 'name: CI\nname: other', 2],
  ['unknown section', 'env:\n  key: value', 1],
  ['malformed flow list', 'on:\n  push:\n    branches: [main', 3],
  ['quoted flow item', "on:\n  push:\n    branches: ['main']", 3],
  ['unclosed quote', "name: 'CI", 1],
  ['escaped quote', "name: 'can''t'", 1],
  ['nested with value', GOOD.replace("          node-version: '24'", '          node-version:\n            major: 24'), 19],
  ['expression', GOOD.replace('ubuntu-24.04', '${{ matrix.os }}'), 11],
];

for (const [description, text, line] of syntax) {
  test(`reader rejects ${description} at line ${line}`, () => {
    const fixture = description === 'no job' || text.includes('jobs:') ? text : `${text}\n${GOOD}`;
    assert.throws(() => readWorkflow(fixture), error => error instanceof WorkflowSyntaxError
      && error.name === 'WorkflowSyntaxError'
      && error.message === `unsupported workflow syntax at line ${line}`);
  });
}

function invoke(t, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ci-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'workflow.yml');
  fs.writeFileSync(file, text);
  return spawnSync(process.execPath, [CLI, 'check', file], { encoding: 'utf8' });
}

test('CLI prints four PASS lines and exits 0', t => {
  const result = invoke(t, GOOD);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'C1: PASS\nC2: PASS\nC3: PASS\nC4: PASS\n');
  assert.equal(result.stderr, '');
});

test('CLI prints the failing reason and exits 1', t => {
  const result = invoke(t, GOOD.replace('ubuntu-24.04', 'ubuntu-latest'));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^C1: PASS\nC2: PASS\nC3: FAIL .+\nC4: PASS\n$/);
  assert.equal(result.stderr, '');
});

test('CLI syntax error exits 2 with line number on stderr', t => {
  const result = invoke(t, '# comment\n---\n');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'unsupported workflow syntax at line 2\n');
});

test('CLI usage errors exit 2', () => {
  for (const args of [[], ['check'], ['run'], ['run', '.', '--bad'], ['check', 'file', 'extra'], ['check', '--bad']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage:/);
  }
});

const TERM = 'zzcanaryzz';
const { hashTerm } = require('../../maintainer/leak-scan.js');

function gitFixture(root, args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  }
  const result = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function runFixture(t, commands, { repo = false, term = TERM, edit = text => text } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ci-executor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  const steps = '      - name: make check\n        run: make check\n' + commands.map((command, index) =>
    `      - name: step ${index}\n        run: ${command}\n`).join('');
  fs.writeFileSync(path.join(root, '.github/workflows/ci.yml'), edit(GOOD.replace(
    '      - name: make check\n        run: make check\n', steps)));
  fs.writeFileSync(path.join(root, 'Makefile'), 'check:\n\t@true\n');
  fs.mkdirSync(path.join(root, 'maintainer'));
  const terms = path.join(root, 'maintainer/leak-terms.json');
  fs.writeFileSync(terms, JSON.stringify({ lengths: [term.length], sha256: [hashTerm(term).sha256] }));
  if (repo) {
    gitFixture(root, ['init', '-q']);
    gitFixture(root, ['add', '.']);
    gitFixture(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  }
  return { root, terms };
}

function runCLI(root, args = [], env = {}) {
  return spawnSync(process.execPath, [CLI, 'run', root, ...args], {
    env: { ...process.env, RSTAFF_PLANT_TERM: '', ...env }, encoding: 'utf8',
  });
}

function nodeCommand(code) {
  // Fixtures use only double quotes for the shell and single quotes inside JS.
  return `node -e "${code}"`;
}

function scanner(relpath = 'docs/PLANTED.md', { line = `${relpath}:1 private-term#0`, code = 2, echo = false } = {}) {
  return nodeCommand(`if (require('fs').readFileSync('${relpath}', 'utf8').includes(process.env.RSTAFF_PLANT_TERM)) `
    + `[console.log('${line}'), ${echo ? "console.log(process.env.RSTAFF_PLANT_TERM + process.env.RSTAFF_PLANT_TERM.toUpperCase()), console.error(process.env.RSTAFF_PLANT_TERM), " : ''}process.exit(${code})]`);
}

function plantCLI(fixture, relpath = 'docs/PLANTED.md', env = {}) {
  return runCLI(fixture.root, ['--plant', relpath, '--terms', fixture.terms], { RSTAFF_PLANT_TERM: TERM, ...env });
}

test('run executes steps in file order, captures both streams and skips actions', t => {
  const fixture = runFixture(t, ['first', 'second'].map(value => nodeCommand(
    `require('fs').appendFileSync('order', '${value}\\n'); console.log('${value}'); console.error('err ${value}')`)));
  const result = runCLI(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'order'), 'utf8'), 'first\nsecond\n');
  assert.match(result.stdout, /step "actions\/checkout@v7": skipped \(uses\)/);
  assert.match(result.stdout, /step "Set up Node": skipped \(uses\)/);
  assert.match(result.stdout, /first\nerr first\nstep "step 0": exit 0\nsecond\nerr second\nstep "step 1": exit 0\n$/);
});

test('run stops at the first failure and propagates its exit code', t => {
  const fixture = runFixture(t, [nodeCommand("console.log('before'); process.exit(3)"),
    nodeCommand("require('fs').writeFileSync('after', 'bad')")]);
  const result = runCLI(fixture.root);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /before\nstep "step 0": exit 3\n$/);
  assert.ok(!result.stdout.includes('step 1'));
  assert.ok(!fs.existsSync(path.join(fixture.root, 'after')));
});

test('run removes RSTAFF_HOME and sets CI=true for each step', t => {
  const command = nodeCommand("console.log(String('RSTAFF_HOME' in process.env) + ':' + process.env.CI)");
  const fixture = runFixture(t, [command, command]);
  const result = runCLI(fixture.root, [], { RSTAFF_HOME: 'should disappear', CI: 'false' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('false:true\n').length, 3);
});

test('run uses bash errexit and pipefail', t => {
  for (const command of ['false | true', 'false; echo should-not-run']) {
    const fixture = runFixture(t, [command]);
    const result = runCLI(fixture.root);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(!result.stdout.includes('should-not-run'));
  }
});

for (const [name, edit, status] of [
  ['failed check', text => text.replace('ubuntu-24.04', 'ubuntu-latest'), 1],
  ['syntax error', text => `---\n${text}`, 2],
]) {
  test(`run rejects ${name} before executing any step`, t => {
    const fixture = runFixture(t, [nodeCommand("require('fs').writeFileSync('executed', 'bad')")], { edit });
    const result = runCLI(fixture.root);
    assert.equal(result.status, status);
    assert.ok(!fs.existsSync(path.join(fixture.root, 'executed')));
    assert.ok(!result.stdout.includes('step "'));
  });
}

test('plant detects the canary, redacts every occurrence in both streams and leaves original unchanged', t => {
  const fixture = runFixture(t, [scanner('docs/PLANTED.md', { echo: true }),
    nodeCommand("console.log('should-not-run')")], { repo: true });
  const result = plantCLI(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docs\/PLANTED\.md:1 private-term#0/);
  assert.match(result.stdout, /<planted><planted>\n<planted>\nstep "step 0": exit 2/);
  assert.match(result.stdout, /RESULT: red as expected \(planted term detected in non-plugin file\)\n$/);
  assert.ok(!(result.stdout + result.stderr).toLowerCase().includes(TERM));
  assert.ok(!result.stdout.includes('should-not-run'));
  assert.ok(!fs.existsSync(path.join(fixture.root, 'docs/PLANTED.md')));
  assert.equal(gitFixture(fixture.root, ['status', '--porcelain']), '');
});

test('plant defaults to docs/PLANTED.md and the tree terms file', t => {
  const fixture = runFixture(t, [scanner()], { repo: true });
  const result = runCLI(fixture.root, ['--plant'], { RSTAFF_PLANT_TERM: TERM });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT: red as expected/);
});

test('plant appends to a tracked file and removes the disposable clone after success or failure', t => {
  for (const code of [0, 2]) {
    const fixture = runFixture(t, [nodeCommand("console.log('clone-cwd=' + process.cwd()); console.log(require('fs').readFileSync('docs/existing.md', 'utf8'))"),
      scanner('docs/existing.md', { code })], { repo: true });
    fs.mkdirSync(path.join(fixture.root, 'docs'));
    fs.writeFileSync(path.join(fixture.root, 'docs/existing.md'), 'original\n');
    gitFixture(fixture.root, ['add', '.']);
    gitFixture(fixture.root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'tracked file']);
    const result = plantCLI(fixture, 'docs/existing.md');
    assert.equal(result.status, code === 0 ? 1 : 0, result.stderr);
    assert.match(result.stdout, /original\nplanted: <planted>/);
    assert.equal(fs.readFileSync(path.join(fixture.root, 'docs/existing.md'), 'utf8'), 'original\n');
    const clone = /clone-cwd=(.+)/.exec(result.stdout)[1];
    assert.ok(!fs.existsSync(path.dirname(clone)));
  }
});

test('plant green steps fail the verdict even with a scanner line', t => {
  const fixture = runFixture(t, [scanner('docs/PLANTED.md', { code: 0 })], { repo: true });
  const result = plantCLI(fixture);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /RESULT: FAIL all steps exited 0\n$/);
});

for (const line of ['unrelated failure', 'other.md:1 private-term#0',
  'prefix docs/PLANTED.md:1 private-term#0', 'docs/PLANTED.md:1 private-term#0 suffix',
  'docs/PLANTEDXmd:1 private-term#0', 'docs/PLANTED.md:x private-term#0', 'docs/PLANTED.md:1 private-term#x']) {
  test(`plant refuses unrelated or malformed scanner output: ${line}`, t => {
    const fixture = runFixture(t, [scanner('docs/PLANTED.md', { line })], { repo: true });
    const result = plantCLI(fixture);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /RESULT: FAIL no leak-scan line for docs\/PLANTED\.md\n$/);
  });
}

for (const relpath of ['plugins/x.md', './plugins/x.md', '/abs', '../x', 'docs/../x', 'Plugins/x.md', 'PLUGINS/x.md', './Plugins/x.md']) {
  test(`plant refuses unsafe path ${relpath}`, t => {
    const fixture = runFixture(t, [nodeCommand("console.log('executed')")], { repo: true });
    const result = plantCLI(fixture, relpath);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /plant path/);
    assert.ok(!result.stdout.includes('executed'));
  });
}

test('plant refuses an empty term', t => {
  const fixture = runFixture(t, [scanner()], { repo: true });
  const result = plantCLI(fixture, 'docs/PLANTED.md', { RSTAFF_PLANT_TERM: '' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /plant term is empty/);
});

test('plant refuses unknown hashes before executing steps without printing the term', t => {
  const fixture = runFixture(t, [scanner()], { repo: true });
  fs.writeFileSync(fixture.terms, '{"lengths":[],"sha256":[]}');
  const result = plantCLI(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /hash is absent/);
  assert.ok(!(result.stdout + result.stderr).includes(TERM));
  assert.ok(!result.stdout.includes('step "'));
});

test('plant refuses a non-git tree', t => {
  const fixture = runFixture(t, [scanner()]);
  const result = plantCLI(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /git repository/);
});

test('plant rejects symlinks without writing outside the clone', t => {
  const fixture = runFixture(t, [scanner()], { repo: true });
  const outside = path.join(fixture.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(fixture.root, 'docs'));
  gitFixture(fixture.root, ['add', 'docs']);
  gitFixture(fixture.root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'symlink']);
  const result = plantCLI(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('plant redaction treats regex punctuation literally', t => {
  const term = 'zz.canary+zz';
  const fixture = runFixture(t, [scanner('docs/PLANTED.md', { echo: true })], { repo: true, term });
  const result = plantCLI(fixture, 'docs/PLANTED.md', { RSTAFF_PLANT_TERM: term });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(result.stdout + result.stderr).toLowerCase().includes(term));
  assert.match(result.stdout, /<planted><planted>/);
});

test('run rejects duplicate or incomplete flags', () => {
  for (const args of [['--plant', 'docs/a', '--plant', 'docs/b'], ['--terms'],
    ['--terms', 'a', '--terms', 'b'], ['--unknown']]) {
    const result = runCLI('.', args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Usage:/);
  }
});

test('plant escapes regex metacharacters in the scanner path', t => {
  const relpath = 'docs/canary+[1].md';
  const fixture = runFixture(t, [scanner(relpath)], { repo: true });
  const result = plantCLI(fixture, relpath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT: red as expected/);
});

test('plant sanitizes preparation errors and step names', t => {
  const fixture = runFixture(t, [scanner('docs/PLANTED.md', { echo: true })], {
    repo: true, edit: text => text.replace('name: step 0', `name: ${TERM.toUpperCase()}`),
  });
  const success = plantCLI(fixture);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /step "<planted>": exit 2/);
  const failure = runCLI(fixture.root, ['--plant', 'docs/PLANTED.md', '--terms', path.join(fixture.root, TERM)],
    { RSTAFF_PLANT_TERM: TERM });
  assert.equal(failure.status, 2);
  assert.ok(!(failure.stdout + failure.stderr).toLowerCase().includes(TERM));
  assert.ok(!failure.stdout.includes('step "'));
});

test('plant refuses a dangling file symlink and cleans up on preparation failure', t => {
  const fixture = runFixture(t, [scanner()], { repo: true });
  fs.mkdirSync(path.join(fixture.root, 'docs'));
  const destination = path.join(fixture.root, 'outside.md');
  fs.symlinkSync(destination, path.join(fixture.root, 'docs/PLANTED.md'));
  gitFixture(fixture.root, ['add', 'docs']);
  gitFixture(fixture.root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'dangling symlink']);
  const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('rstaff-ci-plant-')).sort();
  const result = plantCLI(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /symlink/);
  assert.ok(!fs.existsSync(destination));
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('rstaff-ci-plant-')).sort(), before);
});
