#!/usr/bin/env node
// PreToolUse(Bash): block CI-bypass flags and unrouted writer dispatches; ask
// before clearly destructive commands.
// Mirrors ECC's "no --no-verify" guard. Conservative: deny only the bypass,
// "ask" (not deny) for destructive patterns so the human stays sovereign.
'use strict';
// Fail closed on any internal error, including a failure to load ./lib: an
// uncaught throw exits 1, which Claude Code treats as non-blocking and runs the
// tool unchecked. Written without ./lib so it works when ./lib is the failure.
process.on('uncaughtException', (e) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: `rstaff guard-bash internal error (${e && e.message}); confirm the Bash tool request before continuing.`,
  } }));
  process.exit(0);
});
const fs = require('fs');
const path = require('path');
const { readEventStrict, denyTool, askTool, pass, resolveHome } = require('./lib');

const { event: ev, malformed } = readEventStrict();
if (malformed) askTool('rstaff: malformed event input; confirm the Bash tool request before continuing.');
const cmd = (ev.tool_input && (ev.tool_input.command || ev.tool_input.script)) || '';
if (!cmd) pass();

// Hard deny: bypassing the verification gate is never the answer. Cover the
// long flag AND its common equivalents — matching only --no-verify lets the
// exact same bypass through under a different spelling.
// A heredoc BODY is stdin data, not command text, so a commit message delivered
// via `git commit -F - <<'MSG' … MSG` must not be scanned for flags — a message
// that *documents* a bypass policy is not a bypass. Stripped BEFORE quote-blanking
// because a prose body may contain unbalanced quotes that would wreck quote pairing.
// Exception: a heredoc feeding a SHELL is command text, so those bodies are kept —
// otherwise `bash <<'EOF' … git commit --no-verify … EOF` would be a free bypass.
const SHELL_CONSUMER = /(^|[\s|(=])(?:ba|z|k|da|a)?sh\b|\beval\b|\bsource\b/;
function stripHeredocBodies(text) {
  const out = [];
  let delim = null;
  let keep = false;
  for (const line of text.split('\n')) {
    if (delim !== null) {
      if (line.trim() === delim) { out.push(line); delim = null; keep = false; }
      else if (keep) out.push(line);
      continue; // otherwise the line is stdin data — drop it from flag detection
    }
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
    if (m) {
      delim = m[2];
      keep = SHELL_CONSUMER.test(line.slice(0, m.index));
    }
    out.push(line);
  }
  return out.join('\n');
}

// Blank out quoted strings for flag detection so a commit *message* that
// mentions a flag (e.g. -m "use -n") isn't mistaken for the flag itself. Active
// flags are never quoted; only string data (messages) is. Shell/eval bodies are
// extracted first, then each body comes back through this same normalization so
// a nested message remains data rather than becoming a false-positive flag.
function normalize(text) {
  const stripped = stripHeredocBodies(text);
  return {
    stripped,
    unquoted: dequoteGitWord(stripped).replace(/\\.|'[^']*'|"(?:\\.|[^"\\])*"/g, (match) => (
      match[0] === '\\' ? match : (match[0] === "'" ? "''" : '""')
    )),
    rmNormalized: dequoteRmTargets(stripped),
  };
}

function decodeDoubleQuoted(value) {
  return value.replace(/\\(["\\$`])/g, '$1');
}

function dequote(text) {
  return text.replace(/\\.|'([^']*)'|"((?:\\.|[^"\\])*)"/g, (match, single, double) => {
    if (single !== undefined) return single;
    if (double !== undefined) return decodeDoubleQuoted(double);
    return match;
  });
}

