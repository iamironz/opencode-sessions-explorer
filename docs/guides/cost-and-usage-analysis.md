# Cost And Usage Analysis Guide

## Purpose

Quantify OpenCode spend and token usage across your session history, and surface
recurring failures and repeated prompts.

## Mental Model

All four tools aggregate the `session` and `part` tables directly — no export tree
or `ck` index required. Pick the tool by the shape of the answer you want:

- **Spend by dimension** — `cost-by-project` groups by project, directory, agent, or
  model.
- **Spend over time** — `cost-by-period` buckets the same data by day, week, or month.
- **Failure signal** — `list-tool-failures` aggregates errored tool calls.
- **Repetition signal** — `list-repeated-prompts` clusters sessions by their first
  user prompt.

### The `cost_known` Flag

Sessions created before OpenCode's `session_usage` migration store `cost = 0` even
though they were not actually free. `cost-by-project` reports `cost_known: false` for
any group whose sessions are all pre-migration, and `cost-by-period` hides
zero-valued buckets unless you pass `include_zero_buckets: true`. Treat a zero with
`cost_known: false` as "unknown", not "$0".

## Controls

| Tool | Use It For | Key Args |
| --- | --- | --- |
| `cost-by-project` | "Spend by project / agent / model", "which directory burned the most tokens" | `group_by` (`project_id`/`directory`/`agent`/`model`), `since_ms`/`until_ms`, `archived`, `min_cost`, `min_tokens`, `top` |
| `cost-by-period` | "Daily/weekly/monthly spend", "cost trend over time" | `bucket` (`day`/`week`/`month`), `since_ms`/`until_ms`, `project_id`, `agent`, `tz_offset_min`, `min_cost`, `include_zero_buckets`, `max_buckets` |
| `list-tool-failures` | "Which tool fails most", "what errors keep recurring", "sessions with the most failures" | `group_by` (`tool`/`error`/`session`), `tool`, `error_like`, `since_ms`/`until_ms`, `archived`, `limit`, `error_prefix_chars` |
| `list-repeated-prompts` | "Have I asked this before", "my most repeated prompts" | `min_count`, `prefix_chars`, `since_ms`/`until_ms`, `archived`, `limit`, `sample_per_group` |

## Recommended Flow

1. Start broad with a spend breakdown by project:

   ```json
   { "group_by": "project_id", "top": 20 }
   ```

1. Compare models or agents by switching `group_by`:

   ```json
   { "group_by": "model" }
   ```

1. Look at the trend over time, shifting bucket boundaries to your local day if
   needed (`tz_offset_min` is positive when ahead of UTC):

   ```json
   { "bucket": "day", "tz_offset_min": 120 }
   ```

1. Find what breaks most often, then expand a group with `search-tool-calls`:

   ```json
   { "group_by": "tool", "limit": 20 }
   ```

1. Detect duplicated work by clustering opening prompts:

   ```json
   { "min_count": 3, "prefix_chars": 80 }
   ```

## Related Docs

- [Recall and navigation](recall-and-navigation.md)
- [Search and grep](search-and-grep.md)
- [Tool reference](../reference/tools.md)
- [Response format](../reference/response-format.md)
