#!/usr/bin/env node
// Secret detection at the control boundary.
//   mode "file"   -> PreToolUse(Write|Edit|MultiEdit): deny writing known secrets.
//   mode "prompt" -> UserPromptSubmit: block sending a prompt containing secrets.
// Known-prefix patterns only (low false-positive). Adapted from ECC's
// before-submit-prompt secret scan. See THIRD_PARTY.md.
'use strict';
// Internal errors (including a failure to load ./lib): file mode asks, as for a
// malformed event; prompt mode cannot ask, so it warns and passes. Written
// without ./lib so it works when ./lib is the failure.
process.on('uncaughtException', (e) => {
  const why = `secret-scan internal error (${e && e.message})`;
  if ((process.argv[2] || 'file') === 'prompt') {
    try { process.stderr.write(`rstaff: ${why}; passing without scanning\n`); } catch (_) {}
  } else {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'ask',
      permissionDecisionReason: `rstaff ${why}; confirm the file tool request before continuing.`,
    } }));
  }
  process.exit(0);
});
const { readEventStrict, warn, denyTool, askTool, blockPrompt, pass } = require('./lib');

const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_\-]{20,}/, 'Anthropic API key'],
  [/sk-(?:proj-)?[A-Za-z0-9]{20,}/, 'OpenAI API key'],
  // Cursor CURSOR_API_KEY: prefix `crsr_` + 64 alphanumerics (confirmed 2026-07-21).
  // KEEP even though rstaff dropped the cursor adapter (2026-08-01): this scanner
  // guards the operator's whole machine, not just backends rstaff calls. A key can
  // still sit in a dotfile or transcript long after the integration is gone —
  // which is exactly the case that motivated removing it from settings.json.
  [/crsr_[A-Za-z0-9]{32,}/, 'Cursor API key'],
  [/gh[posru]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{30,}/, 'GitHub fine-grained PAT'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/AIza[0-9A-Za-z_\-]{35}/, 'Google API key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'private key block'],
  // NB: deliberately no broad JWT/base64 pattern — known-prefix only, to keep
  // false positives near-zero for an always-on hook (see docs/SECURITY.md).
];

const mode = process.argv[2] || 'file';
const { event: ev, malformed } = readEventStrict();
if (malformed) {
  if (mode === 'prompt') {
    // Deliberate documented residual (spec §7): UserPromptSubmit cannot ask,
    // and blocking malformed input would lock the operator out.
    warn('secret-scan received a malformed event in prompt mode; passing without scanning');
    pass();
  }
  askTool('rstaff: malformed event input; confirm the file tool request before continuing.');
}

let text = '';
if (mode === 'prompt') {
  text = ev.prompt || ev.user_prompt || '';
} else {
  const ti = ev.tool_input || {};
  text = [ti.content, ti.new_string, ti.replacement, ti.text, ti.command].filter(Boolean).join('\n');
  if (Array.isArray(ti.edits)) text += '\n' + ti.edits.map((e) => e && e.new_string).filter(Boolean).join('\n');
}
if (!text) pass();

for (const [re, label] of PATTERNS) {
  if (re.test(text)) {
    const reason = `rstaff secret-scan: a possible ${label} was detected. Do not commit or send live credentials — use an env var or secret manager. If this is a false positive (placeholder/example), rephrase so it doesn't match a real key format.`;
    if (mode === 'prompt') blockPrompt(reason);
    denyTool(reason);
  }
}
pass();
