# Review severity — P0 / P1 (the one blocking scale)

The single severity scale shared by every rstaff review role (`/review`, the
`reviewer` subagent, `/secaudit`). Reviews report P0/P1 issues plus the
non-blocking backlog defined below. Style, taste, and nice-to-haves are not
review findings.

- **P0 — must fix before merge.** Breaks in production, fails `make verify`,
  violates the spec (a missing or incorrect requirement), causes data
  loss/corruption, opens a security hole, or is a breaking change with no
  back-out.
- **P1 — should fix.** A real correctness / robustness / security risk that isn't
  strictly merge-blocking on its own, a missing test for new or changed
  behaviour, or a violated **MUST**-phrased preference. Genuine uncertainty about
  whether something is safe is itself a P1 — surface it, don't wave it through.

**Security findings map onto the same gate:** a **CRITICAL** security finding is a
**P0**; a **HIGH** is a **P1**. `/secaudit` may rank CRITICAL/HIGH for emphasis,
but the merge gate it feeds is P0/P1.

## The frozen contract

A finding may be **P0 or P1 only if BOTH** of these conditions hold:

- **(i)** it traces to the spec's acceptance criteria or the verify Definition
  of Done (DoD); **and**
- **(ii)** it is reachable in this repo's actual configuration.

A finding matching the P0/P1 security definitions above satisfies condition (i)
automatically. Condition (ii) reachability still applies.

Everything else the reviewer finds remains real output under
`## Backlog (non-blocking)`, one line per finding with a suggested ticket line.
These out-of-contract findings never block and never affect the verdict.

Normally, read reachability from the `## configuration facts` section of
`profiles/<repo>.md`. If that section is absent or silent on the point, a finding
may block only when the reviewer cites repo evidence that the scenario is
reachable, such as a configured remote, a config file, or an actual code path.
Unproven reachability files to Backlog.

Apply the evidence rule symmetrically, as one discipline with the existing
unproven-"pre-existing" rule: calling something unreachable also requires repo
evidence. An unproven "not reachable here" claim is itself at least a **P1**; do
not drop it as unreachable.

Measured reason: in the analysed arc, review rounds 5–11 blocked on fork-clone
and multi-remote scenarios unreachable in a single-developer, one-remote repo.

A P0 — or any unresolved **in-contract** P1 the human hasn't explicitly
accepted — means **BLOCK**: not shippable. Out-of-contract findings never block.
Route only in-contract fixes back through `/build`, then re-review.
