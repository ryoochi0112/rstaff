# rstaff control-repo Makefile.
# (Product repos get their own Makefile from plugins/rstaff/templates/Makefile.sample.)
# Company strategy + its doc-check gate live in a separate repository.

.PHONY: verify check install health test evals backlog-check core-only e2e-install public-tree

# The full test suite under test/** (node:test, zero deps): core, per-layer, maintainer and hook contract tests.
test:
	@node --test 'test/**/*.test.js'

# Validate the plugin itself, in spec order: manifests (strict x7) + hook syntax -> every test
# (inventory, builtin-names and vendored tests run here) -> core alone -> skill lint -> leak
# scan -> static health.
verify:
	@bash install/install-apply.sh >/dev/null && echo "✅ plugin verify passed"
	@echo "→ full test suite (test/**: core, per-layer, maintainer and hook contract tests)" && node --test 'test/**/*.test.js'
	@$(MAKE) --no-print-directory core-only
	@node maintainer/lib-skill-lint.js
	@node maintainer/leak-scan.js $(if $(wildcard rstaff.json),,--all)
	@node plugins/rstaff/scripts/health.js --static

# AC6': the core test subset must pass with ONLY plugins/rstaff present. Copy core and
# test/core/ into a fresh temp tree (no sibling plugins, no maintainer/) and run it there with
# RSTAFF_CORE_ROOT pointing at the copy; a core test that reaches a sibling or maintainer/
# fails to resolve it. CLAUDE_CONFIG_DIR and HOME point at empty dirs so locate() cannot
# see the operator's installed plugins registry. The temp tree is removed on any exit.
core-only:
	@tmp=$$(cd "$$(mktemp -d "$${TMPDIR:-/tmp}/rstaff-core-only.XXXXXX")" && pwd -P) && trap 'rm -rf "$$tmp"' EXIT && \
	mkdir -p "$$tmp/plugins" "$$tmp/test" && cp -R plugins/rstaff "$$tmp/plugins/rstaff" && cp -R test/core "$$tmp/test/core" && \
	mkdir -p "$$tmp/claude-config" "$$tmp/home" && \
	echo "→ core-only subset" && cd "$$tmp" && RSTAFF_CORE_ROOT="$$tmp/plugins/rstaff" CLAUDE_CONFIG_DIR="$$tmp/claude-config" HOME="$$tmp/home" USERPROFILE="$$tmp/home" node --test 'test/core/**/*.test.js'

# Validate the live backlog store; this is deliberately outside verify.
backlog-check:
	@RSTAFF_HOME="$(CURDIR)" node plugins/rstaff/scripts/lib-backlog.js validate

# Full machine diagnosis (is the cockpit actually wired up on THIS machine?).
health:
	@node plugins/rstaff/scripts/health.js

# Everything (CI runs this).
check: verify

unexport OUT
public-tree:
	@node maintainer/build-public-tree.js --out $(call shellquote,$(value OUT)) --verify

install:
	@bash install/install-apply.sh

# POSIX single-quote escaping for a value that reaches the shell: close the quote, emit an
# escaped quote, reopen. Wrapping a value in bare '' is NOT quoting — a ' inside the value
# closes the wrapper and everything after it is parsed as shell.
shellquote = '$(subst ','\'',$(1))'

# Online skill evals (paid model runs, outside offline verify).
# make evals [SKILL=<s>] [CASE=<glob>] [RUNS=<n>] [KEEP_TEMP=<any non-empty, even 0>]
# maintainer/run-evals.js evaluates a dependency-free copy of each owning plugin:
# SKILL selects owners and the <s>-* case glob, else every eval plugin runs; it fails on an
# unknown skill or the first failed plugin. Empty value = unset. Any recipe failure makes
# make itself exit 2 (the runner keeps the exact code). Native cases pin per-mode runs and
# subject budgets; 0.6 preserves trigger 2/3 and compliance 3/5 majorities; Haiku judges.
# Injection stages: $(value X) stops make expanding payloads such as $(shell ...) in the
# recipe; shellquote escapes quotes before shell parsing. unexport is needed too: GNU Make
# 3.81 exports command-line variables to the recipe environment and expands them while doing
# so, so SKILL='$(shell ...)' would run even though the recipe never reads it. make -n
# builds no recipe environment and cannot see this, so
# test/maintainer/skill-evals-coverage.test.js runs real make with a stub claude.
unexport SKILL CASE RUNS KEEP_TEMP
evals:
	@node "$(dir $(lastword $(MAKEFILE_LIST)))maintainer/run-evals.js" --skill $(call shellquote,$(value SKILL)) --case $(call shellquote,$(value CASE)) --runs $(call shellquote,$(value RUNS)) --keep-temp $(call shellquote,$(value KEEP_TEMP))

# Online install check (network + claude CLI); deliberately outside verify.
e2e-install:
	bash maintainer/e2e-install.sh
