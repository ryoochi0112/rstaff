---
name: data-science
description: Conventions for notebook and analysis work — exploratory data analysis on a CSV or table, cleaning up or reviewing an analysis notebook, drawing conclusions from data. Load when editing or writing a .ipynb, profiling a dataset, or reporting findings. Do not load for application code, a bug fix in a service or library, or a question that needs no data analysis.
---

# Data science — notebook conventions

A notebook is a deliverable, not a scratchpad. These rules keep an analysis
reproducible, honest, and safe to share.

## Done means it re-runs
A notebook is done only when it survives **Restart & Run All** from a fresh kernel
and is saved in run order: code cells numbered 1, 2, … n with no gaps and no
`null`. A notebook that works only because of hidden state from a deleted or
out-of-order cell is broken.

The gate for this is `rstaff:nbgate`: a fresh-kernel re-run of every notebook in the
repo plus a run-order check. It runs on a throwaway copy, so your tree is not
changed. Run it before you say the work is done.

## Look before you conclude
1. **Inspect first.** Check shape, dtypes, nulls, ranges, duplicates, and the key's
   uniqueness before computing anything you will report.
2. **State validation checks** in the notebook, as a cell the reader can see, before
   any conclusion. Say what you checked and what you found, including what failed.
3. **State assumptions** (filters, units, time window, how nulls and outliers were
   treated, what "customer" or "active" means) before the conclusion that rests on
   them.
4. **Conclusions follow evidence.** Quote the number, the sample size, and the
   comparison. Separate what the data shows from what you infer. Say when the sample
   is too small or the effect is within noise.
5. **Persist findings.** Put results and caveats in the notebook's closing markdown
   cell (or the repo's notes), not only in chat.

## Output hygiene
- Print `.head()`, `.shape`, `.describe()`, or aggregates. Never print a full table
  or a long list; the output bloats the file and the context.
- Never print or store secrets: tokens, keys, passwords, connection strings. Read
  them from the environment and never echo them.
- Raw data is immutable. Read from `data/raw/`; write derived data elsewhere, and
  never overwrite a raw file.
- Keep seeds fixed where randomness matters, and pin the inputs a result depends on.
- Before running a query on a large table, estimate its cost, and test on a sample
  first. Run it at full size only after the estimate is acceptable.

## Cleaning up a notebook
Remove dead and duplicated cells, move imports and parameters to the top, name the
intermediate frames, put each check in its own cell, and finish with Restart & Run
All. Do not change results while tidying; if a number moves, find out why.

## Review checklist
An independent reviewer judges a notebook against these five items. Each finding
cites a cell.
- `validation`: the notebook states what it checked (schema, nulls, ranges, duplicates) and what it found, before any conclusion.
- `assumptions`: the notebook states its assumptions (filters, units, window, handling of nulls) before the conclusion that depends on them.
- `no-dumps`: no cell prints a full table or a long list; outputs are head-sized slices or aggregates.
- `raw-immutable`: nothing writes to or overwrites a file under the raw data location.
- `no-secrets`: no cell source or output contains a token, key, password, or connection string.

Run `/rstaff-ds:review <notebook>` to get this check from a fresh context. Its
verdict is advisory; the done signal stays `rstaff:nbgate`.
