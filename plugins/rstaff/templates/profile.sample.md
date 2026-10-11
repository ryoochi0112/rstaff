# rstaff product profile template
# Copy this file to $RSTAFF_HOME/profiles/<repo-dir>.md, where <repo-dir> is
# the product repository's directory name. Replace every placeholder with
# commands and facts verified against that repository.
#
# Keep the verify command fast, deterministic, and the only DoD signal. Keep
# run/QA commands separate when they are slower, interactive, or non-gating.

**Repo:** `/absolute/path/to/repo` — name the repository and its purpose.
**What it is:** describe the product, stack, and focus that matter to the loop.
**Verify (DoD):** `make verify` = list the real typecheck/lint/test gate; say what is required.

## run / local dev stack

# Give the commands a user runs to start or exercise the local product.
```bash
# cd /absolute/path/to/repo
# <real local development command>
```

## QA surface

# Give the commands or URLs used for QA, including any slower or non-gating checks.
```bash
# <real QA command>
```

## configuration facts

What is TRUE of this repo's real deployment/config, so a reviewer can tell a
reachable failure from a hypothetical one. One bullet per fact.

<!--
A reviewer reads this section for condition (ii) of the frozen contract in
`rules/review-severity.md`: whether a finding is reachable in this repo's
actual configuration.

A fact stated here makes an entire class of finding non-blocking. For example,
a verified no-fork fact sends fork-dependent findings to the non-blocking
backlog under that contract.
-->
- **Fact:** state one verified deployment or configuration fact.
