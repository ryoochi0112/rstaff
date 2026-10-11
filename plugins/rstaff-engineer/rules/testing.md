# Testing & verification rules (always-follow)

> Seeded/adapted from ECC `rules/common/testing.md`.

- **`make verify` is the single quality gate.** A change is not "done" until it
  passes. If a repo has no `make verify`, create one (see `docs/ARCHITECTURE.md`).
- Add/adjust tests for changed behavior — bug fixes get a regression test.
- The **reviewer is a separate invocation from the implementer** (`/review` runs
  in a fresh context). The author never signs off on their own work.
- Don't weaken a test or a linter/formatter config to make the gate pass. Fix the code.
- Prefer the smallest change that makes the gate green; no unrelated churn in the diff.

## A claimed property needs a mutation-surviving pin

*Promoted from cross-repo engineering experience, 2026-07-28 — earned across two repos
(ontology-sdk M10, example project Part A).*

- **Any property a comment, docstring or doc CLAIMS needs a test that FAILS when
  that property is removed.** Before returning, mutate the thing you claim and
  watch it go red. A guard that stays green under the mutation it names is worse
  than no guard: it reads as coverage.
- **Guard the bug CLASS, not the one instance.** Enumerate exhaustively over the
  real source of truth (`model_fields`, an AST walk, `Object.keys(schema.shape)`,
  the array the handler actually reads) rather than the cases you happen to know.
- **Assert set-like things BIDIRECTIONALLY and fail closed.** Both "declared but
  missing" and "present but undeclared" must fail by name, and an empty derived
  set must fail rather than pass over nothing.
- **Self-audits of this are unreliable.** Reviewers mutation-test claims;
  implementers reporting their own guards as sound have been wrong repeatedly.
  Ask for the mutation and its output, not the assurance.
