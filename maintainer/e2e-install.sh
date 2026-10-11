#!/usr/bin/env bash
# Online end-to-end install check (AC6'): core alone, then a layer plugin with its
# superpowers dependency. Needs network and the claude CLI. NOT part of make verify.
# Runs entirely in a temp HOME / CLAUDE_CONFIG_DIR; never touches the real ~/.claude.
set -euo pipefail

role=default
if [ "$#" -ne 0 ]; then
  if [ "$#" -eq 2 ] && [ "$1" = --role ] && { [ "$2" = pm ] || [ "$2" = ds ] || [ "$2" = ai ] || [ "$2" = engineer ]; }; then
    role=$2
  else
    echo "usage: e2e-install.sh [--role pm|ds|ai|engineer]" >&2
    exit 2
  fi
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "e2e-install: claude CLI not found on PATH (this is an online check, not a silent pass)" >&2
  exit 1
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
tmp=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/rstaff-e2e.XXXXXX")" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/claude-config"
export HOME="$tmp/home" USERPROFILE="$tmp/home" CLAUDE_CONFIG_DIR="$tmp/claude-config"
unset RSTAFF_HOME

fail() { echo "e2e-install FAIL [$1]: $2" >&2; exit 1; }

# Prints "<name> <enabled|disabled>" per installed plugin (name without @marketplace).
list_installed() {
  claude plugin list --json | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const j = JSON.parse(s);
      const arr = Array.isArray(j) ? j : (j.installed || j.plugins || []);
      for (const p of arr) {
        const id = String(p.id || p.name || "");
        console.log(id.split("@")[0] + " " + (p.enabled === false ? "disabled" : "enabled") + " " + id);
      }
    });'
}

if [ "$role" = pm ]; then
  cd "$tmp/home"
  echo "== step P1: core + PM =="
  out=$(claude plugin marketplace add "$root" 2>&1) || { echo "$out" >&2; fail "P1 marketplace add" "could not add $root"; }
  echo "$out"
  if echo "$out" | grep -qi "failed to load"; then fail "P1 load" "marketplace output reports 'failed to load'"; fi
  for p in rstaff rstaff-pm; do
    out=$(claude plugin install "$p@rstaff" 2>&1) || { echo "$out" >&2; fail "P1 install $p" "install failed"; }
    echo "$out"
    if echo "$out" | grep -qi "failed to load"; then fail "P2 load" "install output reports 'failed to load'"; fi
  done

  echo "== step P2: only core + PM enabled =="
  listP=$(list_installed)
  echo "$listP"
  for p in rstaff rstaff-pm; do
    echo "$listP" | grep -q "^$p enabled " || fail "P2 enabled" "$p is not listed as enabled"
  done
  for p in superpowers rstaff-engineer rstaff-backlog; do
    if echo "$listP" | grep -q "^$p "; then fail "P2 absent" "$p is installed for PM"; fi
  done
  out=$(claude plugin list 2>&1) || { echo "$out" >&2; fail "P2 list" "plugin list failed"; }
  if echo "$out" | grep -qi "failed to load"; then fail "P2 load" "plugin list reports 'failed to load'"; fi

  echo "== step P3: PM setup from installed core =="
  core=$(node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const registry = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,
  'plugins/installed_plugins.json'), 'utf8'));
const entry = registry.plugins?.['rstaff@rstaff']?.find(p =>
  typeof p.installPath === 'string' && fs.existsSync(path.join(p.installPath, 'scripts/setup.js')));
if (!entry) throw new Error('P3: installed rstaff@rstaff core path not found');
process.stdout.write(fs.realpathSync(entry.installPath));
NODE
  ) || fail "P3 core path" "cannot resolve installed core"
  node "$core/scripts/setup.js" --home "$tmp/rstaff-home" --name acme > "$tmp/setup.json" || fail "P3 setup" "setup failed"
  node - "$tmp/setup.json" "$tmp/rstaff-home" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [output, home] = process.argv.slice(2);
assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).mode, 'pm', 'P3: setup mode must be pm');
assert.equal(fs.readFileSync(path.join(home, 'backlog/acme.md'), 'utf8'), '# Backlog — acme\n');
assert.deepEqual(fs.readdirSync(path.join(home, 'profiles')).filter(p => p.endsWith('.md')), [],
  'P3: PM setup must not create profiles');
NODE

  echo "== step P4: invalid backlog blocks until recorded verify is green =="
  export RSTAFF_HOME="$tmp/rstaff-home"
  cd "$RSTAFF_HOME"
  node - "$core" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = process.argv[2];
const home = process.env.RSTAFF_HOME;
const env = { ...process.env };
delete env.RSTAFF_GATE;
const event = { cwd: home, session_id: 'e2e-pm' };
function hook(file, args, input) {
  const result = spawnSync(process.execPath, [path.join(core, 'hooks', file), ...args],
    { cwd: home, env, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}
hook('completion-gate.js', ['baseline'], event);
const backlog = path.join(home, 'backlog/acme.md');
fs.appendFileSync(backlog, '\n## PRODUCT-001: Test a product idea\n'
  + '- status: open\n- pri: P1\n- route: plan\n- deps: -\n- source: interview\n'
  + '- filed: 2026-10-06\n- falsifier: -\n'
  + '- cheapest-test: Observe 5 users attempting the task.\n- links: -\n- context: A testable idea.\n');
const stop = hook('completion-gate.js', ['stop'], event);
assert.equal(stop.decision, 'block', 'P4: invalid backlog must block Stop');
const command = stop.reason.match(/`([^`]+)`/)?.[1];
assert.equal(command, require(path.join(core, 'scripts/lib-gate.js')).resolveVerify(home, home),
  'P4: Stop must name the resolved verify command');
assert.equal(typeof command, 'string', 'P4: Stop must include a backticked command');
function verify() {
  const recorded = hook('verify-recorder.js', [],
    { ...event, tool_name: 'Bash', tool_input: { command } });
  const rewritten = recorded.hookSpecificOutput?.updatedInput?.command;
  assert.equal(typeof rewritten, 'string', 'P4: Bash recorder must return a command');
  assert.notEqual(rewritten, command, 'P4: Bash recorder must wrap verify');
  const result = spawnSync('bash', ['-c', rewritten], { cwd: home, env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'P4: verify must exit normally');
  return result;
}
const red = verify();
assert.notEqual(red.status, 0, 'P4: invalid backlog verify must exit non-zero');
assert.match(red.stdout + red.stderr, /PRODUCT-001: interview source requires falsifier/);
fs.writeFileSync(backlog, fs.readFileSync(backlog, 'utf8')
  .replace('- falsifier: -', '- falsifier: Fewer than 3 of 5 users finish the task.'));
const green = verify();
assert.equal(green.status, 0, green.stdout + green.stderr);
assert.notEqual(hook('completion-gate.js', ['stop'], event).decision, 'block',
  'P4: fixed backlog with recorded green must allow Stop');
NODE
  echo "e2e-install OK (pm)"
  exit 0
fi

if [ "$role" = ds ]; then
  cd "$tmp/home"
  echo "== step S1: core + DS =="
  out=$(claude plugin marketplace add "$root" 2>&1) || { echo "$out" >&2; fail "S1 marketplace add" "could not add $root"; }
  echo "$out"
  if echo "$out" | grep -qi "failed to load"; then fail "S1 load" "marketplace output reports 'failed to load'"; fi
  for p in rstaff rstaff-ds; do
    out=$(claude plugin install "$p@rstaff" 2>&1) || { echo "$out" >&2; fail "S1 install $p" "install failed"; }
    echo "$out"
    if echo "$out" | grep -qi "failed to load"; then fail "S1 load" "install output reports 'failed to load'"; fi
  done
  listS=$(list_installed)
  echo "$listS"
  for p in rstaff rstaff-ds; do
    echo "$listS" | grep -q "^$p enabled " || fail "S1 enabled" "$p is not listed as enabled"
  done

  echo "== step S2: notebook toolchain present =="
  python3 -c "import nbconvert, ipykernel" >/dev/null 2>&1 \
    || fail "S2 python deps" "nbconvert/ipykernel missing; run: python3 -m venv .venv && . .venv/bin/activate && pip install nbconvert ipykernel"

  echo "== step S3: setup proposes rstaff:nbgate =="
  export GIT_CONFIG_GLOBAL=/dev/null
  repo="$tmp/analysis"
  cp -R "$root/plugins/rstaff-ds/samples/analysis" "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.name e2e
  git -C "$repo" config user.email e2e@example.invalid
  git -C "$repo" add -A
  git -C "$repo" commit -q -m sample
  node "$root/plugins/rstaff/scripts/setup.js" --home "$tmp/rstaff-home" --product "$repo" > "$tmp/setup-ds.json" \
    || fail "S3 setup" "setup failed"
  node - "$tmp/setup-ds.json" <<'NODE' || fail "S3 verify" "setup JSON does not say verify: rstaff:nbgate"
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).verify, 'rstaff:nbgate');
NODE

  echo "== step S4: gate green on sample, red on seeded =="
  cd "$repo"
  before=$(git status --porcelain)
  node "$root/plugins/rstaff/scripts/nbgate.js" || fail "S4 green" "nbgate must exit 0 on the sample analysis"
  after=$(git status --porcelain)
  [ "$before" = "$after" ] || fail "S4 clean" "nbgate changed the working tree during the green run"
  cp "$root/test/fixtures/ds/seeded.ipynb" "$repo/seeded.ipynb"
  rc=0
  node "$root/plugins/rstaff/scripts/nbgate.js" > "$tmp/nbgate-red.txt" 2>&1 || rc=$?
  cat "$tmp/nbgate-red.txt"
  [ "$rc" = 1 ] || fail "S4 red" "nbgate must exit 1 on the seeded notebook (got $rc)"
  grep -q 'counts:' "$tmp/nbgate-red.txt" || fail "S4 counts" "red output has no counts: line"
  grep -q 'NameError' "$tmp/nbgate-red.txt" || fail "S4 fresh run" "red output has no NameError line"
  echo "e2e-install OK (ds)"
  exit 0
fi

if [ "$role" = ai ]; then
  cd "$tmp/home"
  echo "== step S1: core + AI =="
  for marketplace in "$root" obra/superpowers-marketplace; do
    out=$(claude plugin marketplace add "$marketplace" 2>&1) || { echo "$out" >&2; fail "S1 marketplace add" "could not add $marketplace"; }
    echo "$out"
    if echo "$out" | grep -qi "failed to load"; then fail "S1 load" "marketplace output reports 'failed to load'"; fi
  done
  for p in rstaff rstaff-ai; do
    out=$(claude plugin install "$p@rstaff" 2>&1) || { echo "$out" >&2; fail "S1 install $p" "install failed"; }
    echo "$out"
    if echo "$out" | grep -qi "failed to load"; then fail "S1 load" "install output reports 'failed to load'"; fi
  done
  listS=$(list_installed)
  echo "$listS"
  for p in rstaff rstaff-ai; do
    echo "$listS" | grep -q "^$p enabled " || fail "S1 enabled" "$p is not listed as enabled"
  done
  echo "$listS" | grep -q '^superpowers ' || fail "S1 dependency" "superpowers did not arrive as a dependency"
  if echo "$listS" | grep -q '^rstaff-ai-datadog '; then fail "S1 add-on absent" "rstaff-ai-datadog is installed without an explicit request"; fi

  echo "== step S2: setup declares label-exact-match =="
  repo="$tmp/label-task"
  cp -R "$root/plugins/rstaff-ai/samples/label-task" "$repo"
  node "$root/plugins/rstaff/scripts/setup.js" --home "$tmp/rstaff-home" --product "$repo" > "$tmp/setup-ai.json" \
    || fail "S2 setup" "setup failed"
  node - "$tmp/setup-ai.json" <<'NODE' || fail "S2 adapters" "setup JSON does not say adapters: [label-exact-match]"
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.deepEqual(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).adapters, ['label-exact-match']);
NODE

  echo "== step S3: certify and grade offline without model calls =="
  cd "$repo"
  stub="$tmp/stub-bin"
  mkdir -p "$stub"
  export RSTAFF_E2E_CALL_LOG="$tmp/claude-calls.log"
  : > "$RSTAFF_E2E_CALL_LOG"
  cat > "$stub/claude" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$RSTAFF_E2E_CALL_LOG"
exit 1
SH
  chmod +x "$stub/claude"
  export PATH="$stub:$PATH"
  node certify.js --out "$tmp/cert.md" || fail "S3 certify" "certification must exit 0 on the sample grader"
  node grade.js --cases cases.jsonl --split confirm --replies fixtures/replies-offline.jsonl --json "$tmp/grades.json" \
    || fail "S3 grade" "offline grading must exit 0"
  node - "$tmp/grades.json" <<'NODE' || fail "S3 paired results" "offline replies must contain twelve pairs with candidate beating control"
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { rows, summary } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(rows.length, 24);
for (const arm of ['control', 'candidate']) {
  assert.equal(summary[arm].total, 12);
  assert.equal(new Set(rows.filter(row => row.arm === arm).map(row => row.id)).size, 12);
}
assert.deepEqual(rows.filter(row => row.arm === 'control').map(row => row.id).sort(),
  rows.filter(row => row.arm === 'candidate').map(row => row.id).sort());
assert.ok(summary.candidate.passed > summary.control.passed);
NODE
  [ ! -s "$RSTAFF_E2E_CALL_LOG" ] || fail "S3 no model calls" "certification or grading called claude"

  echo "== step S4: always-pass grader invalidates certification =="
  cp grade.js "$tmp/grade-original.js"
  node - <<'NODE' || fail "S4 seed" "cannot seed the always-pass grader"
const assert = require('node:assert/strict');
const fs = require('node:fs');
const original = fs.readFileSync('grade.js', 'utf8');
const seeded = original.replace('return reply === label ? 1 : 0;', 'return 1;');
assert.notEqual(seeded, original, 'S4: exact-match grader not found');
fs.writeFileSync('grade.js', seeded);
NODE
  rc=0
  node certify.js --out "$tmp/cert-red.md" > "$tmp/certify-red.txt" 2>&1 || rc=$?
  cp "$tmp/grade-original.js" grade.js
  cat "$tmp/certify-red.txt"
  [ "$rc" = 1 ] || fail "S4 red" "certification must exit 1 on the always-pass grader (got $rc)"
  grep -q '^status: invalidated$' "$tmp/cert-red.md" || fail "S4 invalidated" "certificate does not say status: invalidated"
  [ ! -s "$RSTAFF_E2E_CALL_LOG" ] || fail "S4 no model calls" "seeded certification called claude"
  echo "e2e-install OK (ai)"
  exit 0
fi

if [ "$role" = engineer ]; then
  cd "$tmp/home"
  echo "== step S1: core + engineer =="
  for marketplace in "$root" obra/superpowers-marketplace; do
    out=$(claude plugin marketplace add "$marketplace" 2>&1) || { echo "$out" >&2; fail "S1 marketplace add" "could not add $marketplace"; }
    echo "$out"
    if echo "$out" | grep -qi "failed to load"; then fail "S1 load" "marketplace output reports 'failed to load'"; fi
  done
  for p in rstaff rstaff-engineer; do
    out=$(claude plugin install "$p@rstaff" 2>&1) || { echo "$out" >&2; fail "S1 install $p" "install failed"; }
    echo "$out"
    if echo "$out" | grep -qi "failed to load"; then fail "S1 load" "install output reports 'failed to load'"; fi
  done
  listS=$(list_installed) || fail "S1 list" "cannot read installed plugins"
  echo "$listS"
  for p in rstaff rstaff-engineer rstaff-pm; do
    echo "$listS" | grep -q "^$p enabled " || fail "S1 enabled" "$p is not listed as enabled"
  done
  echo "$listS" | grep -q '^superpowers ' || fail "S1 dependency" "superpowers did not arrive as a dependency"
  out=$(claude plugin list 2>&1) || { echo "$out" >&2; fail "S1 list" "plugin list failed"; }
  if echo "$out" | grep -qi "failed to load"; then fail "S1 load" "plugin list reports 'failed to load'"; fi

  echo "== step S2: installed superpowers skills resolve =="
  core=$(node - 2> "$tmp/skills-error.txt" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const plugins = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins');
const cache = fs.realpathSync(path.join(plugins, 'cache'));
const registry = JSON.parse(fs.readFileSync(path.join(plugins, 'installed_plugins.json'), 'utf8'));
function installed(name) {
  const entries = Object.entries(registry.plugins || {})
    .filter(([id]) => id.split('@')[0] === name).flatMap(([, entries]) => entries);
  for (const entry of entries) {
    if (typeof entry.installPath !== 'string' || !fs.existsSync(entry.installPath)) continue;
    const dir = fs.realpathSync(entry.installPath);
    if (dir.startsWith(cache + path.sep) && fs.statSync(dir).isDirectory()) return dir;
  }
  throw new Error(`installed ${name} path not found under ${cache}`);
}
const names = new Set();
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile()) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/superpowers:([a-zA-Z0-9_-]+)/g)) {
        names.add(match[1]);
      }
    }
  }
}
const core = installed('rstaff');
for (const dir of [core, installed('rstaff-pm'), installed('rstaff-engineer')]) scan(dir);
if (names.size === 0) throw new Error('no installed superpowers skill references found');
const superpowers = installed('superpowers');
const missing = [...names].sort().filter(name =>
  !fs.existsSync(path.join(superpowers, 'skills', name, 'SKILL.md')));
if (missing.length) throw new Error(`missing superpowers skills: ${missing.join(', ')}`);
process.stdout.write(core);
NODE
  ) || fail "S2 skills" "$(cat "$tmp/skills-error.txt")"

  echo "== step S3: setup proposes make verify =="
  command -v make >/dev/null 2>&1 || fail "S3 make" "make missing; run: xcode-select --install"
  export GIT_CONFIG_GLOBAL=/dev/null
  repo="$tmp/slugify"
  cp -R "$root/plugins/rstaff-engineer/samples/slugify" "$repo" || fail "S3 copy" "cannot copy slugify sample"
  git -C "$repo" init -q || fail "S3 git init" "cannot initialize sample repo"
  git -C "$repo" config user.name e2e || fail "S3 git config" "cannot set sample author"
  git -C "$repo" config user.email e2e@example.invalid || fail "S3 git config" "cannot set sample email"
  git -C "$repo" add -A || fail "S3 git add" "cannot stage sample"
  git -C "$repo" commit -q -m sample || fail "S3 git commit" "cannot commit sample"
  node "$core/scripts/setup.js" --home "$tmp/rstaff-home" --product "$repo" > "$tmp/setup-engineer.json" \
    || fail "S3 setup" "setup failed"
  node - "$tmp/setup-engineer.json" <<'NODE' || fail "S3 verify" "setup JSON does not say verify: make verify"
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).verify, 'make verify');
NODE

  echo "== step S4: sample red, fixed green =="
  cd "$repo"
  rc=0
  make verify > "$tmp/verify-red.txt" 2>&1 || rc=$?
  cat "$tmp/verify-red.txt"
  [ "$rc" -ne 0 ] || fail "S4 red" "make verify must fail on the shipped sample"
  cp slugify.js "$tmp/slugify-shipped.js" || fail "S4 save" "cannot save shipped source"
  cat > slugify.js <<'JS' || fail "S4 fix" "cannot write fixed source"
'use strict';

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
JS
  make verify || fail "S4 green" "make verify must pass after the fix"
  cp slugify.js "$tmp/slugify-fixed.js" || fail "S4 save" "cannot save fixed source"

  echo "== step S5: installed completion gate blocks, then allows recorded green =="
  export RSTAFF_HOME="$tmp/rstaff-home"
  stub="$tmp/stub-bin"
  mkdir -p "$stub" || fail "S5 stub" "cannot create stub directory"
  export RSTAFF_E2E_CALL_LOG="$tmp/claude-calls.log"
  : > "$RSTAFF_E2E_CALL_LOG" || fail "S5 stub" "cannot initialize call log"
  cat > "$stub/claude" <<'SH' || fail "S5 stub" "cannot write claude stub"
#!/bin/sh
printf '%s\n' "$*" >> "$RSTAFF_E2E_CALL_LOG"
exit 1
SH
  chmod +x "$stub/claude" || fail "S5 stub" "cannot enable claude stub"
  export PATH="$stub:$PATH"
  cp "$tmp/slugify-shipped.js" slugify.js || fail "S5 baseline" "cannot restore committed source"
  node - "$core" "$repo" "$tmp/slugify-fixed.js" <<'NODE' || fail "S5 gate" "installed gate must block before recorded verify and allow silently afterwards"
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [core, repo, fixed] = process.argv.slice(2);
const sid = 'e2e-engineer';
const env = { ...process.env };
delete env.RSTAFF_GATE;
function hook(mode) {
  const result = spawnSync(process.execPath, [path.join(core, 'hooks/completion-gate.js'), mode], {
    cwd: process.env.RSTAFF_HOME, env, encoding: 'utf8', timeout: 10000,
    input: JSON.stringify({ session_id: sid, cwd: repo }),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}
assert.equal(hook('baseline'), '', 'S5: baseline must be silent');
fs.copyFileSync(fixed, path.join(repo, 'slugify.js'));
const stop = JSON.parse(hook('stop'));
assert.equal(stop.decision, 'block', 'S5: unverified edit must block Stop');
assert.match(stop.reason, /no green `make verify` matches it/);
const green = spawnSync(process.execPath, [path.join(core, 'scripts/verify-run.js'), sid, 'make verify'], {
  cwd: repo, env, encoding: 'utf8', timeout: 30000,
});
assert.ifError(green.error);
process.stdout.write(green.stdout);
assert.equal(green.status, 0, green.stdout + green.stderr);
assert.equal(hook('stop'), '', 'S5: recorded green must allow Stop silently');
NODE
  [ ! -s "$RSTAFF_E2E_CALL_LOG" ] || fail "S5 no model calls" "completion gate or verify called claude"
  echo "e2e-install OK (engineer)"
  exit 0
fi

echo "== step A: core alone =="
claude plugin marketplace add "$root" || fail "A1 marketplace add (repo)" "could not add $root"
claude plugin install rstaff@rstaff || fail "A2 install rstaff@rstaff" "install failed"
listA=$(list_installed)
echo "$listA"
echo "$listA" | grep -q '^rstaff enabled ' || fail "A3 core enabled" "rstaff is not listed as enabled"
for layer in rstaff-engineer rstaff-ai rstaff-delegation rstaff-backlog rstaff-usage rstaff-pm; do
  if echo "$listA" | grep -q "^$layer "; then fail "A4 core alone" "layer plugin $layer is installed after installing core only"; fi
done
if echo "$listA" | grep -q '^superpowers '; then fail "A5 core alone" "superpowers present; core must not need it"; fi

echo "== step B: rstaff-engineer pulls superpowers =="
claude plugin marketplace add obra/superpowers-marketplace || fail "B1 marketplace add (superpowers)" "could not add obra/superpowers-marketplace"
out=$(claude plugin install rstaff-engineer@rstaff 2>&1) || { echo "$out" >&2; fail "B2 install rstaff-engineer@rstaff" "install failed"; }
echo "$out"
if echo "$out" | grep -qi "failed to load"; then fail "B3 load" "install output reports 'failed to load'"; fi
listB=$(list_installed)
echo "$listB"
echo "$listB" | grep -q '^superpowers ' || fail "B4 dependency" "superpowers did not arrive as a dependency"
echo "$listB" | grep -q '^rstaff-engineer enabled ' || fail "B5 engineer enabled" "rstaff-engineer is not listed as enabled"
echo "$listB" | grep -q '^rstaff-pm enabled ' || fail "B5 PM dependency" "rstaff-pm did not arrive as an engineer dependency"
if claude plugin list 2>&1 | grep -qi "failed to load"; then fail "B6 load" "plugin list reports 'failed to load'"; fi

# Steps C/D run install-apply.sh --install end to end, each in its own fresh
# HOME + CLAUDE_CONFIG_DIR. A stub gemini on PATH stops the installer from running
# a real global `npm i -g @google/gemini-cli` (a side effect outside the temp HOME).
stub="$tmp/stub-bin"
mkdir -p "$stub"
printf '#!/bin/sh\nexit 0\n' > "$stub/gemini"
chmod +x "$stub/gemini"
fresh_env() {
  mkdir -p "$tmp/home-$1" "$tmp/claude-config-$1"
  export HOME="$tmp/home-$1" USERPROFILE="$tmp/home-$1" CLAUDE_CONFIG_DIR="$tmp/claude-config-$1"
}

echo "== step C: install-apply.sh --install installs defaults without the add-on =="
fresh_env C
outC=$(PATH="$stub:$PATH" bash "$root/install/install-apply.sh" --install 2>&1) || { echo "$outC" >&2; fail "C1 install-apply --install" "installer exited non-zero"; }
listC=$(list_installed)
echo "$listC"
if echo "$listC" | grep -q '^rstaff-ai-datadog '; then fail "C2 add-on absent" "rstaff-ai-datadog is installed without an explicit request"; fi
for p in rstaff rstaff-engineer rstaff-ai rstaff-delegation rstaff-backlog rstaff-usage rstaff-pm; do
  echo "$listC" | grep -q "^$p enabled " || fail "C2 seven enabled" "$p is not listed as enabled after --install"
done
echo "$listC" | grep -q '^superpowers ' || fail "C3 dependency" "superpowers did not arrive as a dependency"
if claude plugin list 2>&1 | grep -qi "failed to load"; then fail "C4 load" "plugin list reports 'failed to load'"; fi

echo "== step D: install-apply.sh --install --core-only installs core only =="
fresh_env D
outD=$(PATH="$stub:$PATH" bash "$root/install/install-apply.sh" --install --core-only 2>&1) || { echo "$outD" >&2; fail "D1 install-apply --install --core-only" "installer exited non-zero"; }
listD=$(list_installed)
echo "$listD"
echo "$listD" | grep -q '^rstaff enabled ' || fail "D2 core enabled" "rstaff is not listed as enabled"
nD=$(echo "$listD" | grep -c '^rstaff')
[ "$nD" = 1 ] || fail "D3 exactly one" "expected exactly one rstaff* entry, found $nD"
if echo "$listD" | grep -q '^superpowers '; then fail "D4 core only" "superpowers present; core must not need it"; fi

echo "e2e-install OK"
