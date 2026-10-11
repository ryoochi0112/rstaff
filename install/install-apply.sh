#!/usr/bin/env bash
# rstaff installation helper.
# Validates the plugin manifests and hooks, then prints or performs the install steps.
#   ./install/install-apply.sh            # validate + report + print steps
#   ./install/install-apply.sh --set-home # also export RSTAFF_HOME in your shell profile
#   ./install/install-apply.sh --install  # actually activate: register marketplace,
#                                         # install all eight plugins (user scope; adds the
#                                         # superpowers marketplace the engineer/ai layers
#                                         # need), set RSTAFF_HOME (settings.json + shell),
#                                         # mkdir working dirs. Idempotent check-then-act.
#   ./install/install-apply.sh --install --core-only  # same, but only the core plugin
set -euo pipefail

INSTALL=0; CORE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --core-only) CORE_ONLY=1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "  ✗ $1" >&2; ERR=1; }
ok() { echo "  ✓ $1"; }
# Loud but non-fatal: a state the human must act on, that the script cannot fix.
warn() { echo "  ⚠ $1" >&2; }
ERR=0

echo "rstaff installer — root: $ROOT"

command -v node >/dev/null 2>&1 || fail "node not found (hooks require Node)"
[ "$ERR" = 0 ] && ok "node $(node --version)"

if ! command -v gemini >/dev/null 2>&1; then
  if [ "$INSTALL" = 1 ]; then
    echo "Installing gemini CLI…"
    if npm i -g @google/gemini-cli; then
      ok "gemini CLI installed"
    else
      fail "npm i -g @google/gemini-cli failed"
    fi
  else
    echo "npm i -g @google/gemini-cli"
  fi
fi

echo "Validating JSON manifests…"
for f in ".claude-plugin/marketplace.json" "plugins/rstaff/.claude-plugin/plugin.json" "plugins/rstaff-pm/.claude-plugin/plugin.json" "plugins/rstaff-ds/.claude-plugin/plugin.json" "plugins/rstaff/hooks/hooks.json" "plugins/rstaff-engineer/.claude-plugin/plugin.json" "plugins/rstaff-ai/.claude-plugin/plugin.json" "plugins/rstaff-ai-datadog/.claude-plugin/plugin.json" "plugins/rstaff-delegation/.claude-plugin/plugin.json" "plugins/rstaff-backlog/.claude-plugin/plugin.json" "plugins/rstaff-usage/.claude-plugin/plugin.json" "plugins/rstaff-usage/hooks/hooks.json"; do
  if node -e "JSON.parse(require('fs').readFileSync('$ROOT/$f','utf8'))" 2>/dev/null; then ok "$f"; else fail "$f is not valid JSON"; fi
done

echo "Validating manifests (claude plugin validate --strict)…"
if command -v claude >/dev/null 2>&1; then
  for target in "$ROOT" "$ROOT"/plugins/*/; do
    [ -d "$target" ] || continue
    label="${target#"$ROOT"}"; label="${label#/}"; label="${label%/}"; label="${label:-marketplace (repo root)}"
    if out="$(claude plugin validate --strict "${target%/}" 2>&1)"; then ok "strict: $label"; else printf '%s\n' "$out" >&2; fail "strict validation failed: $label"; fi
  done
else
  warn "WARN: claude CLI not on PATH — 'claude plugin validate --strict' was SKIPPED for the marketplace and every plugin (CI without claude)"
fi

echo "Checking hook scripts load…"
for plugin in rstaff rstaff-usage rstaff-backlog rstaff-delegation; do
  for hook in "$ROOT/plugins/$plugin/hooks/"*.js; do
    if node --check "$hook" 2>/dev/null; then ok "$plugin/hooks/$(basename "$hook")"; else fail "$hook has a syntax error"; fi
  done
done

set_home_profile() {
  # Detect the USER's login shell ($SHELL) — not the script's interpreter
  # (BASH_VERSION is always set here because this script runs under bash).
  case "${SHELL:-}" in
    */zsh)  PROFILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash) PROFILE="$HOME/.bashrc" ;;
    *)      PROFILE="$HOME/.profile" ;;
  esac
  LINE="export RSTAFF_HOME=\"$ROOT\""
  if grep -qF "RSTAFF_HOME" "$PROFILE" 2>/dev/null; then
    echo "  = RSTAFF_HOME already present in $PROFILE — leaving as-is."
  else
    printf '\n# rstaff control repo (memory hooks read profiles/, LEARNINGS.md, var/ from here)\n%s\n' "$LINE" >> "$PROFILE"
    ok "Added RSTAFF_HOME to $PROFILE (restart shell or 'source $PROFILE')"
  fi
}

