# Tools Reference

## Scope

This page is the complete catalog of the tools `opencode-sessions-explorer`
registers with the LLM. There are 18 tools: 17 are read-only and one
(`unarchive-session`) performs a single, deliberate write. Every tool is exposed
under the public key `opencode-sessions-explorer-<name>`; the short names below
(for example `get-session`) are used for brevity.

Tools are grouped by intent. The `Read/Write` column states whether the tool only
reads the OpenCode session database or mutates it. For the curated search surfaces
and channels that `search-text` and `grep-session` accept, see
[search-surfaces.md](search-surfaces.md). For the compact result shape that
list-shaped tools return, see [response-format.md](response-format.md).

## Recall And Navigation

Find your bearings and pull conversation content by id.

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `current-session` | Identifies the session the assistant is currently running in: id, message id, agent, model, directory, worktree, parent, cost-so-far, message/part/tool-call counters, child sessions, and useful filesystem paths (database, export tree, this session's export dir + `meta.json`). Pass `detail:'full'` for counters, children, and paths. | Read |
| `get-session` | Fetches one session's metadata and aggregate counts by id (parts by type, tool-call status breakdown, immediate child session ids). Returns no message bodies. | Read |
| `session-summary` | One-call human-readable overview: metadata, first and last user prompt, top files touched, top tools used (with completed/error counts), error count, duration, and cost. | Read |
| `session-timeline` | Chronological event stream — one row per part with a short per-type summary and no raw bodies. Filter by part type and time window; cursor-paginated. | Read |
| `get-message` | Fetches one message and its parts by message id. Each part body is capped via `max_part_bytes` to keep the response bounded. | Read |
| `get-part` | Fetches one fully decoded part by id. Optionally dereferences an externalized tool-output file when `dereference_output_path:true` (path-guarded — see [configuration.md](configuration.md)). | Read |

## Genealogy

Trace how sessions relate.

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `session-genealogy` | Walks the session parent/child tree to trace subagent dispatches and pair-execution chains. `direction` selects `ancestors` (up the `parent_id` chain), `descendants` (down to child sessions), or `both`. Depth-bounded by `max_depth`. | Read |

## Browse And Filter

List and filter sessions by structured metadata. Both return metadata only — never
message bodies.

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `list-sessions` | Browses sessions newest-first with combinable structured filters: `project_id`, `agent`, `model_id`, `directory_prefix`, `archived`, `since_ms`/`until_ms`, and `title_like`. Cursor-paginated. | Read |
| `search-sessions-meta` | Filters sessions by structured metadata plus cost/token thresholds (`min_cost`, `min_tokens_input`) — the same envelope as `list-sessions` with spend filters added. | Read |

## Content Search (ck-backed)

Search the bodies of sessions and the tool calls inside them. `search-text` and
`grep-session` shell out to the optional [`ck`](https://github.com/BeaconBay/ck)
CLI; if `ck` is absent they return `CK_NOT_FOUND` cleanly and the other tools keep
working. `search-tool-calls` queries the database directly and does not need `ck`.

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `search-text` | Full-text search across the bodies of all sessions (user prompts, assistant responses, tool input/output, reasoning, file references, patches, subtask prompts). Surface- and channel-aware; supports `regex`, `lex` (BM25), `sem`, and `hybrid` modes, a `role` filter, and `group_by_session` rollups. | Read |
| `grep-session` | grep/regex search inside one session's exported body content (fast; operates on that session's part files only). Supports `fixed_string`, `case_sensitive`, `whole_word`, and `context_lines`. | Read |
| `search-tool-calls` | Finds tool invocations across sessions, filtered by tool name (exact or `LIKE` wildcard), status, or substring on input/output/error. Returns capped snippets; cursor-paginated, newest-first. | Read |

## Cost And Usage Analysis

Aggregate spend, tokens, failures, and prompt patterns.

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `cost-by-project` | Aggregates cost and token usage grouped by `project_id`, `directory`, `agent`, or `model`, sorted by cost. Surfaces a `cost_known` flag for groups whose sessions predate the usage-tracking migration. | Read |
| `cost-by-period` | Time-series cost and tokens bucketed by `day`, `week`, or `month`, newest-first. Supports `tz_offset_min` to shift bucket boundaries to a local day. | Read |
| `list-tool-failures` | Aggregates tool errors grouped by `tool`, `error` message prefix, or `session`, sorted by count. | Read |
| `list-repeated-prompts` | Clusters sessions by the normalized prefix of their first user prompt to surface "have I asked this before" patterns. | Read |

## Health

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `db-stats` | Health and schema-drift probe for the OpenCode SQLite database: migration head, table counts (session/message/part), json1 status, `busy_timeout`, and drift warnings. | Read |

## Write

The single mutation surface in the plugin.

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `unarchive-session` | Restores a previously archived session: clears `session.time_archived` **and** refreshes `session.time_updated` so the session resurfaces at the top of OpenCode's recency-ordered list. Returns `NOT_FOUND` only when the id does not exist. | **Write** |

The write is intentionally narrow: it runs through an isolated, short-lived
read-write connection while every other tool uses a read-only handle. The
`time_updated` refresh is required, not cosmetic — OpenCode loads sessions ordered
by `time_updated DESC` with a default limit per directory, so a long-archived
session would otherwise stay buried below that window and fail to open. See
[architecture.md](architecture.md) for the single-writer model.

### CLI Executables

These ship as standalone commands (run with `bunx`) for materializing and
maintaining the search export and for verifying install health.

| Executable | What It Does |
| --- | --- |
| `opencode-sessions-explorer-bulk-export` | Materializes (and incrementally refreshes) the filesystem search export tree. `--reset` rebuilds from scratch; `--root <path>` targets a non-default export root. |
| `opencode-sessions-explorer-dedupe-export` | One-shot maintenance that removes duplicate part files (same part id, different sequence prefix). Dry-run by default; pass `--apply` to delete. |
| `opencode-sessions-explorer-check-deps` | Install health probe: database reachability, json1 extension, schema head and drift, export tree presence, and `ck` availability. `--json` emits machine-readable output. |

## Examples

Identify the current session, then summarize it:

```text
opencode-sessions-explorer-current-session   # returns this session's id
opencode-sessions-explorer-session-summary { "session_id": "ses_…" }
```

Find every failed `read` tool call in the last week:

```text
opencode-sessions-explorer-search-tool-calls { "tool": "read", "status": "error", "since_ms": 1717200000000 }
```

Search all sessions for a topic, rolled up per session:

```text
opencode-sessions-explorer-search-text { "q": "retry backoff", "group_by_session": true }
```

Materialize the search export once, then verify the install:

```bash
bunx opencode-sessions-explorer-bulk-export
bunx opencode-sessions-explorer-check-deps
```

Restore an archived session you located with `archived:'only'`:

```text
opencode-sessions-explorer-list-sessions { "archived": "only" }
opencode-sessions-explorer-unarchive-session { "session_id": "ses_…" }
```

## Related Docs

- Configuration and environment overrides: [configuration.md](configuration.md)
- Search surfaces and channels: [search-surfaces.md](search-surfaces.md)
- Compact result format: [response-format.md](response-format.md)
- Four-layer architecture: [architecture.md](architecture.md)
- Recall and navigation workflow: [../guides/recall-and-navigation.md](../guides/recall-and-navigation.md)
- Search and grep workflow: [../guides/search-and-grep.md](../guides/search-and-grep.md)
- Cost and usage analysis workflow: [../guides/cost-and-usage-analysis.md](../guides/cost-and-usage-analysis.md)
- Export and maintenance workflow: [../guides/export-and-maintenance.md](../guides/export-and-maintenance.md)
- Managing archived sessions: [../guides/manage-archived-sessions.md](../guides/manage-archived-sessions.md)
- Troubleshooting: [../support/troubleshooting.md](../support/troubleshooting.md)