function dequoteRmTargets(text) {
  let rmActive = false;
  return text.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|(?:\\.|[^'"\\])+/g,
    (match, single, double) => {
      if (single !== undefined || double !== undefined) {
        // Decoding only drops a backslash before " \ $ `, so it cannot turn other
        // content into `rm`: decode lazily, only when the value is kept.
        if ((single !== undefined ? single : double) === 'rm') rmActive = true;
        if (!rmActive) return single !== undefined ? "''" : '""';
        return single !== undefined ? single : decodeDoubleQuoted(double);
      }
      const separator = Math.max(
        match.lastIndexOf(';'), match.lastIndexOf('&'), match.lastIndexOf('|'),
        match.lastIndexOf('\n'), match.lastIndexOf('('),
      );
      if (separator >= 0) rmActive = false;
      if (/\brm\b/.test(match.slice(separator + 1))) rmActive = true;
      return match;
    });
}

// A quoted command word runs exactly like the bare one (`"git" push -f` IS a
// force-push), but the push tier scans the raw top-level text and the blanked
// `unquoted` bodies, so a quoted `git` never reached GIT_PUSH_RE. Unwrap it
// wherever it stands as a whole word, the way dequoteRmTargets arms on a quoted
// `rm` (A58).
const GIT_WORD_RE = /(^|[\s;&|(])(?:"git"|'git')(?=[\s;&|)]|$)/g;
function dequoteGitWord(text) {
  return text.replace(GIT_WORD_RE, '$1git');
}

// This is deliberately a regex extractor, not a shell parser. Quoted strings
// that are not executor arguments are consumed by the last two alternatives so
// shell-looking prose is skipped at its current level. A double-quoted body is
// minimally unescaped before recursion, exposing any nested executor it carries.
function extractShellBodies(text) {
  const bodies = [];
  // A segment-anchored prefix walk is quadratic on repeated segment starts, so anchor directly on each shell word.
  const executors = /(?:\\.|(?:^|[\s;&|(])(?:(?:ba|z|k|da|a)?sh\b(?:[ \t]+-(?![a-zA-Z]*c[a-zA-Z]*(?:\s|=))[^\s;&|]+)*[ \t]+-[a-zA-Z]*c[a-zA-Z]*(?:[ \t]+|=)(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;&|]+))|eval\b((?:[ \t]+(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+))+))|'[^']*'|"(?:\\.|[^"\\])*")/gm;
  let match;
  while ((match = executors.exec(text)) !== null) {
    if (match[1] !== undefined) bodies.push(decodeDoubleQuoted(match[1]));
    else if (match[2] !== undefined) bodies.push(match[2]);
    else if (match[3] !== undefined) bodies.push(match[3]);
    else if (match[4] !== undefined) {
      const args = [];
      const argument = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;&|]+)/g;
      let arg;
      while ((arg = argument.exec(match[4])) !== null) {
        args.push(arg[1] !== undefined ? decodeDoubleQuoted(arg[1])
          : (arg[2] !== undefined ? arg[2] : arg[3]));
      }
      bodies.push(args.join(' '));
    }
  }
  return bodies;
}

const MAX_SHELL_BODY_DEPTH = 4;
const MAX_TOTAL_EXTRACTED_BODY_BYTES = 1024 * 1024;
function normalizedCommands(text, top) {
  const commands = [];
  let extractedBytes = 0;
  let extractionBudgetExceeded = false;
  function visit(body, depth) {
    const normalized = depth === 0 && top ? top : normalize(body);
    commands.push(normalized);
    if (depth >= MAX_SHELL_BODY_DEPTH || extractionBudgetExceeded) return;
    for (const extracted of extractShellBodies(normalized.stripped)) {
      extractedBytes += Buffer.byteLength(extracted);
      // Scan every body whole once extracted. Only an input larger than this
      // budget can reach the residual; exceeding it stops further extraction.
      if (extractedBytes > MAX_TOTAL_EXTRACTED_BODY_BYTES) extractionBudgetExceeded = true;
      visit(extracted, depth + 1);
      if (extractionBudgetExceeded) break;
    }
  }
  visit(text, 0);
  return commands;
}

// `git … commit … -n` inside one shell segment, found by three forward scans
// instead of a backtracking regex. A backslash-newline continuation is one line
// to bash, so it is joined first (as the push tier does); then segments split on
// & | ; and newline, and within a segment the earliest `git`, the earliest
// `commit` after it, and any `\s-[a-z]*n` after that decide the match — the set
// the single regex accepted, plus the continuation case, in O(n).
// A backslash-newline is a bash continuation only when the backslash is itself
// unescaped: `\\<LF>` is a literal backslash and the newline ends the command.
// Odd run of backslashes = continuation; even run = literal.
const CONTINUATION_RE = /(?<!\\)((?:\\\\)*)\\\r?\n/g;
const joinContinuations = (text) => text.replace(CONTINUATION_RE, '$1 ');
const COMMIT_SEGMENT_SPLIT = /[&|;\n]/;
const GIT_TOKEN = /\bgit\b/;
const COMMIT_TOKEN = /\bcommit\b/;
const SHORT_N_FLAG = /\s-[a-z]*n/;
function hasCommitShortNoVerify(text) {
  for (const segment of joinContinuations(text).split(COMMIT_SEGMENT_SPLIT)) {
    const git = GIT_TOKEN.exec(segment);
    if (!git) continue;
    const afterGit = segment.slice(git.index + git[0].length);
    const commit = COMMIT_TOKEN.exec(afterGit);
    if (!commit) continue;
    if (SHORT_N_FLAG.test(afterGit.slice(commit.index + commit[0].length))) return true;
  }
  return false;
}

