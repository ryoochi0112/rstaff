---
name: datadog-llmobs-analysis
description: Use when analyzing a production LLM application's usage, behavior, cost, or user satisfaction from Datadog LLM Observability (LLM Obs) — counting agent turns/threads/users, comparing this month vs last month, segmenting report-vs-chat features, sampling real conversations, or attributing a usage change to a deploy. Load BEFORE issuing the first Datadog MCP query: the naive paths (span pagination for counts, APM spans, logs) burn the tool budget and return wrong answers. Do not load it to design an eval (use rstaff-ai:agent-evaluation) or to run a controlled experiment (use rstaff-ai:experiment-design).
---

# Datadog LLM Obs analysis — aggregate server-side, read raw only for samples

A measured baseline agent given 15 Datadog calls and a two-part counting task
failed both parts: it paginated spans to count, concluded "spans carry no user
ID" (they do — on llm-kind spans only), never found the DDSQL table, and spent
its last calls on 500s. Everything it needed is below.

## The retention ladder (decides your data source before any query)

| Source | Retention | Grain | Use for |
|---|---|---|---|
| DDSQL `dd.llm_observability` | ~15 days minus ~2-day index lag | span-level SQL | all counting/segmentation in the recent window |
| `ml_obs.*` metrics | 15 months | daily series by ml_app/span_kind/model_name/error/version | month-over-month trends, deploy correlation |
| APM `trace.<framework>.request.hits` by `resource_name` | 15 months | endpoint request counts | demand ground truth when LLM instrumentation changed |
| LLM Obs span search (MCP `search_llmobs_spans`) | ~15 days | full span payloads | reading sampled conversations only — never counting |
| Logs | days (often ~7 hot) | app-specific | last resort; check retention first |

**Month-over-month questions are metric questions.** Raw spans from last month
are usually gone; do not report "no data in July" — report "raw retention
expired; using metrics" (欠測は無検出ではない).

## Data model (verify once per app, then rely on it)

- One user turn = one trace; the root span is the orchestrator (e.g. name
  `LangGraph`, kind workflow). Its output value holds the full serialized
  conversation state — reading the latest turn's root output gives the whole
  thread in one call.
- **Identity/session tags live on llm-kind spans only**: `employee.id` /
  `user.id`, `company.id`, `thread.id`, `agent.name`, `agent.model`. Root,
  tool, and embedding spans do NOT carry them. An agent that inspects only the
  root span will wrongly conclude no user attribution exists.
- Tool usage lives on tool-kind spans (`@name` = tool name); they share
  `trace_id_low` with the llm spans of the same turn — classify turns by
  feature with a JOIN, not by reading traces.
- `ml_app` is the LLM Obs app name and may differ from the service/repo name.
  Discover it: `search_llmobs_spans` with no filter, 1 result.

## DDSQL recipe (the workhorse — validated syntax)

```sql
SELECT date_trunc('day', "timestamp") AS d,
       COUNT(DISTINCT trace_id_low)  AS turns,
       COUNT(DISTINCT "employee.id") AS users
FROM dd.llm_observability(
  columns => ARRAY['timestamp','trace_id_low','employee.id'],
  scope => 'production', event_type => 'span',
  filter => '@ml_app:my-app @meta.span.kind:llm thread.id:*',
  from_timestamp => TIMESTAMP '2026-08-16 00:00:00+00:00',
  to_timestamp   => TIMESTAMP '2026-08-28 00:00:00+00:00')
AS ("timestamp" TIMESTAMP, trace_id_low VARCHAR, "employee.id" VARCHAR)
GROUP BY 1 ORDER BY 1
```

Syntax rules that cost a query each if guessed wrong:
- Every referenced field must appear in BOTH `columns => ARRAY[...]` and the
  `AS (...)` column list, `timestamp` included. Quote dotted/at-names: `"@name"`.
- Filter syntax: indexed event fields take `@` (`@name`, `@meta.span.kind`,
  `@status`, `@meta.output.value`, `@is_root_span`); **plain span tags take no
  `@`** (`thread.id:*`, `employee.id:<id>`, `agent.name:production-chat-agent`).
  OR needs parentheses: `(@name:a OR @name:b)`. `-` prefix negates.
- `from_timestamp`/`to_timestamp` must be passed together; `+09:00` offsets
  work; the `Z` suffix does not.
- `date_trunc` buckets in UTC; `AT TIME ZONE` / `+ INTERVAL` inside it are
  rejected. For JST-day precision group by hour and reshape locally, or accept
  UTC days and say so.
- **A WHERE clause on a content field (e.g. `... WHERE "@meta.output.value"
  LIKE '%x%'`) can silently return ZERO rows** — the predicate is pushed into
  the event search, which does not evaluate LIKE. Filter content rows with
  `SUM(CASE WHEN col LIKE ... THEN 1 ELSE 0 END)` or a CASE bucket in GROUP BY
  (ELSE '-'), never with WHERE. A zero-row result from such a WHERE proves
  nothing.
- Tool errors may hide inside success envelopes: `@status:error` can be ~0
  while outputs contain nested-JSON `\"error\"` payloads. Count both channels
  before reporting an error rate.