[ "${1:-}" = "--set-home" ] && set_home_profile

[ "$CORE_ONLY" = 1 ] && [ "$INSTALL" = 0 ] && warn "--core-only only applies together with --install; ignored"

# Plugin ids to install, read from the marketplace manifest (never hardcoded):
# all entries except the opt-in add-on, or just core under --core-only.
MARKETPLACE_NAME="rstaff"
PLUGIN_IDS="rstaff@rstaff"
if [ "$CORE_ONLY" = 0 ]; then
  if ids="$(node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1] + "/.claude-plugin/marketplace.json", "utf8"));
    process.stdout.write(m.plugins.filter(p => p.name !== "rstaff-ai-datadog").map(p => p.name + "@" + m.name).join(" "));
  ' "$ROOT" 2>/dev/null)" && [ -n "$ids" ]; then PLUGIN_IDS="$ids"; fi
fi
# engineer + ai depend on superpowers (another marketplace); install must add it first.
NEEDS_SUPERPOWERS=0
case " $PLUGIN_IDS " in
  *" rstaff-engineer@"*|*" rstaff-ai@"*) NEEDS_SUPERPOWERS=1 ;;
esac

manual_install_lines() {
  echo "    /plugin marketplace add $ROOT"
  if [ "$NEEDS_SUPERPOWERS" = 1 ]; then echo "    /plugin marketplace add obra/superpowers-marketplace"; fi
  for id in $PLUGIN_IDS; do echo "    /plugin install $id"; done
}
manual_steps() {
  echo "Manual fallback — inside a Claude Code session run:"
  manual_install_lines
  echo "then re-run: ./install/install-apply.sh --set-home"
}

