'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { readJsonl } = require('./grade.js');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--cases', '--split', '--arm', '--out', '--seed'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (options[flag] !== undefined) throw new Error(`duplicate argument: ${flag}`);
    options[flag] = value;
  }
  for (const flag of ['--cases', '--split', '--arm', '--out']) {
    if (!options[flag]) throw new Error(`required argument missing: ${flag}`);
  }
  if (!['control', 'candidate', 'both'].includes(options['--arm'])) {
    throw new Error('--arm must be control, candidate or both');
  }
  return options;
}

function shuffledPairs(cases, arm, seed) {
  const arms = arm === 'both' ? ['control', 'candidate'] : [arm];
  const pairs = cases.flatMap(item => arms.map(name => ({ ...item, arm: name })));
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  for (let i = pairs.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((state / 4294967296) * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return pairs;
}

function callClaude(item, model) {
  const argv = [
    '-p', '--model', model,
    '--system-prompt-file', path.join(__dirname, 'prompts', `${item.arm}.md`),
    '--tools', '', '--setting-sources', '', '--strict-mcp-config',
    '--no-session-persistence', '--disable-slash-commands', item.input,
  ];
  return new Promise(resolve => {
    const started = Date.now();
    const child = childProcess.spawn('claude', argv, {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000,
    });
    let stdout = '';
    let stderr = '';
    let failure = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', error => { failure = error.message; });
    child.on('close', (exit, signal) => {
      const ok = exit === 0 && failure === null && signal === null;
      const row = {
        id: item.id, arm: item.arm,
        reply: ok ? stdout.replace(/\n$/, '') : null,
        exit, ms: Date.now() - started, model,
      };
      if (!ok) row.stderr = (stderr + (failure || signal || '')).slice(-2000);
      resolve(row);
    });
  });
}

async function main(argv) {
  try {
    const options = parseArgs(argv);
    const concurrency = Number(process.env.RSTAFF_SAMPLE_CONCURRENCY || 4);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('RSTAFF_SAMPLE_CONCURRENCY must be a positive integer');
    }
    const cases = readJsonl(options['--cases']).filter(item => item.split === options['--split']);
    if (cases.length === 0 || new Set(cases.map(item => item.id)).size !== cases.length ||
        !cases.every(item => typeof item.id === 'string' && typeof item.input === 'string')) {
      throw new Error('split must contain distinct cases with string ids and inputs');
    }
    const pairs = shuffledPairs(cases, options['--arm'], options['--seed'] || 'sample-label-prompt');
    const model = process.env.RSTAFF_SAMPLE_MODEL || 'claude-haiku-4-5-20251001';
    const rows = new Array(pairs.length);
    let next = 0;
    async function worker() {
      while (next < pairs.length) {
        const index = next++;
        rows[index] = await callClaude(pairs[index], model);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, worker));
    fs.writeFileSync(options['--out'], rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    process.exitCode = rows.every(row => row.reply !== null) ? 0 : 1;
  } catch (error) {
    console.error(`run: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { parseArgs, shuffledPairs, callClaude };
if (require.main === module) main(process.argv.slice(2));
