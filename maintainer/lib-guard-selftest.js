'use strict';

const { VERSION_LOCATIONS_TEXT } = require('./lib-install.js');

const CORPORA = ['bashDeny', 'bashAsk', 'bashPass', 'secretDeny', 'secretClean'];

function rowEvent(row) {
  return row.command
    ? { tool_name: 'Bash', tool_input: { command: row.command } }
    : { tool_input: { content: row.text } };
}

function expectedFor(_row, corpusName) {
  if (corpusName === 'bashAsk') return 'ask';
  if (corpusName === 'bashDeny' || corpusName === 'secretDeny') return 'deny';
  if (corpusName === 'bashPass' || corpusName === 'secretClean') return 'pass';
  return undefined;
}

function decodeDecision({ status, stdout }) {
  let output = {};
  try { output = JSON.parse(stdout); } catch (_) {}
  const permission = output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision;
  return permission || (status === 0 && stdout === '' ? 'pass' : undefined);
}

function actualDecision(result) {
  const decision = decodeDecision(result);
  if (decision) return decision;
  if (result.signal) return `killed(${result.signal})`;
  if (result.status !== 0) return `exit ${result.status}`;
  if (result.stdout) return 'unparsable stdout';
  return `exit ${result.status}`;
}

function checkGuardPayloads({ pluginRoot, payloads, spawn }) {
  const mismatches = [];
  if (!pluginRoot) {
    return {
      status: 'INFO',
      note: 'no installed rstaff plugin recorded in ~/.claude/plugins/installed_plugins.json — run install/install-apply.sh --install',
      mismatches,
    };
  }

  let total = 0;
  for (const corpusName of CORPORA) {
    for (const row of payloads[corpusName]) {
      total += 1;
      const secret = corpusName === 'secretDeny' || corpusName === 'secretClean';
      const script = `${pluginRoot}/hooks/${secret ? 'secret-scan.js' : 'guard-bash.js'}`;
      const args = secret ? ['file'] : [];
      const result = spawn(script, args, JSON.stringify(rowEvent(row)));
      const expected = expectedFor(row, corpusName);
      const actual = actualDecision(result);
      if (actual !== expected) mismatches.push({ id: row.id, expected, actual });
    }
  }

  if (!mismatches.length) {
    return {
      status: 'PASS',
      note: `${total} guard payload rows replayed against ${pluginRoot}`,
      mismatches,
    };
  }

  const first = mismatches[0];
  return {
    status: 'FAIL',
    note: `${mismatches.length} of ${total} rows answer differently in the installed copy (${pluginRoot}) — first: ${first.id} expected ${first.expected} got ${first.actual}; fix: bump the version in ${VERSION_LOCATIONS_TEXT}, then run install/install-apply.sh --install`,
    mismatches,
  };
}

module.exports = { checkGuardPayloads, rowEvent, expectedFor, decodeDecision };
