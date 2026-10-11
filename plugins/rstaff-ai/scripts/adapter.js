'use strict';

const fs = require('node:fs');

function readAdapters(text) {
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex(line => line === '## experiment.adapters');
  if (heading === -1) return null;

  for (let i = heading + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) return null;

    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!opening) continue;

    const marker = opening[2];
    const markerChar = marker[0];
    const markerLength = marker.length;
    const info = opening[3].trim();
    let closing = -1;

    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].startsWith('## ')) return null;
      const close = new RegExp(`^ {0,3}${markerChar}{${markerLength},}\\s*$`);
      if (close.test(lines[j])) {
        closing = j;
        break;
      }
    }
    if (closing === -1) return null;
    if (info === 'json') return JSON.parse(lines.slice(i + 1, closing).join('\n'));
    i = closing;
  }

  return null;
}

function selectAdapter(adapters, name) {
  const names = Object.keys(adapters);
  const available = names.join(', ');

  if (name !== undefined) {
    if (!Object.hasOwn(adapters, name)) {
      throw new Error(`adapter ${name} not declared (have: ${available})`);
    }
    return { name, entry: adapters[name] };
  }

  if (names.length === 1) return { name: names[0], entry: adapters[names[0]] };

  const defaults = names.filter(adapterName => adapters[adapterName]
    && adapters[adapterName].default === true);
  if (defaults.length === 1) {
    return { name: defaults[0], entry: adapters[defaults[0]] };
  }
  if (defaults.length > 1) {
    throw new Error(`multiple default adapters declared (have: ${available})`);
  }
  if (names.length > 1) {
    throw new Error(`adapter required (have: ${available})`);
  }
  throw new Error(`no adapters declared (have: ${available})`);
}

function main(args) {
  if (args.length < 1 || args.length > 3
    || (args.length > 1 && (args[1] !== '--adapter' || args.length !== 3))) {
    throw new Error('usage: node adapter.js <profile.md> [--adapter <name>]');
  }

  const profile = args[0];
  const adapterName = args.length === 3 ? args[2] : undefined;
  const adapters = readAdapters(fs.readFileSync(profile, 'utf8'));
  if (adapters === null) {
    process.stderr.write(`no experiment.adapters entry in ${profile}\n`);
    process.exitCode = 1;
    return;
  }

  const selected = selectAdapter(adapters, adapterName);
  process.stdout.write(`${JSON.stringify({ name: selected.name, ...selected.entry })}\n`);
}

module.exports = { readAdapters, selectAdapter };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