const BYPASS = [
  // Run against `unquoted`, like the `-n` rule below: the long flag named inside a
  // commit message or heredoc body is documentation, not an invocation. This rule
  // used to test the raw command and blocked a commit whose MESSAGE described the
  // bypass policy — a false positive that pushes people toward `-F file` workarounds.
  { re: /--no-verify\b/, why: '--no-verify' },
  // `-n` is --no-verify for `git commit` (incl. combined clusters like -nm).
  // Scoped to a single `git … commit` segment (no crossing && | ; ) so that
  // `git push -n` (--dry-run) and `git log -n 5` (a limit) stay allowed; run
  // against `unquoted` so a flag named in the commit message is not a bypass.
  // Single-pass on purpose: the one-regex form
  // `\bgit\b[^&|;\n]*\bcommit\b[^&|;\n]*\s-[a-z]*n` rescanned to the end of
  // the segment from every `git` token, so a 200 KB `git push …` line cost 2-4 s
  // against the 5 s fail-open.
  { test: hasCommitShortNoVerify, why: 'git commit -n (short --no-verify)' },
  // Inline `-c core.hooksPath=…` disables all git hooks for one command.
  // The `=` distinguishes the inline override from a legit `git config
  // core.hooksPath <dir>` (space form), which is left alone.
  // The remaining rules also run against `unquoted`: an env-var bypass is never
  // quoted and never inside a heredoc body, so naming one in prose is documentation.
  { re: /\bcore\.hooksPath\s*=/, why: 'core.hooksPath override (disables git hooks)' },
  { re: /\bGIT_HOOKS?_SKIP\b/, why: 'GIT_HOOK(S)_SKIP' },
  { re: /\bHUSKY=0\b/, why: 'HUSKY=0 (husky v9)' },
  { re: /\bHUSKY_SKIP_HOOKS=/, why: 'HUSKY_SKIP_HOOKS (husky v4)' },
  // pre-commit framework per-hook skip: `SKIP=id[,id] [VAR=val …] git commit|push`.
  // Allow intervening env-var assignments so they can't shield the bypass.
  { re: /\bSKIP=\S+(?:\s+\w+=\S+)*\s+git\s+(?:commit|push)\b/, why: 'pre-commit SKIP=… bypass' },
];

function denyBypasses(commands) {
  for (const b of BYPASS) {
    for (const command of commands) {
      if (b.test ? b.test(command.unquoted) : b.re.test(command.unquoted)) {
        denyTool(`Blocked verify-gate bypass (${b.why}). The verification gate (make verify, pre-commit) is the team's quality contract — fix the failure instead of skipping it. Override only via an explicit human decision.`);
      }
    }
  }
}

// Always run the cheap top-level scan before recursive extraction. The hook is
// configured fail-open at five seconds, so extraction cost must never starve a
// deny that is already visible in the top-level command text.
const top = normalize(cmd);
denyBypasses([top]);

const commands = normalizedCommands(cmd, top);
denyBypasses(commands.slice(1));

