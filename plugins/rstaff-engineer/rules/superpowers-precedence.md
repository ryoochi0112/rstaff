# Superpowers composition

The engineer and AI role plugins require superpowers for generic engineering
disciplines. rstaff owns the control-repo loop and its mechanical gates.

## Required disciplines

- TDD: `superpowers:test-driven-development`
- Debugging: `superpowers:systematic-debugging`
- Done-claims: `superpowers:verification-before-completion`
- Review feedback: `superpowers:receiving-code-review`
- Divergent design: `superpowers:brainstorming`

## Precedence inside the rstaff loop (superpowers says HOW, rstaff says WHERE)

When operating under rstaff's role commands (`/spec /design /build /dispatch
/review /qa /ship /land`):

- **Artifacts: control repo only.** Never write superpowers' artifact paths
  (`docs/superpowers/**` design docs, `.superpowers/sdd/**` progress ledgers)
  into a product repo. The spec, ledger, and run state live at
  `$CTRL/var/specs/…` — `parallel-build` owns the formats. rstaff writes zero
  process artifacts into product repos; that rule outranks any skill's default
  save location.
- **Design gate:** an accepted `/spec` + `/design` **is** the approved design —
  superpowers' brainstorming hard-gate is satisfied by it; don't re-open the
  design mid-`/build` (a mid-build redesign is a spec change → human decision).
- **Execution engine:** ledger work runs on rstaff's `parallel-build`
  (route.js-persisted writer/reviewer routes, hook-enforced gates, control-repo
  resident state) — not `superpowers:subagent-driven-development`. Same
  ancestry; rstaff's version is the mechanically-gated fork of it.
- **Review & landing:** `/review` (fresh reviewer subagent, blocking-only)
  supersedes `requesting-code-review`; `/ship` + `/land` supersede
  `finishing-a-development-branch`. Humans still make the merge/deploy call.

Outside the loop — ad-hoc work with no spec, ledger, or profile — superpowers'
own pipeline (brainstorm → plan → SDD → finish) is fine as-is.

