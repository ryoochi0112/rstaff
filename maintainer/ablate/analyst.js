'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runAnalyst(recordPath, rawDir, outDir) {
  const transcriptPath = path.join(outDir, 'analyst.jsonl');
  const agent = 'rstaff-ai:experiment-analyst';
  const prompt = `${recordPath} ${rawDir}`;
  const argv = ['-p', '--agent', agent, '--plugin-dir', 'plugins/rstaff-ai',
    '--output-format', 'stream-json', '--verbose', prompt];
  const invocationPath = path.join(outDir, 'analyst-invocation.json');
  fs.writeFileSync(invocationPath, JSON.stringify({ argv, agent, prompt }, null, 2) + '\n');
  // A file descriptor preserves the stream bytes without a capture buffer limit.
  const fd = fs.openSync(transcriptPath, 'w');
  try {
    spawnSync('claude', argv, { stdio: ['ignore', fd, 'inherit'] });
  } finally { fs.closeSync(fd); }
  let resultText = '';
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'result' && typeof event.result === 'string') resultText = event.result;
  }
  const lines = [...resultText.matchAll(/^(?:##\s*Experiment verdict:|verdict:)\s*(ACCEPT|REJECT|INCONCLUSIVE|INVALID-HARNESS)(?=\s|$).*$/gm)];
  return { verdict: lines.at(-1)?.[1] || 'NO-VERDICT', transcriptPath, invocationPath };
}

module.exports = { runAnalyst };
