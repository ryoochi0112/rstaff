'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const ADAPTER = path.join(ROOT, 'plugins/rstaff-ai/scripts/adapter.js');
const { readAdapters, selectAdapter } = require(ADAPTER);

function runAdapter(args) {
  return spawnSync(process.execPath, [ADAPTER, ...args], { encoding: 'utf8' });
}

function withProfile(text, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-profile-'));
  const profile = path.join(tempDir, 'profile.md');
  fs.writeFileSync(profile, text);
  try {
    callback(profile);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('readAdapters parses the JSON fence in the adapter section', () => {
  const profile = [
    '## Other section',
    '```json',
    '{"ignored":{}}',
    '```',
    '## experiment.adapters',
    '```text',
    '{"ignored":true}',
    '```',
    '```jsonc',
    '{"also-ignored":{}}',
    '```',
    '~~~json',
    '{"label-exact-match":{"default":true,"grader":"code"}}',
    '~~~',
    '## Next section',
    '```json',
    '{"later":{}}',
    '```',
  ].join('\n');

  assert.deepEqual(readAdapters(profile), {
    'label-exact-match': { default: true, grader: 'code' },
  });
});

test('readAdapters returns null when the heading or its JSON fence is missing', () => {
  assert.equal(readAdapters('## Other section\n```json\n{}\n```'), null);
  assert.equal(readAdapters('## experiment.adapters extra\n```json\n{"wrong":{}}\n```'), null);
  assert.equal(readAdapters('## experiment.adapters\nprose only'), null);
  assert.equal(readAdapters([
    '## experiment.adapters',
    'This section has no JSON fence.',
    '## Next section',
    '```json',
    '{"too-late":{}}',
    '```',
  ].join('\n')), null);
  assert.equal(readAdapters([
    '## experiment.adapters',
    '```text',
    'Unclosed block before the next heading.',
    '## Next section',
    '```',
    '```json',
    '{"too-late":{}}',
    '```',
  ].join('\n')), null);
  assert.equal(readAdapters([
    '## experiment.adapters',
    'No JSON fence here.',
    '## experiment.adapters',
    '```json',
    '{"second":{}}',
    '```',
  ].join('\n')), null);
  assert.equal(readAdapters('## experiment.adapters\n```json\n{"unterminated":{}}'), null);
});

test('readAdapters lets JSON.parse report invalid JSON', () => {
  let parseMessage;
  try {
    JSON.parse('{invalid}');
  } catch (error) {
    parseMessage = error.message;
  }

  assert.throws(
    () => readAdapters('## experiment.adapters\n```json\n{invalid}\n```'),
    error => error instanceof SyntaxError && error.message === parseMessage,
  );
});

test('selectAdapter chooses the only entry without requiring a default', () => {
  const entry = { grader: 'code' };
  assert.deepEqual(selectAdapter({ solo: entry }), { name: 'solo', entry });
});

test('selectAdapter chooses the single default among multiple entries', () => {
  const entry = { default: true, grader: 'code' };
  assert.deepEqual(selectAdapter({ first: { grader: 'code' }, chosen: entry }), {
    name: 'chosen',
    entry,
  });
});

test('selectAdapter rejects multiple defaults and multiple entries without a default', () => {
  assert.throws(
    () => selectAdapter({ first: { default: true }, second: { default: true } }),
    /multiple default adapters declared \(have: first, second\)/,
  );
  assert.throws(
    () => selectAdapter({ first: { default: 1 }, second: { default: 'true' } }),
    /adapter required \(have: first, second\)/,
  );
  assert.throws(() => selectAdapter({}), /no adapters declared \(have: \)/);
});

test('selectAdapter honors an explicit name and reports unknown names with the available list', () => {
  const entry = { grader: 'code' };
  assert.deepEqual(selectAdapter({ first: {}, chosen: entry }, 'chosen'), {
    name: 'chosen',
    entry,
  });
  assert.throws(
    () => selectAdapter({ first: {}, chosen: entry }, 'missing'),
    /adapter missing not declared \(have: first, chosen\)/,
  );
});

test('CLI prints the selected entry as JSON', () => {
  withProfile([
    '## experiment.adapters',
    '```json',
    '{"first":{"grader":"code"},"chosen":{"default":true,"grader":"code"}}',
    '```',
  ].join('\n'), profile => {
    const run = runAdapter([profile]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      name: 'chosen',
      default: true,
      grader: 'code',
    });
    assert.equal(run.stderr, '');

    const explicit = runAdapter([profile, '--adapter', 'first']);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout), { name: 'first', grader: 'code' });
  });

  withProfile([
    '## experiment.adapters',
    '```json',
    '{"solo":{"grader":"code"}}',
    '```',
  ].join('\n'), profile => {
    const run = runAdapter([profile]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { name: 'solo', grader: 'code' });
  });
});

test('CLI returns exit 1 with the profile named when the section is missing', () => {
  withProfile('## Other section\n', profile => {
    const run = runAdapter([profile]);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, `no experiment.adapters entry in ${profile}\n`);
  });

  withProfile('## experiment.adapters\nprose\n## Next section\n```json\n{}\n```', profile => {
    const run = runAdapter([profile]);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, `no experiment.adapters entry in ${profile}\n`);
  });
});

test('CLI returns exit 2 with the JSON parse message', () => {
  let parseMessage;
  try {
    JSON.parse('{invalid}');
  } catch (error) {
    parseMessage = error.message;
  }

  withProfile('## experiment.adapters\n```json\n{invalid}\n```', profile => {
    const run = runAdapter([profile]);
    assert.equal(run.status, 2);
    assert.equal(run.stderr, `${parseMessage}\n`);
  });
});

test('CLI reports unknown and ambiguous adapter selections with exit 2', () => {
  withProfile([
    '## experiment.adapters',
    '```json',
    '{"first":{"default":true},"second":{"default":true}}',
    '```',
  ].join('\n'), profile => {
    const unknown = runAdapter([profile, '--adapter', 'missing']);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, 'adapter missing not declared (have: first, second)\n');

    const ambiguous = runAdapter([profile]);
    assert.equal(ambiguous.status, 2);
    assert.equal(ambiguous.stderr, 'multiple default adapters declared (have: first, second)\n');
  });

  withProfile([
    '## experiment.adapters',
    '```json',
    '{"first":{},"second":{}}',
    '```',
  ].join('\n'), profile => {
    const missingDefault = runAdapter([profile]);
    assert.equal(missingDefault.status, 2);
    assert.equal(missingDefault.stderr, 'adapter required (have: first, second)\n');
  });
});

test('CLI reports usage for an incomplete invocation', () => {
  const noProfile = runAdapter([]);
  assert.equal(noProfile.status, 2);
  assert.equal(noProfile.stderr, 'usage: node adapter.js <profile.md> [--adapter <name>]\n');

  const noAdapterName = runAdapter(['/unused/profile.md', '--adapter']);
  assert.equal(noAdapterName.status, 2);
  assert.equal(noAdapterName.stderr, 'usage: node adapter.js <profile.md> [--adapter <name>]\n');

  const unknownOption = runAdapter(['/unused/profile.md', '--unknown', 'name']);
  assert.equal(unknownOption.status, 2);
  assert.equal(unknownOption.stderr, 'usage: node adapter.js <profile.md> [--adapter <name>]\n');

  const extraArguments = runAdapter(['/unused/profile.md', '--adapter', 'name', 'extra']);
  assert.equal(extraArguments.status, 2);
  assert.equal(extraArguments.stderr, 'usage: node adapter.js <profile.md> [--adapter <name>]\n');
});
