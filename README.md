# rstaff

rstaff is a Claude Code plugin that automates workflows for a PM, data scientist, AI engineer, and engineer. It runs commands and reads untrusted content on your behalf.

| Role | What you get | Install command |
| :--- | :--- | :--- |
| PM | requirement/spec, falsifiable acceptance criteria, adversarial pass. | `claude plugin marketplace add ryoochi0112/rstaff && claude plugin install rstaff-pm@rstaff` |
| data scientist | notebook, clean re-run of the notebook in a fresh kernel, fresh analysis reviewer. | `claude plugin marketplace add ryoochi0112/rstaff && claude plugin install rstaff-ds@rstaff` |
| AI engineer | prompt/model/tool change, pre-registered experiment verdict, fresh adjudicator. | `claude plugin marketplace add obra/superpowers-marketplace && claude plugin marketplace add ryoochi0112/rstaff && claude plugin install rstaff-ai@rstaff` |
| engineer | code change, your verify command (for example `make verify`), fresh reviewer. | `claude plugin marketplace add obra/superpowers-marketplace && claude plugin marketplace add ryoochi0112/rstaff && claude plugin install rstaff-engineer@rstaff` |

## What the gates guarantee — and what they do not

- We target an honest mistake, since rstaff catches honest mistakes only.
- It does not stop a user who deliberately forges evidence to evade the hooks.
- The bash deny is a policy guard, not a security boundary.
- After you change the tree, the completion gate blocks a stop until a green run of your verify command is recorded on that exact tree.
- It gives up after 3 blocks per tree, and when a hook times out.
- Records are not signed, as noted in the SECURITY.md file.
- It is also not enforced that verify itself is a good test.
- Set `RSTAFF_GATE=off` in the environment to disable the Stop-side check.
- A fresh context runs the review in a separate subagent context.
- We do not enforce that the reviewer is correct.
- If you skip the review, only the `/rstaff:ship` tree-match check remains.

## PM quick start

This path creates specs without superpowers. Install with the PM line in the table above.

Create control repo `acme` and start Claude Code:

```text
/rstaff:setup acme
```

```sh
export RSTAFF_HOME=~/rstaff-home
cd ~/rstaff-home && claude
```

Interview an idea and create a spec:

```text
/rstaff-pm:interview <idea>
/rstaff-pm:spec <TICKET-ID>
```

An invalid ticket blocks Stop. Fix in `backlog/acme.md`, run `node '<core>/scripts/lib-backlog.js' validate`, then Stop is allowed.

## Data scientist quick start

This path gates analysis notebooks. Create the environment and start `claude`:

```sh
python3 -m venv .venv && . .venv/bin/activate && pip install nbconvert ipykernel
claude plugin marketplace add ryoochi0112/rstaff
claude plugin install rstaff@rstaff
claude plugin install rstaff-ds@rstaff
claude
```

Point setup at your analysis folder and start Claude Code:

```text
/rstaff:setup <analysis-path>
```

```sh
export RSTAFF_HOME=~/rstaff-home
cd <analysis-path> && claude
```

The gate (`rstaff:nbgate`) checks notebooks:
- **Run order:** cells have counts 1..N in order.
- **Fresh run:** notebooks run in a fresh kernel.

`RSTAFF_NBGATE_PYTHON` sets Python (default `python3`). `RSTAFF_NBGATE_TIMEOUT` sets timeout in seconds (default 600). Skip notebooks using `.rstaff-nbignore` globs.

For a fresh-context review, run:

```text
/rstaff-ds:review <notebook>
```

To try, copy `~/.claude/plugins/marketplaces/rstaff/plugins/rstaff-ds/samples/analysis` to a new directory, run `git init`, then `/rstaff:setup <that-dir>`.

## AI engineer quick start

This path tests prompts using your Claude login. Log in:

```sh
claude auth login
```

Install plugins and copy the sample task:

```sh
claude plugin marketplace add obra/superpowers-marketplace
claude plugin marketplace add ryoochi0112/rstaff
claude plugin install rstaff@rstaff
claude plugin install rstaff-ai@rstaff
cp -R ~/.claude/plugins/marketplaces/rstaff/plugins/rstaff-ai/samples/label-task <work-dir>
claude
```

Setup the work folder and start Claude Code:

```text
/rstaff:setup <work-dir>
```

```sh
export RSTAFF_HOME=~/rstaff-home
cd <work-dir> && claude
```

Run the experiment:

```text
/rstaff-ai:experiment --confirm
```

To score the current prompt alone, run `/rstaff-ai:eval`.

Keep these files for custom tasks: `cases.jsonl` (inputs/answers), `prompts/control.md` and `prompts/candidate.md` (prompts), `grade.js` (scorer), `run.js` (runner). Run `/rstaff:setup <work-dir>` again after swapping files.

The optional `claude plugin install rstaff-ai-datadog@rstaff` needs Datadog and its connector.

## Engineer quick start

This path fixes failing tests. Log in:

```sh
claude auth login
```

Install plugins. Installing `rstaff-engineer` also installs `rstaff-pm` and `superpowers`.

```sh
claude plugin marketplace add obra/superpowers-marketplace
claude plugin marketplace add ryoochi0112/rstaff
claude plugin install rstaff@rstaff
claude plugin install rstaff-engineer@rstaff
```

Copy the sample and initialize git:

```sh
cp -R ~/.claude/plugins/marketplaces/rstaff/plugins/rstaff-engineer/samples/slugify <work-dir>
cd <work-dir>
git init && git add -A && git commit -m sample
claude
```

Setup the work folder and start Claude Code:

```text
/rstaff:setup <work-dir>
```

```sh
export RSTAFF_HOME=~/rstaff-home
cd <work-dir> && claude
```

Ask Claude to do the task in `<work-dir>/TASK.md`. Then run the check:

```sh
make verify
```

Ask for a fresh review:

```text
/rstaff:review HEAD
```

## Allowlisting your verify command

An allow rule like `Bash(make verify)` does not match the rewritten verify command. The fix is the anchored allow rule `Bash(node '<plugin root>/scripts/verify-run.js':*)`. Never use a wildcard rule for `verify-run.js`.

## More

- [USAGE.md](docs/USAGE.md) - Full walkthrough, also Codex delegation
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - System architecture
- [SECURITY.md](SECURITY.md) - Security policy and threat model
- [CONTRIBUTING.md](CONTRIBUTING.md) - Guidelines for contributing
- [CHANGELOG.md](CHANGELOG.md) - History of changes
- [THIRD_PARTY.md](THIRD_PARTY.md) - Third party licenses and attributions
- [LICENSE](LICENSE) - MIT license terms

## License

MIT, copyright Ryo Ochi. Borrowed mechanisms are MIT-licensed and attributed in `THIRD_PARTY.md`.