if [ "$INSTALL" = 1 ]; then
  [ "$ERR" = 0 ] || { echo "Validation FAILED — fix the above before installing." >&2; exit 1; }
  echo "Activating rstaff…"

  if ! command -v claude >/dev/null 2>&1; then
    fail "claude CLI not found — cannot register the plugin from the shell."
    manual_steps; exit 1
  fi

  # 1) Marketplace registration (idempotent) — match THIS repo's path exactly,
  #    not any "rstaff"-substring path (a stale clone must not shadow $ROOT).
  if claude plugin marketplace list 2>/dev/null | grep -qF "($ROOT)"; then
    echo "  = marketplace for $ROOT already registered"
  else
    claude plugin marketplace add "$ROOT" && ok "registered marketplace: $ROOT" || { fail "marketplace add failed"; manual_steps; exit 1; }
  fi
  claude plugin marketplace update "$MARKETPLACE_NAME" >/dev/null 2>&1 || true

  # 1b) The engineer + ai layers depend on superpowers@superpowers-marketplace, a
  #     cross-marketplace dependency that only resolves once that marketplace exists.
  if [ "$NEEDS_SUPERPOWERS" = 1 ]; then
    if claude plugin marketplace list 2>/dev/null | grep -qF "superpowers-marketplace"; then
      echo "  = marketplace superpowers-marketplace already registered"
    else
      claude plugin marketplace add obra/superpowers-marketplace && ok "registered marketplace: obra/superpowers-marketplace" || { fail "superpowers marketplace add failed (rstaff-engineer / rstaff-ai depend on it)"; manual_steps; exit 1; }
    fi
  fi

  # 2) Plugin install/enable, user scope (covers every repo; opt-down per-project
  #    with 'claude plugin disable rstaff@rstaff'). Per plugin, distinguish absent
  #    vs disabled — a listed-but-disabled plugin has dead hooks and must be
  #    re-enabled. "installed + enabled" is NOT "up to date": the plugin cache is
  #    keyed by version, so an enabled-but-stale copy is never re-copied and every
  #    session keeps running hooks from whenever it was last installed. Ask
  #    lib-install.js (the same verdict /health reports; one entry per plugin in
  #    .plugins[]) and act on it instead of assuming.
  VERDICT="$(node "$ROOT/maintainer/lib-install.js" --home "$ROOT" 2>/dev/null || echo '{}')"
  verdict_field() { # <plugin name> <action|note>
    printf '%s' "$VERDICT" | node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        try { const v=JSON.parse(s||"{}"); const p=(v.plugins||[]).find(x=>x.name===process.argv[1]);
              process.stdout.write(String((p&&p[process.argv[2]])||"")); } catch(_) {}
      });' "$1" "$2" 2>/dev/null || true
  }
  plugin_state() { # <plugin id> -> absent|enabled|disabled|unknown
    claude plugin list --json 2>/dev/null | node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        try { const l=JSON.parse(s); const p=(Array.isArray(l)?l:[]).find(x=>x.id===process.argv[1]);
              process.stdout.write(!p?"absent":(p.enabled?"enabled":"disabled")); }
        catch(_) { process.stdout.write("unknown"); }
      });' "$1" 2>/dev/null || echo unknown
  }
  # A failed layer is recorded (ERR=1 → "Activation INCOMPLETE", exit 1) and the
  # loop moves on; a failed core aborts as before.
  plugin_failed() { # <plugin id>
    manual_steps
    [ "$1" = "rstaff@$MARKETPLACE_NAME" ] && exit 1
    return 0
  }
  for id in $PLUGIN_IDS; do
    name="${id%@*}"
    STATE="$(plugin_state "$id")"
    case "$STATE" in
      enabled)
        ACTION="$(verdict_field "$name" action)"
        NOTE="$(verdict_field "$name" note)"
        case "$ACTION" in
          update)
            if claude plugin update "$id"; then
              ok "updated $id — $NOTE (restart Claude Code to apply)"
            else
              fail "plugin update failed ($id) — $NOTE"; plugin_failed "$id"
            fi ;;
          # Same version, different content: no update is possible, so say so
          # loudly. Silence here is what let five merged PRs sit uninstalled.
          bump) warn "stale install ($id) — $NOTE" ;;
          *)    echo "  = plugin $id already installed + enabled${NOTE:+ ($NOTE)}" ;;
        esac ;;
      disabled)
        if claude plugin enable "$id"; then ok "re-enabled $id (was disabled)"; else fail "plugin enable failed ($id)"; plugin_failed "$id"; fi ;;
      *)
        if claude plugin install "$id" --scope user; then ok "installed plugin $id (user scope)"; else fail "plugin install failed ($id)"; plugin_failed "$id"; fi ;;
    esac
  done

  # 3) RSTAFF_HOME → ~/.claude/settings.json env block (reaches GUI/headless
  #    sessions) AND the shell profile (reaches make targets outside Claude).
  #    Refuse to overwrite an existing-but-malformed settings.json (that would
  #    silently wipe the user's real config).
  node -e '
    const fs = require("fs"), os = require("os"), path = require("path");
    const p = path.join(os.homedir(), ".claude", "settings.json");
    const root = process.argv[1];
    let d = {};
    if (fs.existsSync(p)) {
      try { d = JSON.parse(fs.readFileSync(p, "utf8")); }
      catch (_) {
        console.error("  ✗ ~/.claude/settings.json exists but is not valid JSON — refusing to overwrite it. Fix the JSON, then add env.RSTAFF_HOME=\"" + root + "\" by hand (or re-run).");
        process.exit(2);
      }
    }
    d.env = d.env || {};
    if (d.env.RSTAFF_HOME === root) { console.log("  = settings.json env.RSTAFF_HOME already set"); process.exit(0); }
    if (fs.existsSync(p)) { try { fs.copyFileSync(p, p + ".rstaff-backup"); console.log("  · backed up settings.json → settings.json.rstaff-backup"); } catch (_) {} }
    d.env.RSTAFF_HOME = root;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
    console.log("  ✓ set env.RSTAFF_HOME in ~/.claude/settings.json");
  ' "$ROOT" || { fail "settings.json update aborted (see message above)"; exit 1; }
  set_home_profile

  # 4) Runtime working dirs (gitignored volatile state) + profiles/.
  mkdir -p "$ROOT/var/sessions" "$ROOT/var/dispatch" "$ROOT/var/experiments" "$ROOT/profiles"
  ok "working dirs present (var/sessions, var/dispatch, var/experiments, profiles)"

  echo
  [ "$ERR" = 0 ] || { echo "Activation INCOMPLETE — see the ✗ line(s) above." >&2; exit 1; }
  echo "Activation done ($(printf '%s\n' $PLUGIN_IDS | wc -l | tr -d ' ') plugin(s): $PLUGIN_IDS)."
  echo "Now: open a FRESH Claude Code session and run /health"
  echo "(the 'hooks fired' checks only pass after a session starts post-install)."
  exit 0
fi

echo
if [ "$ERR" = 0 ]; then
  echo "All checks passed. To activate on this machine:"
  echo "    ./install/install-apply.sh --install              # all eight plugins"
  echo "    ./install/install-apply.sh --install --core-only  # core plugin only"
  echo "or manually:"
  manual_install_lines
  echo "Then ensure RSTAFF_HOME=$ROOT is set (re-run with --set-home to do it for you)."
else
  echo "Some checks FAILED — fix the above before installing." >&2
  exit 1
fi
