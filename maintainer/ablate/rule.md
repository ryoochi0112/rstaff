### Decision rule (pre-registered once; M2–M4 reuse it unchanged)
This is decision-rule v5. The primary metric is judge-only: a run passes if it did not error and every LLM-graded assertion
passed. N=20 runs per arm for F, N and P, plus a 6-run F bridge; K=5.

Instrument checks:
- **C1 known-fail:** K passes ≤ 1/5.
- **C2 known-pass:** F ≥ 16/20.
- **C3 sensitivity:** F − N ≥ 6.
- **C4 isolation:** each probe shows exactly one plugin with the skill owner's name, loaded from its arm, and a non-arm plugin set equal to the frozen background.
- **C5 errors:** terminal errors within budget (K 1/5, N 2/20, F 2/26, P 2/20).
- **C6 model:** the pre probe and post probe resolve the same model id.
- **C7 drift:** F bridge ≥ ceil(6·F/20) − 2.
- **C8 subject text:** every non-error run carries a non-empty subject reply.

Guardrails: the bound files (the rule file, the case files, the command) and the arm hashes are unchanged after the run.

Decision table — the first matching row wins:
1. Any check fails, or any guardrail is breached → **INVALID-HARNESS**.
2. P ≥ F − 2 → **ACCEPT**: the body does not beat the placebo, so the item becomes a cut candidate.
3. P ≤ F − 6 → **REJECT**: the body is load-bearing; keep it.
4. Otherwise → **INCONCLUSIVE**.

A verdict covers haiku and the one designated case only (assumption A3).

cap: 4
judge: haiku
