# Contributing Guide

Welcome! We want to make contributing to this project as clear as possible.

## How to Contribute
1. Please open an issue first to discuss a change, then a pull request.
2. Once the proposal is agreed upon, submit your contribution.

## Rules and Guidelines
- Keep your diffs small and on-topic.
- Never bypass hooks (no `--no-verify`).
- Security issues go through SECURITY.md, not public issues.

## Verification
The command `make verify` is the only done signal. It runs:
- Tests using `node --test 'test/**/*.test.js'`
- Manifest checks
- Skill lint
- Leak scans

Your workspace must be green before submitting a pull request.

## Reproducing CI locally
You can reproduce the CI checks locally before submitting your pull request.
Run this command from the repository root:

```bash
node maintainer/ci-workflow.js run .
```

The script has no dependencies beyond Node.
It runs steps with the CI environment variable set to true.
First, it checks the workflow file against four rules.
It prints PASS for each rule labeled C1 to C4.
Then, it executes the workflow run steps.
A passing run prints step "make check": exit 0 and exits 0.

## Review Process
All pull requests are reviewed. The review runs in a fresh context so an author never approves their own work.

## License
By contributing, you agree that your contributions are licensed under MIT (LICENSE).
