# Routing policy

`route.js` resolves two axes per ledger task from its `risk`. The writer axis is
the larger token lever — an implementer runs more turns and writes — so move it
first; the reviewer axis follows from the independence interlock.

## Writer — `impl: auto`

| Risk | Writer | Model | Effort |
|---|---|---|---|
| low | Codex | `gpt-6-luna` | max |
| medium | Codex | `gpt-6.1-sol` | medium |
| high | Codex | `gpt-6.1-sol` | xhigh |
| any, `class: docs` | Gemini | `gemini-3.8-flash` | – |

The writer goes to Codex at **every** risk band. It runs the most turns and emits
the most edit/build residue, so it is the largest token lever, and the interlock
below keeps a fresh Claude gate on whatever Codex writes. Risk therefore moves the
**reasoning tier**, not the provider: the lowest band rides `luna` at max effort
— cheap model, expensive thinking — medium runs `6.1-sol@medium`, and high buys
more reasoning on the same `6.1-sol` (`xhigh`) instead of paying for `astra`
(gpt-6.1-sol, released 2026-09-29, matches astra on DeepSWE at ~1/5 the cost per
task and the same API price as gpt-6-sol). The table is
priced in **subscription quota, not tokens**: the `rate_limits` snapshot codex
writes into every rollout measured (2026-09-16, 434 rollouts) `astra` at ~25x
`luna` and ~3x `sol` weekly quota per token, and the daily burn rate rose ~5x the
day astra routes began (2026-09-13). `/rstaff-usage:spend` counts provider tokens and cannot
see that ratio. `gpt-6.1-sol` needs **codex-cli ≥ 0.159.0**: 0.155.0 and 0.157.0
both refused it with HTTP 400 "not supported when using Codex with a ChatGPT
account" (measured 2026-09-30 under rstaff's CODEX_HOME; 0.159.0 ran all three
pairs exit 0). Pin `impl: claude` on a task where the writer's own judgment is
the deliverable.