// Hard deny: dispatching an external writer for a ledger task whose route was
// never resolved. `route.js` is what turns a risk band into a real backend/model/
// effort choice; a task dispatched with `route: pending` bypassed it entirely, so
// the tier is fiction and the run can't be replayed on resume. The `--label`
// carries `<repo>/<slug>/<task-id>/implement`, which is exactly the ledger
// coordinates needed to check — and a shell dispatch is the one writer path a
// PreToolUse hook can see. Fails OPEN when the ledger can't be located (a label
// that isn't a parallel-build task); CLOSED once it can, because at that point a
// missing route is unambiguous.
if (/delegate\.js/.test(cmd) && /\bexecute\b/.test(cmd)) {
  const m = /--label[=\s]\s*(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(cmd);
  const parts = String((m && (m[1] || m[2] || m[3])) || '').split('/');
  // Plain path segments only — the label comes off a shell command line, and
  // `..` in it must not steer the ledger lookup out of var/specs/.
  const plain = (s) => /^[\w.-]+$/.test(s) && s !== '.' && s !== '..';
  if (parts.length === 4 && parts[3] === 'implement' && parts.slice(0, 3).every(plain)) {
    const [repo, slug, taskId] = parts;
    // Load the router and the ledger separately from the check: a broken module
    // or an absent ledger is this hook's bug or none of its business, and must
    // fail OPEN. Only a ledger that exists and answers "no route" denies.
    let route = null;
    let ledger = null;
    try {
      const delegationRoot = require('../scripts/locate.js').locate('rstaff-delegation');
      if (delegationRoot) route = require(path.join(delegationRoot, 'scripts', 'route.js'));
      ledger = fs.readFileSync(
        path.join(resolveHome(ev.cwd), 'var', 'specs', repo, `${slug}.tasks.md`), 'utf8',
      );
    } catch (_) { /* not a locatable ledger task — leave it alone */ }
    if (route && ledger) {
      try {
        route.requireRoute(ledger, taskId);
      } catch (e) {
        denyTool(`Blocked an unrouted writer dispatch for ${repo}/${slug}/${taskId}. ${e.message}`
          + ' route.js decides the backend, model, and reasoning tier — dispatching around it'
          + ' makes the risk band fiction and the run unreplayable on resume.');
      }
    }
  }
}

// `git push` may carry global options first (`git -c a=b push`, `git -C dir
// push`, `git --no-pager push`): a dash token, optionally followed by one
// non-dash value token. The value token must not be `push`
// itself: a valueless option (`--no-pager push … push`) would otherwise swallow
// the verb and the matcher would re-anchor on a later bare `push` with an empty
// remainder. The loop is BOUNDED: without a bound, every `git` token in
// `git -c git -c …` consumed the rest of the line before failing, which was
// quadratic (14.7 s at 140 KB) — the repeated-scan case. Beyond the bound the
// scan cannot see the verb, so a 17th option is itself an ask (fail closed,
// still linear) rather than a silent pass. That rule is gated on
// a `push` word being present at all (`when`), so the 200 KB `git -c git -c …
// nopush` perf fixture stays a pass and non-push git commands never trip it.
const GIT_GLOBAL_OPT = String.raw`\s+-\S+(?:\s+(?!push\b)[^-\s]\S*)?`;
const GIT_PUSH_RE = new RegExp(String.raw`\bgit(?:${GIT_GLOBAL_OPT}){0,16}\s+push\b`);
const GIT_OPTION_OVERFLOW_RE = new RegExp(String.raw`\bgit(?:${GIT_GLOBAL_OPT}){17}`);

const destructive = [
  // recursive delete of root/home — match a flag cluster containing r/R in any
  // order (-rf, -fr, -Rf, -r), regardless of any other flag tokens around it
  // (-f -r, --force -r, --no-preserve-root -rf, --interactive=never -rf), or the
  // long --recursive form. Intervening flags are `-\S+` (any dash-led token) so
  // a hyphenated/`=` long flag can't shield the delete.
  { re: /\brm\b(?:\s+-\S+)*\s+-[a-zA-Z]*[rR][a-zA-Z]*(?:\s+-\S+)*\s+(\/(?:\s|$)|~|\$HOME|\/\*)/, rm: true, why: 'recursive delete of a root/home path' },
  { re: /\brm\b(?:\s+-\S+)*\s+--recursive(?:\s+-\S+)*\s+(\/(?:\s|$)|~|\$HOME|\/\*)/, rm: true, why: 'recursive delete of a root/home path' },
  { re: /\brm(?:\$\{?IFS\}?)+-\S*[rR]/, why: 'rm obfuscated with ${IFS} (recursive delete hidden from the flag scan)' },
  { push: /\s(--force\b|-f\b)/, stripLease: true, why: 'force-push (can overwrite remote history)' },
  { push: /\s\+\S/, why: 'force-push via +refspec (can overwrite remote history)' },
  { push: /\s:\S/, why: 'delete-refspec push (removes a remote branch)' },
  { re: GIT_OPTION_OVERFLOW_RE, git: true, when: /\bpush\b/, why: 'git with more than 16 global options before a push (too many for the push scan to parse; split the command)' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'hard reset (discards uncommitted work)' },
  { re: /\bgit\s+clean\s+-[a-z]*f/, why: 'git clean -f (deletes untracked files)' },
  { re: /\bchmod\s+-R\s+0?777\b/, why: 'world-writable recursive chmod' },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: 'piping a remote script straight into a shell' },
  { re: /\|\s*base64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, why: 'decoding base64 straight into a shell' },
  { re: /\bgit[ \t]+checkout(?:(?:[ \t]+--)?[ \t]+\.(?=[\s;&|)]|$)|[ \t]+\S+[ \t]+--[ \t]+\.(?=[\s;&|)]|$))/, why: 'git checkout of the whole tree (discards every uncommitted change)' },
  { re: /\bgit\s+restore(?:\s+-\S+)*\s+\.(?=[\s;&|)]|$)/, why: 'git restore of the whole tree (discards every uncommitted change)' },
  { re: /\bgit\s+branch(?=[^\n]*(?:-D|--delete|--force|-d)(?=\s|$))(?:\s+-\S+)*\s+(?:-D|--delete\s+--force|--force\s+--delete|-d\s+--force|--force\s+-d)(?=\s|$)/, why: 'force-deleting a branch (may lose unmerged commits)' },
  { re: /\bdd\s+if=.*of=\/dev\/(disk|sd|nvme)/, why: 'raw write to a block device' },
  { re: /\bDROP\s+(DATABASE|TABLE)\b/i, why: 'destructive SQL (DROP)' },
];
const LEASE_RE = /(^|\s)--force-with-lease(?:=\S*)?(?=\s|$)/g;
// The push tier scans line by line, so a newline inside a quoted argument must
// not end the scanned line: fold it to a space and keep every other byte so the
// flag and refspec rules still see the tokens.
const foldQuotedNewlines = (text) => (!text.includes('\n') ? text : text.replace(/\\.|'[^']*'|"(?:\\.|[^"\\])*"/g, (match) => (
  match[0] === '\\' ? match : match.replace(/\r?\n/g, ' ')
)));
// Each rule family scans the same inputs, so build them once, not once per rule.
const rmInputs = [dequoteRmTargets(cmd), ...commands.slice(1).map((command) => command.rmNormalized)];
const pushInputs = [dequoteGitWord(cmd), ...commands.slice(1).map((command) => command.unquoted)]
  .map((input) => foldQuotedNewlines(joinContinuations(input)));
