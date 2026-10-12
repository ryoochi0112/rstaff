#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const rawTexts = new WeakMap();

class WorkflowSyntaxError extends Error {
  constructor(line) {
    super(`unsupported workflow syntax at line ${line}`);
    this.name = 'WorkflowSyntaxError';
  }
}

// A YAML comment starts at a `#` after whitespace, or after a closing quote or bracket.
function stripComment(raw) {
  if (raw.startsWith('#')) return '';
  const close = /^['"]/.test(raw) ? raw.indexOf(raw[0], 1) : raw.startsWith('[') ? raw.indexOf(']') : -2;
  if (close === -2) return raw.replace(/\s+#.*$/, '');
  return close > 0 && /^\s+#/.test(raw.slice(close + 1)) ? raw.slice(0, close + 1) : raw;
}

function readWorkflow(text) {
  const workflow = { on: {}, permissions: null, jobs: [] };
  const stack = [{ kind: 'root', indent: 0, target: workflow, seen: new Set() }];
  let jobsLine = 1;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fail = () => { throw new WorkflowSyntaxError(index + 1); };
    if (line.includes('\t')) fail();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent % 2) fail();
    while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
    let frame = stack[stack.length - 1];
    if (indent !== frame.indent) fail();
    const match = /^(?:(- )?)([A-Za-z0-9_-]+):(?: +(.*))?$/.exec(line.trim());
    if (!match) fail();
    const [, list, key, rawText = ''] = match;
    const raw = stripComment(rawText);
    if (raw.includes('{') || /^[|>&*]/.test(raw)) fail();
    let value = raw;
    if (/^['"]/.test(value)) {
      if (value.length < 2 || value.at(-1) !== value[0]
        || value.slice(1, -1).includes(value[0])) fail();
      value = value.slice(1, -1);
    } else if (value.startsWith('[')) {
      if (!/^\[\s*(?:[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)?\s*\]$/.test(value)) fail();
      value = value.slice(1, -1).trim();
      value = value ? value.split(/\s*,\s*/) : [];
    }
    if (frame.kind === 'steps') {
      if (!list) fail();
      const step = { name: '', uses: '', run: '', with: {} };
      frame.target.push(step);
      frame = { kind: 'step', indent: indent + 2, target: step, seen: new Set() };
      stack.push(frame);
    } else if (list) fail();
    if (frame.seen.has(key)) fail();
    frame.seen.add(key);
    const open = (kind, target) => stack.push({ kind, target,
      indent: frame.indent + 2, seen: new Set() });
    const scalar = () => {
      if (!raw || Array.isArray(value)) fail();
      Object.defineProperty(frame.target, key, { value, enumerable: true, writable: true, configurable: true });
    };
    if (frame.kind === 'root') {
      if (key === 'name') { if (!raw || Array.isArray(value)) fail(); }
      else if (key === 'on' && !raw) open('on', workflow.on);
      else if (key === 'jobs' && !raw) { jobsLine = index + 1; open('jobs', workflow.jobs); }
      else if (key === 'permissions') {
        workflow.permissions = raw ? value : {};
        if (Array.isArray(value)) fail();
        if (!raw) open('permissions', workflow.permissions);
      } else fail();
    } else if (frame.kind === 'on') {
      if (!['push', 'pull_request'].includes(key) || raw) fail();
      frame.target[key] = {};
      open('event', frame.target[key]);
    } else if (frame.kind === 'event') {
      if (key !== 'branches' || !Array.isArray(value)) fail();
      frame.target.branches = value;
    } else if (frame.kind === 'jobs') {
      if (raw || workflow.jobs.length) fail();
      const job = { id: key, name: '', runsOn: '', permissions: null, steps: [] };
      workflow.jobs.push(job);
      open('job', job);
    } else if (frame.kind === 'job') {
      if (key === 'runs-on') { scalar(); frame.target.runsOn = value; delete frame.target[key]; }
      else if (key === 'name') { if (!raw || Array.isArray(value)) fail(); frame.target.name = value; }
      else if (key === 'steps' && !raw) open('steps', frame.target.steps);
      else if (key === 'permissions') {
        if (Array.isArray(value)) fail();
        frame.target.permissions = raw ? value : {};
        if (!raw) open('permissions', frame.target.permissions);
      } else fail();
    } else if (frame.kind === 'step') {
      if (key === 'with' && !raw) open('with', frame.target.with);
      else if (['name', 'uses', 'run'].includes(key)) scalar();
      else fail();
    } else if (['permissions', 'with'].includes(frame.kind)) scalar();
    else fail();
  }
  if (workflow.jobs.length !== 1) throw new WorkflowSyntaxError(jobsLine);
  rawTexts.set(workflow, text);
  return workflow;
}

function check(workflow) {
  const job = workflow.jobs[0];
  const steps = job.steps;
  const readOnly = permissions => permissions !== null && typeof permissions === 'object'
    && Object.keys(permissions).length === 1 && permissions.contents === 'read';
  const conditions = [
    ['C1', workflow.on.push?.branches?.includes('main') === true
      && workflow.on.pull_request?.branches?.includes('main') === true,
    'push and pull_request must both target main'],
    ['C2', steps.some((step, index) => /^make (check|verify)$/.test(step.run)
      && steps.slice(0, index).some(previous => previous.uses.startsWith('actions/checkout@')))
      && steps.some(step => step.uses.startsWith('actions/setup-node@')
        && /^\d+$/.test(step.with['node-version'] || '')),
    'make check or verify must follow checkout; setup-node must use an integer major'],
    ['C3', /^ubuntu-[0-9]{2}\.[0-9]{2}$/.test(job.runsOn), 'runs-on must be a versioned Ubuntu image'],
    ['C4', !(rawTexts.get(workflow) || '').includes('secrets.')
      && !(rawTexts.get(workflow) || '').includes('ANTHROPIC_API_KEY')
      && !steps.some(step => step.run.includes('make evals'))
      && !steps.some(step => /\bclaude\b/.test(step.run))
      && readOnly(workflow.permissions)
      && (job.permissions === null || readOnly(job.permissions)),
    'no secrets or model calls; permissions must grant only contents: read'],
  ];
  return conditions.map(([id, ok, reason]) => ({ id, ok, reason: ok ? '' : reason }));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function executeSteps(workflow, tree, write) {
  const env = { ...process.env, CI: 'true' };
  delete env.RSTAFF_HOME;
  let output = '';
  for (const step of workflow.jobs[0].steps) {
    const name = step.name || step.uses;
    if (!step.run) {
      if (step.uses) write(`step "${name}": skipped (uses)\n`);
      continue;
    }
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run],
      { cwd: tree, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const captured = (result.stdout || '') + (result.stderr || '');
    output += captured;
    write(captured);
    const code = result.error ? 1 : (result.status ?? 1);
    write(`step "${name}": exit ${code}\n`);
    if (code !== 0) return { code, output };
  }
  return { code: 0, output };
}

class PlantError extends Error {}

function plant(workflow, tree, relpath, termsFile, write) {
  const term = process.env.RSTAFF_PLANT_TERM;
  if (!term) throw new PlantError('plant term is empty');
  if (path.isAbsolute(relpath) || relpath.split('/').includes('..')
    || path.posix.normalize(relpath).toLowerCase().startsWith('plugins/')) {
    throw new PlantError('plant path must be a relative non-plugin file without parent traversal');
  }
  const terms = JSON.parse(fs.readFileSync(termsFile || path.join(tree, 'maintainer/leak-terms.json'), 'utf8'));
  if (!Array.isArray(terms.sha256) || !terms.sha256.includes(require('./leak-scan.js').hashTerm(term).sha256)) {
    throw new PlantError('plant term hash is absent from terms file');
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  const repo = spawnSync('git', ['-C', tree, 'rev-parse', '--show-toplevel'], { env, encoding: 'utf8' });
  if (repo.error || repo.status !== 0 || fs.realpathSync(repo.stdout.trim()) !== fs.realpathSync(tree)) {
    throw new PlantError('plant tree must be a git repository root');
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-ci-plant-'));
  try {
    const clone = path.join(temporary, 'tree');
    const result = spawnSync('git', ['clone', '--quiet', tree, clone], { env, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new PlantError('plant clone failed');
    const destination = path.join(clone, relpath);
    // A tracked symlink must not redirect the plant outside the disposable clone.
    let current = clone;
    for (const segment of path.relative(clone, destination).split(path.sep)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new PlantError('plant path must not traverse a symlink');
      }
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.appendFileSync(destination, `planted: ${term}\n`);
    const executed = executeSteps(workflow, clone, write);
    const scanLine = new RegExp(`^${escapeRegex(relpath)}:\\d+ private-term#\\d+$`, 'm');
    if (executed.code !== 0 && scanLine.test(executed.output)) {
      write('RESULT: red as expected (planted term detected in non-plugin file)\n');
      return 0;
    }
    write(`RESULT: FAIL ${executed.code === 0 ? 'all steps exited 0' : `no leak-scan line for ${relpath}`}\n`);
    return 1;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main(argv) {
  const checking = argv[0] === 'check';
  const running = argv[0] === 'run';
  let relpath;
  let termsFile;
  let planted = false;
  let valid = argv.length >= 2 && !argv[1].startsWith('-') && (checking || running);
  if (checking && argv.length !== 2) valid = false;
  if (running) {
    for (let index = 2; index < argv.length; index++) {
      if (argv[index] === '--plant' && !planted) {
        planted = true;
        relpath = argv[index + 1] && !argv[index + 1].startsWith('--')
          ? argv[++index] : 'docs/PLANTED.md';
      } else if (argv[index] === '--terms' && !termsFile && argv[index + 1]
        && !argv[index + 1].startsWith('--')) termsFile = argv[++index];
      else valid = false;
    }
  }
  if (!valid) {
    process.stderr.write('Usage: node maintainer/ci-workflow.js check <workflow.yml> | run <tree> [--plant <relpath>] [--terms <file>]\n');
    return 2;
  }
  const term = planted ? process.env.RSTAFF_PLANT_TERM : '';
  const redact = value => term ? value.replace(new RegExp(escapeRegex(term), 'gi'), '<planted>') : value;
  const write = value => process.stdout.write(redact(value));
  try {
    const tree = path.resolve(argv[1]);
    const workflow = readWorkflow(fs.readFileSync(running ? path.join(tree, '.github/workflows/ci.yml') : argv[1], 'utf8'));
    const results = check(workflow);
    for (const result of results) {
      write(`${result.id}: ${result.ok ? 'PASS' : `FAIL ${result.reason}`}\n`);
    }
    if (!results.every(result => result.ok)) return 1;
    if (checking) return 0;
    return planted ? plant(workflow, tree, relpath, termsFile, write) : executeSteps(workflow, tree, write).code;
  } catch (error) {
    const message = planted && !(error instanceof WorkflowSyntaxError) && !(error instanceof PlantError)
      ? 'unable to prepare planted tree' : error.message;
    process.stderr.write(redact(`${message}\n`));
    return planted || error instanceof WorkflowSyntaxError ? 2 : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { readWorkflow, check, WorkflowSyntaxError, main };