- JOINs and CTEs across two `dd.llm_observability(...)` calls work — the
  feature-classification pattern:

```sql
WITH turns AS (SELECT trace_id_low, MAX("employee.id") AS emp FROM dd.llm_observability(
       columns => ARRAY['trace_id_low','employee.id'], scope => 'production', event_type => 'span',
       filter => '@ml_app:my-app @meta.span.kind:llm thread.id:*',
       from_timestamp => ..., to_timestamp => ...) AS (trace_id_low VARCHAR, "employee.id" VARCHAR)
     GROUP BY 1),
rpt AS (SELECT trace_id_low FROM dd.llm_observability(
       columns => ARRAY['trace_id_low'], scope => 'production', event_type => 'span',
       filter => '@ml_app:my-app @meta.span.kind:tool (@name:delegate_to_team_reporter OR @name:delegate_to_company_reporter)',
       from_timestamp => ..., to_timestamp => ...) AS (trace_id_low VARCHAR) GROUP BY 1)
SELECT COUNT(*) AS total_turns, COUNT(rpt.trace_id_low) AS report_turns
FROM turns LEFT JOIN rpt ON turns.trace_id_low = rpt.trace_id_low
```

  The JOIN is only needed when you must also count the complement (report
  vs chat shares). A bare feature count is one query: `COUNT(DISTINCT
  trace_id_low)` on the tool-kind spans alone.

- Field discovery: `ddsql_schema_search_tables` query "llm", then
  `ddsql_schema_search_unstructured_fields` on `public.dd.llm_observability`
  (use `field_query` to find e.g. `thread`). If the table search comes back
  empty, retry with the bare keyword before concluding the table is absent.
- An empty result for an old window means retention, not zero usage. Probe the
  data floor by WIDENING your first daily counting query's window — one query
  then yields both the answer and the observed first/last data day.
- Distinct-user counts exist ONLY in the raw window: no `ml_obs` metric
  carries a user identity tag, so never promise last month's user counts.

## Metric recipes (history + deploy correlation)

- Daily series: `get_datadog_metric` with
  `sum:ml_obs.span{ml_app:my-app} by {span_kind}.as_count()`,
  `interval: 86400000`, `raw_data: true`. Also `ml_obs.trace`,
  `ml_obs.trace.duration` (avg = latency UX trend), `ml_obs.span.error`,
  `ml_obs.span.llm.*.tokens|cost` — groupable by `model_name`.
- `model_name` is the only behavioral segment metrics keep. If each agent
  pins a distinct model, model series = per-agent usage history — but confirm
  the current agent↔model map in DDSQL first, and check git history for model
  swaps before reading a model shift as an agent shift.
- Demand ground truth: `sum:trace.fastify.request.hits{service:my-svc} by {resource_name}.as_count()`
  (find the framework metric via `search_datadog_metrics` with
  `tag_filter: service:...`). Endpoint hits are unaffected by LLM
  instrumentation changes — use them to separate "users left" from
  "instrumentation changed".
- Correlate any step change with deploys: `git log -S '<model-or-flag>'` in the
  service repo around the inflection date; llm spans' first day with a new
  `model_name` pins the deploy date.

## Reading conversations (samples only)

1. Pick thread ids + strata in DDSQL (depth buckets via
   `COUNT(DISTINCT trace_id_low)` per `thread.id`).
2. `search_llmobs_spans` with `tags: {"thread.id": "<id>"}` → llm spans carry
   `trace_id`; take the latest.
3. `search_llmobs_spans(trace_id=..., span_name="LangGraph", root_spans_only=true)`
   → root `span_id` → `get_llmobs_span_content(field="output", max_tokens≈6000)`.
4. Fan sampling out to subagents (≈25 threads each) returning compact
   classifications — never stream raw conversations into the coordinating
   context, and never include personal names in what comes back.

## Cost discipline

- Counting by paginating `search_llmobs_spans` is always wrong — each span
  summary is several KB and there is no total count. Aggregate in DDSQL.
- Budget rule of thumb: structure discovery ≤5 calls, aggregates ≤10, then
  sampling. If a preview endpoint 500s twice, switch data source instead of
  retrying a third time.
- State the validation basis with results: window actually covered, UTC vs
  JST bucketing, which spans carry the tags you counted on (coverage query:
  `COUNT(*)` vs `COUNT("employee.id")` by span kind).

## Common mistakes

| Mistake | Reality |
|---|---|
| "Spans have no user ID" after checking root/tool spans | Identity tags are on llm-kind spans only — run the coverage query |
| Counting turns via span search pagination | DDSQL `COUNT(DISTINCT trace_id_low)` on llm spans, or root-span count |
| "No July data" reported as zero usage | 15-day raw retention; say expired, switch to metrics |
| Querying the newest 2 days in DDSQL and trusting the zeros | ~2-day index lag; the span-search MCP still sees them |
| Reading a model-mix shift as user behavior | Check git for a model swap first; models are pinned per agent |
| Reporting monthly totals across a holiday/survey cycle | Compare weekday means of matched sub-periods; name the confounders |
| APM spans for LLM analysis | APM traces are sampled; use them only for endpoint hit metrics |
