#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { slug } = require('../hooks/lib.js');
const usage = 'usage: setup.js --home <dir> (--product <path> [--verify "<cmd>"] | --name <token>)';

function detectVerify(product, override) {
  if (override !== undefined) return { verify: override, verifySource: '--verify', needsVerify: false };
  const makefile = path.join(product, 'Makefile');
  if (fs.existsSync(makefile) && /^[ \t]*verify[ \t]*:(?!=)/m.test(fs.readFileSync(makefile, 'utf8'))) {
    return { verify: 'make verify', verifySource: 'Makefile', needsVerify: false };
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(product, 'package.json'), 'utf8'));
    if (typeof pkg?.scripts?.verify === 'string' && pkg.scripts.verify.trim()) {
      return { verify: 'npm run verify', verifySource: 'package.json', needsVerify: false };
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const { notebooks, root, prefix } = countNotebooks(product);
  if (notebooks > 0) {
    const found = { verify: 'rstaff:nbgate', verifySource: 'notebooks', needsVerify: false, notebooks };
    if (prefix !== '') {
      found.verifyNote = `nbgate runs every notebook from the git top-level ${root}; the completion gate reads profiles/${slug(root)}.md`;
    }
    return found;
  }
  return { verify: null, verifySource: null, needsVerify: true };
}

// Notebooks under `product` (git-listed, ignore file not applied); count 0 when product is not in a git repo.
function countNotebooks(product) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const top = spawnSync('git', ['-C', product, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
  if (top.error || top.status !== 0 || !top.stdout.trim()) return { notebooks: 0 };
  const root = top.stdout.trim();
  const under = path.relative(fs.realpathSync(root), fs.realpathSync(product));
  const prefix = under ? under.split(path.sep).join('/') + '/' : '';
  const notebooks = require('./nbgate.js').listNotebooks(root, { ignoreFile: false })
    .filter(file => file.startsWith(prefix)).length;
  return { notebooks, root, prefix };
}

function renderProfile(product, verify, adapters) {
  const template = fs.readFileSync(path.join(__dirname, '../templates/profile.sample.md'), 'utf8');
  const profile = template.replaceAll('/absolute/path/to/repo', () => product)
    .replace(/^\*\*Verify \(DoD\):\*\*.*$/m, () => `**Verify (DoD):** \`${verify}\``);
  return adapters === undefined ? profile
    : profile + '\n## experiment.adapters\n```json\n' + JSON.stringify(adapters, null, 2) + '\n```\n';
}

function setup({ home, product, verify: override, name }) {
  const pm = name !== undefined;
  if (typeof home !== 'string' || !home.trim() || (pm && (product !== undefined || override !== undefined))
      || (!pm && (typeof product !== 'string' || !product.trim()))) {
    throw new Error(usage);
  }
  if (pm && (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name) || slug(name) !== name)) {
    throw new Error('--name must match ^[a-z0-9][a-z0-9-]*$ and satisfy slug(token) === token');
  }
  if (override !== undefined && (typeof override !== 'string' || !override.trim())) {
    throw new Error('--verify must be a non-empty command');
  }
  home = path.resolve(home);
  if (!pm) {
    product = path.resolve(product);
    name = path.basename(product);
    if (!name || !fs.statSync(product).isDirectory()) throw new Error('--product must name a directory');
  }
  const marker = path.join(home, 'rstaff.json');
  if (fs.existsSync(marker)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (_) { /* foreign marker */ }
    if (existing?.rstaff !== 'control-repo') throw new Error('refusing foreign rstaff.json in --home');
  }
  const detection = pm ? null : detectVerify(product, override);
  let adapters;
  if (!pm && fs.existsSync(path.join(product, 'rstaff-adapter.json'))) {
    try {
      adapters = JSON.parse(fs.readFileSync(path.join(product, 'rstaff-adapter.json'), 'utf8'));
    } catch (error) {
      throw new Error(`rstaff-adapter.json: ${error.message}`);
    }
    for (const entry of Object.values(adapters)) entry.cwd = product;
  }
  const profile = path.join(home, 'profiles', `${name}.md`);
  const result = pm ? { created: [], unchanged: [], mode: 'pm', backlog: `backlog/${name}.md` }
    : { created: [], unchanged: [], profile, ...detection };
  if (adapters !== undefined) result.adapters = Object.keys(adapters);
  fs.mkdirSync(home, { recursive: true });
  function directory(relative) {
    const target = path.join(home, relative);
    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isDirectory()) throw new Error(`${relative} must be a directory`);
      result.unchanged.push(relative + '/');
    } else {
      fs.mkdirSync(target);
      result.created.push(relative + '/');
    }
  }
  function file(relative, content) {
    try {
      fs.writeFileSync(path.join(home, relative), content, { flag: 'wx' });
      result.created.push(relative);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      result.unchanged.push(relative);
    }
  }
  const { version } = require('../.claude-plugin/plugin.json');
  file('rstaff.json', JSON.stringify({ rstaff: 'control-repo', version,
    layout: { profiles: './profiles', backlog: './backlog', var: './var' } }, null, 2) + '\n');
  directory('profiles');
  directory('backlog');
  if (pm) {
    file(result.backlog, `# Backlog — ${name}\n`);
  } else {
    file('backlog/.gitkeep', '');
    if (!detection.needsVerify) file(`profiles/${name}.md`, renderProfile(product, detection.verify, adapters));
  }
  const ignore = path.join(home, '.gitignore');
  if (!fs.existsSync(ignore)) {
    file('.gitignore', 'var/\n');
  } else {
    const content = fs.readFileSync(ignore, 'utf8');
    if (!/^var\/\r?$/m.test(content)) {
      fs.appendFileSync(ignore, (content && !content.endsWith('\n') ? '\n' : '') + 'var/\n');
      result.created.push('.gitignore (var/)');
    } else {
      result.unchanged.push('.gitignore');
    }
  }
  if (!fs.existsSync(path.join(home, '.git'))) {
    const git = spawnSync('git', ['init', home], { encoding: 'utf8' });
    if (git.error || git.status !== 0) throw new Error('git init failed: ' + (git.error?.message || git.stderr.trim()));
    result.created.push('git init');
  } else {
    result.unchanged.push('git init');
  }
  return result;
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--home', '--product', '--verify', '--name'].includes(key) || args[i + 1] === undefined
        || args[i + 1].startsWith('--') || Object.hasOwn(options, key.slice(2))) {
      throw new Error(usage);
    }
    options[key.slice(2)] = args[i + 1];
  }
  return options;
}

module.exports = { detectVerify, renderProfile, setup, parseArgs };
if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(setup(parseArgs(process.argv.slice(2)))) + '\n');
  } catch (error) {
    process.stderr.write(error.message.replace(/[\r\n]+/g, ' ') + '\n');
    process.exitCode = 1;
  }
}
