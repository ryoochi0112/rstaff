#!/usr/bin/env node
// Consult ledger format: pure helpers followed by a thin file-writing CLI.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function slug(topic) {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function hashTopic(topic) {
  return crypto.createHash('sha1').update(topic).digest('hex').slice(0, 6);
}

function slugTopic(topic) {
  const base = slug(topic).slice(0, 60).replace(/-+$/, '');
  if (!base) return hashTopic(topic);
  if (base === topic.toLowerCase()) return base;
  return `${base.slice(0, 53).replace(/-+$/, '')}-${hashTopic(topic)}`;
}

function ledgerPath(ctrl, scope = '_new', topic) {
  const root = path.resolve(ctrl, 'var', 'consults');
  const scopeSlug = scope === '_new' ? scope : (slug(scope).slice(0, 60).replace(/-+$/, '') || hashTopic(scope));
  const file = path.resolve(root, scopeSlug, `${slugTopic(topic)}.md`);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('ledger path must stay inside var/consults/');
  }
  return file;
}

function initLedger({ topic, scope = '_new', goal = '', constraints = '', decided = '', known = '', date }) {
  return [
    `# Consult: ${topic}`, `- scope: ${scope}`, `- created: ${date}`,
    '- model: gpt-6-astra', '- thread: -', '- status: open',
    '## Goal', goal, '## Constraints', constraints, '## Definition of decided', decided,
    '## Known so far', known, '## Current conclusions', '-', '## Open questions', '-',
    '## Decisions', '-', '## Log', '',
  ].join('\n');
}

function splitLedger(text) {
  const marker = /^## Log\r?$/m.exec(text);
  if (!marker) throw new Error('ledger has no "## Log" line');
  return { header: text.slice(0, marker.index), log: text.slice(marker.index) };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readField(text, key) {
  const { header } = splitLedger(text);
  const match = new RegExp(`^- ${escapeRegex(key)}: ([^\\r\\n]*)\\r?$`, 'm').exec(header);
  return match ? match[1] : null;
}

function setHeader(text, { fields = {}, sections = {} } = {}) {
  let { header, log } = splitLedger(text);
  if (Object.prototype.hasOwnProperty.call(fields, 'thread')) {
    const t = fields.thread;
    if (t === null || t === undefined || String(t).trim() === '' || t === 'null') {
      throw new Error('setHeader: refusing empty thread id');
    }
  }
  for (const key of ['thread', 'status']) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    header = header.replace(new RegExp(`^- ${key}: [^\\r\\n]*`, 'm'), () => `- ${key}: ${fields[key]}`);
  }
  for (const name of ['Current conclusions', 'Open questions', 'Decisions']) {
    if (!Object.prototype.hasOwnProperty.call(sections, name)) continue;
    const pattern = new RegExp(`(^## ${name}\\r?\\n)[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm');
    header = header.replace(pattern, (_, heading) => `${heading}${String(sections[name]).replace(/\n+$/, '')}\n`);
  }
  return header + log;
}

function appendTurn(text, { n, at, effort, search, continuity, question, answer, reconcile, usage = {} }) {
  const { log } = splitLedger(text);
  const turn = n ?? (1 + (log.match(/^### T\d+ — /gm) || []).length);
  const input = usage.input ?? usage.inputTokens ?? 0;
  const cached = usage.cached ?? usage.cachedInputTokens ?? 0;
  const output = usage.output ?? usage.outputTokens ?? 0;
  const reasoning = usage.reasoning ?? usage.reasoningOutputTokens ?? 0;
  return text.replace(/\n+$/, '') + '\n' + [
    '', `### T${turn} — ${at} — effort=${effort} search=${search ? 'on' : 'off'} continuity=${continuity}`,
    `**Q:** ${question}`, '', '**Astra:**', answer, '', '**Reconcile (Claude):**', reconcile, '',
    `**Usage:** in=${input} cached=${cached} out=${output} reasoning=${reasoning}`, '',
  ].join('\n');
}

module.exports = { slugTopic, ledgerPath, initLedger, splitLedger, readField, setHeader, appendTurn };

// --- CLI ---------------------------------------------------------------
function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command };
  const flags = { '--ctrl': 'ctrl', '--scope': 'scope', '--topic': 'topic', '--file': 'file', '--json': 'json' };
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (!key) throw new Error(`unknown flag: ${rest[i]}`);
    if (i + 1 === rest.length) throw new Error(`missing value for ${rest[i]}`);
    opts[key] = rest[++i];
  }
  return opts;
}

function writeAtomic(file, text, create) {
  const dir = path.dirname(file);
  if (create) fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.consult-ledger-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

if (require.main === module) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.command === 'path') {
      if (!opts.ctrl || opts.topic === undefined) throw new Error('path requires --ctrl and --topic');
      process.stdout.write(ledgerPath(opts.ctrl, opts.scope, opts.topic) + '\n');
    } else {
      if (!['init', 'header', 'append'].includes(opts.command)) throw new Error('expected path, init, header or append');
      if (!opts.file || !opts.json) throw new Error(`${opts.command} requires --file and --json`);
      const file = path.resolve(opts.file);
      if (opts.command === 'init' && fs.existsSync(file)) throw new Error(`ledger already exists: ${file}`);
      const data = JSON.parse(fs.readFileSync(path.resolve(opts.json), 'utf8'));
      const text = opts.command === 'init' ? initLedger(data) :
        (opts.command === 'header' ? setHeader : appendTurn)(fs.readFileSync(file, 'utf8'), data);
      writeAtomic(file, text, opts.command === 'init');
    }
  } catch (e) {
    process.stderr.write(`consult-ledger: ${e.message}\n`);
    process.exitCode = 1;
  }
}
