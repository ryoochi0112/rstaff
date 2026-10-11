#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const HASHED_TERMS = require('./leak-terms.json');

const ALLOWLIST = ['ryoochi0112'];
const MODEL_ID = /\b(?:gpt-\d+(?:\.\d+)?-[a-z0-9][a-z0-9._-]*|o\d+(?:-[a-z0-9][a-z0-9._-]*)?|claude-[a-z0-9][a-z0-9._-]*|gemini-[a-z0-9][a-z0-9._-]*|deepseek-[a-z0-9][a-z0-9._-]*|llama-[a-z0-9][a-z0-9._-]*|mistral-[a-z0-9][a-z0-9._-]*|qwen-[a-z0-9][a-z0-9._-]*)\b/gi;
const TERMS = [
  [['/Users', 'ryoochi'].join('/'), /\/Users\/ryoochi/gi],
  ['PROCESS-', /\bPROCESS-\d+\b/gi],
  ['SKILL-', /\bSKILL-\d+\b/gi],
  ['LEARNINGS L', /\bLEARNINGS\s+L\d+\b/gi],
];
const TICKET_PREFIXES = ['PROCESS', 'SKILL', 'TP', 'FEAT', 'MAINT', 'EXP', 'BLK', 'OD', 'SPIKE', 'INTEGRATION', 'AP', 'AI', 'DS', 'PM', 'ENG'];
const TICKET_ID = new RegExp(`\\b(${TICKET_PREFIXES.join('|')})-\\d+\\b`, 'gi');
const EMAIL = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const PUBLIC_EMAIL_DOMAINS = new Set(['users.noreply.github.com', 'example.invalid']);

function sha256(text) {
  return crypto.hash ? crypto.hash('sha256', text, 'hex')
    : crypto.createHash('sha256').update(text).digest('hex');
}

function hashTerm(term) {
  const lower = term.toLowerCase();
  return { length: lower.length, sha256: sha256(lower) };
}

function hashedMatches(text, lengths, hashes, labels, wordBounded) {
  const matches = new Set();
  const lower = text.toLowerCase();
  for (const length of lengths) {
    for (let start = 0; start + length <= lower.length; start++) {
      const digest = sha256(lower.slice(start, start + length));
      if (!hashes.has(digest)) continue;
      if (wordBounded.has(digest)
        && (/(?<=[\p{L}\p{N}_])$/u.test(lower.slice(0, start))
          || /^[\p{L}\p{N}_]/u.test(lower.slice(start + length)))) continue;
      matches.add(`private-term#${labels.get(digest)}`);
    }
  }
  return matches;
}

function maskAllowlisted(text, lengths, hashes, labels, wordBounded) {
  let masked = text;
  for (const value of ALLOWLIST) {
    masked = masked.replace(new RegExp(value, 'gi'), (match) => ' '.repeat(match.length));
  }
  return masked.replace(MODEL_ID, (match) => {
    TICKET_ID.lastIndex = 0;
    return TICKET_ID.test(match)
      || TERMS.some(([, pattern]) => { pattern.lastIndex = 0; return pattern.test(match); })
      || hashedMatches(match, lengths, hashes, labels, wordBounded).size
      ? match : ' '.repeat(match.length);
  });
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    return null;
  }
}

function collectFiles(dir, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, files);
    else if (entry.isFile()) files.push(full);
  }
}

// Overrides replace the seed table; termsFile takes precedence over an injected table.
function scan(root, { all = false, hashedTerms = HASHED_TERMS, termsFile } = {}) {
  if (termsFile) hashedTerms = JSON.parse(fs.readFileSync(termsFile, 'utf8'));
  const base = path.resolve(root || process.cwd());
  const files = [];
  if (all) collectFiles(base, files);
  else {
    collectFiles(path.join(base, 'plugins'), files);
    const marketplace = path.join(base, '.claude-plugin', 'marketplace.json');
    if (fs.existsSync(marketplace) && fs.statSync(marketplace).isFile()) files.push(marketplace);
  }

  const lengths = [...new Set(hashedTerms.lengths)];
  const hashes = new Set(hashedTerms.sha256);
  const labels = new Map(hashedTerms.sha256.map((digest, index) => [digest, index]));
  const wordBounded = new Set(hashedTerms.wordBounded || []);
  const hits = [];
  for (const file of files.sort()) {
    const text = decodeText(fs.readFileSync(file));
    if (text === null) continue;
    const relative = path.relative(base, file).split(path.sep).join('/');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const searchable = maskAllowlisted(line, lengths, hashes, labels, wordBounded);
      const terms = hashedMatches(searchable, lengths, hashes, labels, wordBounded);
      for (const [term, pattern] of TERMS) {
        pattern.lastIndex = 0;
        if (pattern.test(searchable)) terms.add(term);
      }
      TICKET_ID.lastIndex = 0;
      for (const match of searchable.matchAll(TICKET_ID)) terms.add(`${match[1].toUpperCase()}-`);
      for (const match of line.matchAll(EMAIL)) {
        if (!PUBLIC_EMAIL_DOMAINS.has(match[1].toLowerCase())) terms.add('@company-email');
      }
      for (const term of terms) hits.push({ file: relative, line: index + 1, term });
    });
  }
  return hits;
}

function formatHits(hits) {
  return hits.map(hit => `${hit.file}:${hit.line} ${hit.term}\n`).join('');
}

function main(argv) {
  if (argv.length === 2 && argv[0] === '--hash') {
    process.stdout.write(`${JSON.stringify(hashTerm(argv[1]))}\n`);
    return 0;
  }
  let root = process.cwd();
  let all = false;
  let hasRoot = false;
  let termsFile;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--all' && !all) all = true;
    else if (argv[index] === '--root' && !hasRoot && argv[index + 1]
      && !argv[index + 1].startsWith('--')) {
      root = argv[++index];
      hasRoot = true;
    } else if (argv[index] === '--terms' && !termsFile && argv[index + 1]
      && !argv[index + 1].startsWith('--')) {
      termsFile = argv[++index];
    } else {
      process.stderr.write('Usage: node maintainer/leak-scan.js [--root <dir>] [--all] [--terms <file>] | --hash <term>\n');
      return 2;
    }
  }

  const hits = scan(root, { all, termsFile });
  if (hits.length) {
    process.stdout.write(formatHits(hits));
    return 1;
  }
  process.stdout.write(`leak-scan: no hits in ${all ? 'all files' : 'plugins/** or .claude-plugin/marketplace.json'}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { scan, hashTerm, formatHits };