**Weekly quota brake.** When `rstaff.json` sets `codexQuota.weeklyBrakePercent` (rstaff's own: 85) and the newest codex row in `var/usage.jsonl` shows weekly quota (`quota.secondary.end`) at or above it, `route.js` sends `auto` writers and `auto` reviewers to Claude and records the reason in the route. A reading whose window has already reset (`resetsAt` passed) is ignored, and so is a missing or invalid key. Explicit codex (`impl: codex`, `--impl codex`, `reviewer: codex`) and routes already persisted in the ledger bypass the brake; `--reroute` re-resolves a stored route with it.

**`class: docs` drafts on Gemini.** A docs task under `impl: auto` resolves to
the `gemini` writer (`gemini-3.8-flash`, the same model `/write` drafts with).
delegate.js wires gemini as a read-only `draft`, so the runner has the band's
Claude implementer apply the draft to the task's files; the docs class already
skips the per-task review gate and verify still runs. `impl: gemini` is refused
on any other class, and gemini never reviews. Without a gemini CLI the task takes
the ordinary policy above and records the fallback.

**`writerMode` tells the dispatcher how to run the writer.** `resolve` and
`require` output `writerMode`: `subagent` (claude), `execute` (codex), or `draft`
(gemini). It is checked against delegate.js's adapter table, so a mode the adapter
lacks is refused at resolution. Measured 2026-10-09: a dispatcher that inferred
the mode from `impl` shelled `delegate.js gemini execute` and delegate.js refused it.

## Claude tier

The Claude side of the same ledger. One alias per band, used for a pinned Claude
writer and for every fresh Claude reviewer; these are the aliases the Task tool's
`model` accepts (it overrides the agent frontmatter), so feature-runner passes the
resolved value on each spawn instead of inheriting its own model.

| Risk | Backend | Model |
|---|---|---|
| low | Claude | `sonnet` |
| medium | Claude | `sonnet` |
| high | Claude | `opus` |

A high-risk diff — auth, migrations, money — is read by the strongest independent
Claude model; bounded work stays on sonnet. Routes persisted before 2026-09-30
carry the old `claude/inherited` sentinel and replay verbatim (the runner omits
`model:` for it).

An explicitly named `impl:` is passed through untouched — its availability is a
`/dispatch` preflight decision with a human in the loop. **Where** that name is
written still decides the writer's model, because the three places it can come
from do not mean the same thing:

| Where `impl: codex` is written | What it means | Writer model |
|---|---|---|
| ledger **header** | this run's policy for every task | the risk band's tier |
| CLI **`--impl codex`** | a run-level choice typed in the moment | the risk band's tier |
| a task's **`- impl: codex`** | this one task opts out | `default` — codex's own `config.toml` |

Only the per-task line is an *exception*, so only it gets the `default` sentinel.
Measured 2026-09-09: collapsing all three and keying the tier table
off `impl: auto` alone meant `/build` writing its resolved backend into the ledger
header silently moved every later task in that ledger onto `default` — and a
writer was dispatched onto a `config.toml` model the installed codex-cli refuses,
consuming the attempt with nothing written.

**The tier is checked, not assumed.** An effort the codex CLI doesn't know is
refused at resolution (`route.js`) and again at argv build (`delegate.js`), so a
typo can never be persisted as a task's sticky route.

Whether the band's *model* offers that effort is a narrower question the CLI's own
model catalog answers, and it is checked in two places, because the tier table and
an override fail differently:

- `/health`'s **codex tier support** check walks the tier table and FAILs a band
  whose model doesn't offer its effort.
- `route.js resolve` checks the **overridden** axis only — `--impl-model`/
  `--impl-effort`/`--review-model`/`--review-effort` produce a pair the tier walk
  above never saw, and it is refused before the route is persisted. A per-task
  `- impl: codex` pin resolves to the `default` sentinel (the runner omits `-m`),
  so the check reads the top-level `model =` from codex's `config.toml` to learn
  what that effort will land on.

**The tier table is never blocked at resolve time**, only reported by `/health`.
The catalog is a *cache*: an old one lists a real model with a real level list
that simply predates a newer level, and blocking on that would turn "your cache is
stale" into "all routing is down" with no escape but deleting the file. An
override is typed by a human in the moment, so refusing it costs one command.

Nothing else blocks either: an unreadable or silent catalog is *unknown*; a route
the task will not run is never checked (an `impl: claude` pin is not failed for a
codex pair it never reaches); and an already-persisted route replays verbatim no
matter what the catalog says today.

**The catalog can also be NEWER than the CLI**, and that failure runs the other
way. `loadCodexCatalog` is a bare `JSON.parse`; codex's own loader is stricter,
rejects the same file outright, falls back to built-in metadata, and then refuses
a model the cache happily advertises. Measured 2026-09-09: `models_cache.json`
carried `client_version: 0.153.4` against an installed `codex-cli 0.146.0`; a
`codex exec` run logged `failed to load models cache: missing field
base_instructions` and then `Model metadata for gpt-6-astra not found. Defaulting
to fallback metadata`; and `gpt-6-astra` — listed in that cache with every reasoning level, so
`pairSupport` answered `ok` — died at spawn with HTTP 400 "requires a newer
version of Codex". **A catalog check cannot see this**; only the version fields
can. `/health`'s **codex default model** check reports the inversion and names the
model. It does not block: under that same skew `gpt-5.6-sol` still ran fine, so
refusing every codex route would take the working paths down with the broken one.

## Reviewer — `reviewer: auto`

| Writer | Risk | Reviewer | Model | Effort |
|---|---|---|---|---|
| Claude | low | Codex | `gpt-6-luna` | max |
| Claude | medium | Codex | `gpt-6.1-sol` | medium |
| Claude | high | fresh Claude | `opus` | – |
| Codex | low, medium | fresh Claude | `sonnet` | – |
| Codex | high | fresh Claude | `opus` | – |
| Gemini (docs) | any | fresh Claude | band's Claude tier | – |

A Claude writer only happens on an explicit `impl: claude` or a Codex-unavailable
fallback, so these rows are the opt-out paths, not the default.

## The interlock

**An external writer is never its own reviewer.** A Codex-authored diff always
goes to Claude; `route.js` refuses `impl: codex` + `reviewer: codex`
even when both are set explicitly. Claude-writes/Claude-reviews is *not* a
violation — the reviewer is a fresh, independent context, which is rstaff's
baseline gate.

So `impl: auto` + `reviewer: auto` gives Codex-writes/Claude-reviews at every risk
band. Pinning the writer back to Claude therefore *reinstates* Codex review on that
task rather than stacking with it — the two axes trade, they never both go external.

If Codex is unavailable, automatic routing persists a Claude fallback and reason
on whichever axis asked for it. An explicit `reviewer: codex` fails preflight
instead of silently substituting.

## Routes are sticky

A resolved route is persisted to the task and **reused** on every later
resolution. Re-deriving is not idempotent across time: a route persisted while
Codex was unavailable would flip to Codex once the CLI came back, mid-feature.
`--reroute` (or an explicit model/backend override) is the only way to change a
stored route, which is why the persisted string carries the reasoning effort
(`codex/gpt-6-luna@max`) and not just the model.

Use sandboxed generic `codex exec -s read-only` through `delegate.js codex
advise` for the task gate. Do not use native `codex exec review`: its current
JSONL usage can be all zero and the subcommand exposes no explicit sandbox flag.

## Risk threshold

- **Low:** local/mechanical change; no public contract, persistence, auth,
  permissions, concurrency, money, privacy, or destructive behavior.
- **Medium:** multi-file behavior or a public interface with bounded,
  reversible impact and strong tests.
- **High:** auth/security, permissions, privacy, migrations, destructive
  operations, concurrency, billing, or an irreversible/external effect.

Escalate to high when uncertain. Return work to the coordinator when the packet
is incomplete, the task crosses undeclared interfaces, or two attempts fail for
the same cause.

## Host boundaries

- In ChatGPT/Codex, prefer native subagents over nesting another `codex exec`.
- In Claude Code, let `route.js` select **both** the ledger writer and reviewer
  (`impl: auto`, `reviewer: auto`); pin either with an explicit value to opt out.
- Keep read-heavy workers read-only and parallel writers worktree-isolated.
