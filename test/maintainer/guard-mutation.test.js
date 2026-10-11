'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const HOOKS = path.join(__dirname, '..', '..', 'plugins', 'rstaff', 'hooks');
const payloads = require(path.join(__dirname, '..', '..', 'maintainer', 'lib-guard-payloads.js'));
const corpora = [payloads.bashDeny, payloads.bashAsk, payloads.bashPass,
  payloads.secretDeny, payloads.secretClean];
const rows = new Map(corpora.flat().map((row) => [row.id, row]));

function withMutant(name, targetFile, replacements, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rstaff-guard-mutant-'));
  try {
    fs.copyFileSync(path.join(HOOKS, 'lib.js'), path.join(dir, 'lib.js'));
    const sourcePath = targetFile === 'hooks.json'
      ? path.join(HOOKS, 'hooks.json') : path.join(HOOKS, targetFile);
    const original = fs.readFileSync(sourcePath, 'utf8');
    const pairs = Array.isArray(replacements[0]) ? replacements : [replacements];
    const mutated = pairs.reduce((source, [from, to]) => {
      const replaced = source.replace(from, to);
      assert.notEqual(replaced, source, `${name}: mutation source must occur`);
      return replaced;
    }, original);
    assert.notEqual(mutated, original, `${name}: mutation source must occur`);
    fs.writeFileSync(path.join(dir, targetFile), mutated);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function decide(dir, script, args, event, timeout) {
  const started = performance.now();
  const r = spawnSync(process.execPath, [path.join(dir, script), ...(args || [])], {
    input: typeof event === 'string' ? event : JSON.stringify(event || {}),
    encoding: 'utf8', env: { PATH: process.env.PATH }, timeout,
  });
  let output = {};
  try { output = JSON.parse(r.stdout); } catch (_) {}
  const permission = output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision;
  const decision = permission || (output.decision === 'block' ? 'block'
    : (r.status === 0 && r.stdout === '' ? 'pass' : undefined));
  return { status: r.status, signal: r.signal, decision, elapsed: performance.now() - started };
}

const rowEvent = (row) => ({ tool_name: 'Bash', tool_input: { command: row.command } });
function expectedFor(id) {
  if (payloads.bashAsk.some((row) => row.id === id)) return 'ask';
  if (payloads.bashDeny.some((row) => row.id === id)
      || payloads.secretDeny.some((row) => row.id === id)) return 'deny';
  // A pass row can detect a widened rule too: the mutation must flip a pinned
  // pass result to ask/deny.
  if (payloads.bashPass.some((row) => row.id === id)
      || payloads.secretClean.some((row) => row.id === id)) return 'pass';
  throw new Error(`no expected decision for ${id}`);
}

const mutations = [
  { name: 'M01 delete the recursive extractShellBodies call', target: 'guard-bash.js',
    from: 'for (const extracted of extractShellBodies(normalized.stripped)) {',
    to: 'for (const extracted of []) {',
    reds: ['D18', 'D19', 'D20', 'D21', 'D23', 'D24', 'D25'] },
  { name: 'M02 drop eval from the extraction pattern', target: 'guard-bash.js',
    from: '|eval\\b((?:[ \\t]+', to: '|never\\b((?:[ \\t]+', reds: ['D20'] },
  { name: 'M03 set the depth cap to 1', target: 'guard-bash.js',
    from: 'const MAX_SHELL_BODY_DEPTH = 4;', to: 'const MAX_SHELL_BODY_DEPTH = 1;', reds: ['D21'] },
  { name: 'M04 remove the +refspec push rule', target: 'guard-bash.js',
    from: "  { push: /\\s\\+\\S/, why: 'force-push via +refspec (can overwrite remote history)' },\n",
    to: '', reds: ['A21', 'A46', 'A47'] },
  { name: 'M05 remove the :refspec push rule', target: 'guard-bash.js',
    from: "  { push: /\\s:\\S/, why: 'delete-refspec push (removes a remote branch)' },\n",
    to: '', reds: ['A22'] },
  { name: 'M06 make the lease strip also remove --force', target: 'guard-bash.js',
    from: 'const LEASE_RE = /(^|\\s)--force-with-lease(?:=\\S*)?(?=\\s|$)/g;',
    to: 'const LEASE_RE = /(^|\\s)--force(?:-with-lease(?:=\\S*)?)?(?=\\s|$)/g;',
    reds: ['A29', 'A36', 'A37', 'A42', 'A43', 'A44', 'A45', 'A48'] },
  { name: 'M07 remove the rm dequote normalization', target: 'guard-bash.js',
    from: '? [dequoteRmTargets(cmd), ...commands.slice(1).map((command) => command.rmNormalized)]',
    to: '? [cmd, ...commands.slice(1).map((command) => command.unquoted)]', reds: ['A23', 'A24', 'A53', 'A56'] },
  { name: 'M08 remove the ${IFS} rule', target: 'guard-bash.js',
    from: "  { re: /\\brm(?:\\$\\{?IFS\\}?)+-\\S*[rR]/, why: 'rm obfuscated with ${IFS} (recursive delete hidden from the flag scan)' },\n",
    to: '', reds: ['A25'] },
  { name: 'M09 remove the base64 -d | sh rule', target: 'guard-bash.js',
    from: "  { re: /\\|\\s*base64\\s+(?:-d|--decode)\\b[^\\n|]*\\|\\s*(?:sudo\\s+)?(?:ba|z|da|k)?sh\\b/, why: 'decoding base64 straight into a shell' },\n",
    to: '', reds: ['A26'] },
  { name: 'M10 remove the whole-tree checkout rule', target: 'guard-bash.js',
    from: "  { re: /\\bgit[ \\t]+checkout(?:(?:[ \\t]+--)?[ \\t]+\\.(?=[\\s;&|)]|$)|[ \\t]+\\S+[ \\t]+--[ \\t]+\\.(?=[\\s;&|)]|$))/, why: 'git checkout of the whole tree (discards every uncommitted change)' },\n",
    to: '', reds: ['A27', 'A49', 'A51', 'A54'] },
  { name: 'M11 remove the whole-tree restore rule', target: 'guard-bash.js',
    from: "  { re: /\\bgit\\s+restore(?:\\s+-\\S+)*\\s+\\.(?=[\\s;&|)]|$)/, why: 'git restore of the whole tree (discards every uncommitted change)' },\n",
    to: '', reds: ['A28', 'A50', 'A55'] },
  { name: 'M12 remove the branch -D rule', target: 'guard-bash.js',
    from: "  { re: /\\bgit\\s+branch(?=[^\\n]*(?:-D|--delete|--force|-d)(?=\\s|$))(?:\\s+-\\S+)*\\s+(?:-D|--delete\\s+--force|--force\\s+--delete|-d\\s+--force|--force\\s+-d)(?=\\s|$)/, why: 'force-deleting a branch (may lose unmerged commits)' },\n",
    to: '', reds: ['A30', 'A52'] },
  { name: 'M13 remove the force-push rule entirely', target: 'guard-bash.js',
    from: "  { push: /\\s(--force\\b|-f\\b)/, stripLease: true, why: 'force-push (can overwrite remote history)' },\n",
    to: '', reds: ['A29', 'A36', 'A37', 'A38', 'A39', 'A40', 'A41', 'A42', 'A43', 'A44', 'A45', 'A48'] },
  { name: 'M14 remove the continuation join', target: 'guard-bash.js',
    from: '.map((input) => foldQuotedNewlines(joinContinuations(input)))', to: '.map((input) => foldQuotedNewlines(input))',
    reds: ['A45', 'A46', 'A47'] },
  { name: 'M15 remove Bash from the hooks.json secret-scan matcher', target: 'hooks.json',
    from: '"Write|Edit|MultiEdit|Bash"', to: '"Write|Edit|MultiEdit"', reds: ['D22'] },
  { name: 'M16 remove tool_input.command from the secret-scan text join', target: 'secret-scan.js',
    from: ', ti.command]', to: ']', reds: ['D22'] },
  { name: 'M22 revert escaped-token folding in rm-scoped dequote', target: 'guard-bash.js',
    from: "  return text.replace(/'([^']*)'|\"((?:\\\\.|[^\"\\\\])*)\"|(?:\\\\.|[^'\"\\\\])+/g,\n"
      + '    (match, single, double) => {',
    to: "  return text.replace(/\\\\.|'([^']*)'|\"((?:\\\\.|[^\"\\\\])*)\"|[^'\"\\\\]+/g,\n"
      + "    (match, single, double) => {\n      if (match[0] === '\\\\') return match;",
    reds: ['A57'] },
  { name: 'M23 remove quoted rm command-word arming', target: 'guard-bash.js',
    from: 'if (/^rm$/.test(value)) rmActive = true;',
    to: '', reds: ['A58'] },
  { name: 'M24 disable the single-pass commit -n scan', target: 'guard-bash.js',
    from: '{ test: hasCommitShortNoVerify,', to: '{ test: () => false,',
    reds: ['D3', 'D4', 'D13', 'D26'] },
  { name: 'M25 remove the continuation join from the commit -n scan', target: 'guard-bash.js',
    from: 'joinContinuations(text).split(COMMIT_SEGMENT_SPLIT)', to: 'text.split(COMMIT_SEGMENT_SPLIT)',
    reds: ['D26'] },
  { name: 'M26 drop backslash parity from the continuation join', target: 'guard-bash.js',
    from: 'const CONTINUATION_RE = /(?<!\\\\)((?:\\\\\\\\)*)\\\\\\r?\\n/g;', to: 'const CONTINUATION_RE = /()\\\\\\r?\\n/g;',
    reds: ['P47'] },
  { name: 'M27 require push to follow git directly again', target: 'guard-bash.js',
    from: 'const GIT_PUSH_RE = new RegExp(String.raw`\\bgit(?:${GIT_GLOBAL_OPT}){0,16}\\s+push\\b`);',
    to: 'const GIT_PUSH_RE = /\\bgit\\s+push\\b/;',
    reds: ['A59', 'A60', 'A61'] },
  { name: 'M29 let a global option value swallow the push verb again', target: 'guard-bash.js',
    from: 'const GIT_GLOBAL_OPT = String.raw`\\s+-\\S+(?:\\s+(?!push\\b)[^-\\s]\\S*)?`;',
    to: 'const GIT_GLOBAL_OPT = String.raw`\\s+-\\S+(?:\\s+[^-\\s]\\S*)?`;',
    reds: ['A63'] },
  { name: 'M30 drop the global-option overflow rule', target: 'guard-bash.js',
    from: '{ re: GIT_OPTION_OVERFLOW_RE,', to: '{ re: /(?!)/,',
    reds: ['A64'] },
  { name: 'M31 stop dequoting a quoted git command word', target: 'guard-bash.js',
    from: "return text.replace(GIT_WORD_RE, '$1git');", to: 'return text;',
    reds: ['A65', 'A66'] },
  { name: 'M32 scan the overflow rule on the raw command instead of the push-tier form', target: 'guard-bash.js',
    from: 'd.push || d.git', to: 'd.push',
    reds: ['A67', 'A68'] },
  { name: 'M28 stop folding newlines inside quoted push arguments', target: 'guard-bash.js',
    from: '.map((input) => foldQuotedNewlines(joinContinuations(input)))', to: '.map((input) => joinContinuations(input))',
    reds: ['A62'] },
];

for (const mutation of mutations) {
  test(mutation.name, () => withMutant(mutation.name, mutation.target,
    [mutation.from, mutation.to], (dir) => {
      if (mutation.target === 'hooks.json') {
        const config = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
        const entry = config.hooks.PreToolUse.find((item) => item.hooks.some((hook) =>
          hook.command.includes('secret-scan.js" file')));
        assert.ok(entry, `${mutation.name}: secret-scan file hook must exist`);
        assert.equal(new RegExp(`^(?:${entry.matcher})$`).test('Bash'), false);
        return;
      }
      for (const id of mutation.reds) {
        const row = rows.get(id);
        const script = id === 'D22' ? 'secret-scan.js' : 'guard-bash.js';
        const args = id === 'D22' ? ['file'] : [];
        const result = decide(dir, script, args, rowEvent(row));
        assert.equal(result.status, 0, `${mutation.name} ${id}: mutant must not crash`);
        assert.notEqual(result.decision, expectedFor(id), `${mutation.name} ${id} must red`);
      }
    }));
}

test('M17 revert readEventStrict to the lenient reader', () => withMutant(
  'M17 revert readEventStrict to the lenient reader', 'guard-bash.js',
  ['const { event: ev, malformed } = readEventStrict();',
    "const { event: ev, malformed } = { event: require('./lib').readEvent(), malformed: false };"],
  (dir) => {
    const result = decide(dir, 'guard-bash.js', [], '{"tool_input":');
    assert.equal(result.status, 0);
    assert.equal(result.decision, 'pass');
  }));

test('M18 reintroduce a per-body continue at the cap', () => withMutant(
  'M18 reintroduce a per-body continue at the cap', 'guard-bash.js',
  ['      extractedBytes += Buffer.byteLength(extracted);',
    '      if (Buffer.byteLength(extracted) > 64 * 1024) continue;'],
  (dir) => {
    const command = `bash -c "${'x'.repeat(70 * 1024)}; git commit --no-${'verify'} -m x"`;
    const result = decide(dir, 'guard-bash.js', [], rowEvent({ command }), 4500);
    assert.equal(result.status, 0);
    assert.equal(result.decision, 'pass');
  }));

test('M19 reintroduce a segment-anchored lazy prefix walk into executors', () => withMutant(
  'M19 reintroduce a segment-anchored lazy prefix walk into executors', 'guard-bash.js',
  ['(?:^|[\\s;&|(])(?:(?:ba|z|k|da|a)?sh\\b',
    '(?:^|[\\s;&|(])[^;&|\\n]*?(?:(?:ba|z|k|da|a)?sh\\b'],
  (dir) => {
    const command = '(a '.repeat(80000) + '; rm -rf /';
    const result = decide(dir, 'guard-bash.js', [], rowEvent({ command }), 4500);
    assert.ok(result.status === null || result.elapsed >= 4500,
      `mutant must be killed or exceed budget; status=${result.status} elapsed=${result.elapsed.toFixed(1)}`);
  }));

// M20 pins the per-line `git push` exec by BEHAVIOUR, not by timing. The
// whole-line regex it guards against loses two things the per-line exec has: the
// next line's first token (A48 asks on a backslash-continued --force) and the
// lease strip on the push remainder (P18/P19/P37/P38 pass --force-with-lease).
// The earlier wall-clock ratio flexed with machine load under the parallel
// `node --test` runs: the working copy is itself
// superlinear on a 200 KB `git push` line, so the mutant only added a ~1.6x
// constant on top of a noisy baseline. hooks.test.js bounds a 50 KB push line
// at the hooks.json timeout instead (the hooks test owns the 200 KB line); nothing
// here is timed.
test('M20 reintroduce the whole-line force regex in place of the per-line exec', () => {
  const flips = [['A48', 'ask', 'pass'], ['P18', 'pass', 'ask'], ['P19', 'pass', 'ask'],
    ['P37', 'pass', 'ask'], ['P38', 'pass', 'ask']];
  withMutant('M20 reintroduce the whole-line force regex in place of the per-line exec',
    'guard-bash.js',
    ["{ push: /\\s(--force\\b|-f\\b)/, stripLease: true, why:",
      "{ re: /\\bgit\\s+push\\b[^\\n]*\\s(--force\\b|-f\\b)/, why:"],
    (dir) => {
      for (const [id, expected, mutated] of flips) {
        const row = rows.get(id);
        assert.ok(row, `${id}: corpus row must exist`);
        const original = decide(HOOKS, 'guard-bash.js', [], rowEvent(row));
        assert.equal(original.status, 0, `${id}: working hook must exit zero`);
        assert.equal(original.decision, expected, `${id}: working hook decision`);
        const mutant = decide(dir, 'guard-bash.js', [], rowEvent(row));
        assert.equal(mutant.status, 0, `${id}: mutant must not crash`);
        assert.equal(mutant.decision, mutated, `${id}: whole-line regex must flip the decision`);
      }
    });
});

test('M21 revert the rm-scoped dequote to a global dequote', () => withMutant(
  'M21 revert the rm-scoped dequote to a global dequote', 'guard-bash.js',
  [
    ['rmNormalized: dequoteRmTargets(stripped)', 'rmNormalized: dequote(stripped)'],
    ['dequoteRmTargets(cmd)', 'dequote(cmd)'],
  ],
  (dir) => {
    for (const id of ['P44', 'P45', 'P46']) {
      const result = decide(dir, 'guard-bash.js', [], rowEvent(rows.get(id)));
      assert.equal(result.status, 0, `${id}: mutant must not crash`);
      assert.equal(result.decision, 'ask', `${id}: global dequote must ask`);
    }
    const result = decide(dir, 'guard-bash.js', [], rowEvent(rows.get('A23')));
    assert.equal(result.status, 0, 'A23: mutant must not crash');
    assert.equal(result.decision, 'ask', 'A23: global dequote must still ask');
  }));

test('mutation table covers ADDED_BY rows bidirectionally', () => {
  const named = new Set(mutations.flatMap((mutation) => mutation.reds));
  assert.ok(named.size > 0, 'mutation reds must not be empty');
  assert.ok(payloads.ADDED_BY.size > 0, 'ADDED_BY must not be empty');
  const withoutMutation = [...payloads.ADDED_BY].filter((id) => !named.has(id));
  const outsideAddedBy = [...named].filter((id) => !payloads.ADDED_BY.has(id));
  const absentFromCorpus = [...payloads.ADDED_BY].filter((id) => !rows.has(id));
  assert.deepEqual(withoutMutation, [], withoutMutation
    .map((id) => `ADDED_BY row ${id} has no mutation that reds it`).join('; '));
  assert.deepEqual(outsideAddedBy, [], outsideAddedBy
    .map((id) => `mutation names ${id} which is not in ADDED_BY`).join('; '));
  assert.deepEqual(absentFromCorpus, [], absentFromCorpus
    .map((id) => `ADDED_BY row ${id} does not exist in the corpus`).join('; '));
});

test('ADDED_BY rows pass their positive decisions on the working tree', () => {
  for (const id of payloads.ADDED_BY) {
    const row = rows.get(id);
    const script = id === 'D22' ? 'secret-scan.js' : 'guard-bash.js';
    const args = id === 'D22' ? ['file'] : [];
    const result = decide(HOOKS, script, args, rowEvent(row));
    assert.equal(result.status, 0, `${id}: working hook must exit zero`);
    assert.equal(result.decision, expectedFor(id), `${id}: working hook positive sanity`);
  }
});
