# Mini-spec — route reasoning-effort validation

Derived from commit `0be7499` (`route: validate reasoning effort, and check the tier against codex's catalog`). The seeded diff claims to implement these requirements:

1. `delegate.js` owns the complete Codex CLI effort enum and `assertEffort()` is called by `addCodexOptions`, so every Codex mode rejects an unknown effort before spawning.
2. `route.js` rejects malformed `CODEX_TIER` entries and validates both the `--impl-effort` and `--review-effort` overrides, which bypass the tier table.
3. The guards use the CLI's complete enum (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`), rather than treating rstaff's current tier table as the allowlist.
4. `/doctor` checks every risk band's `(model, effort)` pair against the offline Codex model catalog; an unsupported pair is `FAIL`, while a model absent from the catalog is `WARN`, never `FAIL`.
5. The catalog policy lives in a pure `route.checkTierSupport()` function so it can be tested without Codex installed, and malformed route configuration is reported by `/doctor` instead of crashing diagnosis.