const plainInputs = [cmd, ...commands.slice(1).map((command) => command.unquoted)];
for (const d of destructive) {
  // Preserve the existing raw top-level behaviour. Extracted bodies use their
  // recursively normalized form, keeping quoted message data out of the rules.
  // The push tier and its global-option overflow sibling (`git: true`) scan ONE
  // normalised form — dequoted command word, continuations joined, quoted
  // newlines folded — so a quoted `git` or a backslash-continued option chain
  // cannot slip past one rule while the other would have caught it.
  const inputs = d.rm ? rmInputs : (d.push || d.git ? pushInputs : plainInputs);
  const matched = d.push
    ? inputs.some((input) => input.split('\n').some((line, i, lines) => {
      const m = GIT_PUSH_RE.exec(line);
      if (!m) return false;
      const next = lines[i + 1] || '';
      const nextSrc = d.stripLease ? next.replace(LEASE_RE, '$1').trimStart() : next;
      const nextTok = nextSrc.match(/^\S*/)[0];
      let remainder = line.slice(m.index + m[0].length) + '\n' + nextTok;
      if (d.stripLease) {
        remainder = remainder.replace(LEASE_RE, '$1');
      }
      return d.push.test(remainder);
    }))
    : inputs.some((input) => (!d.when || d.when.test(input)) && d.re.test(input));
  if (matched) {
    askTool(`rstaff: this looks destructive — ${d.why}. Confirm you intend to run it.`);
  }
}
pass();
