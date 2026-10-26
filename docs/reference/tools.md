# Tools Reference

## Scope

This page is the complete catalog of the tools `opencode-sessions-explorer`
registers with the LLM. There are 18 tools: 17 are read-only and one
(`unarchive-session`) performs a single, deliberate write. Every tool is exposed
under the public key `opencode-sessions-explorer-<name>`; the short names below
(for example `get-session`) are used for brevity.

All tools read the OpenCode V2 tables (`session_v2`, `session_message`). Part ids
are synthesized as `<messageId>#<index>` (for example `msg_…#0`) because V2 stores
parts inline in `session_message.data.content[]`; legacy `prt_…` ids from 0.1.x
exports or older transcripts no longer resolve. See
[configuration.md](configuration.md#database-schema) for the schema.

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
| `get-part` | Fetches one fully decoded part by its `<messageId>#<index>` id (any other shape returns `NOT_FOUND`). Optionally dereferences an externalized tool-output file when `dereference_output_path:true` (path-guarded — see [configuration.md](configuration.md)). | Read |

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
| `search-text` | Regex full-text search across the bodies of all sessions (user prompts, assistant responses, tool input/output, reasoning). Surface- and channel-aware; supports a `role` filter and `group_by_session` rollups. | Read |
| `grep-session` | grep/regex search inside one session's exported body content (fast; operates on that session's part files only). Supports `fixed_string`, `case_sensitive`, `whole_word`, and `context_lines`. | Read |
| `search-tool-calls` | Finds tool invocations across sessions, filtered by tool name (exact or `LIKE` wildcard), status, or substring on input/output/error. Exact names match across the V1→V2 tool rename (see [Tool-Name Aliases](#tool-name-aliases)); each row keeps the raw recorded name. Returns capped snippets; cursor-paginated, newest-first. | Read |

## Cost And Usage Analysis

Aggregate spend, tokens, failures, and prompt patterns.

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `cost-by-project` | Aggregates cost and token usage grouped by `project_id`, `directory`, `agent`, or `model`, sorted by cost. Surfaces a `cost_known` flag for groups whose sessions predate the usage-tracking migration. | Read |
| `cost-by-period` | Time-series cost and tokens bucketed by `day`, `week`, or `month`, newest-first. Supports `tz_offset_min` to shift bucket boundaries to a local day. | Read |
| `list-tool-failures` | Aggregates tool errors grouped by `tool`, `error` message prefix, or `session`, sorted by count. `group_by:'tool'` merges renamed tools into one bucket under the canonical V2 name (see [Tool-Name Aliases](#tool-name-aliases)). | Read |
| `list-repeated-prompts` | Clusters sessions by the normalized prefix of their first user prompt to surface "have I asked this before" patterns. | Read |

## Health

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `db-stats` | Health and schema-drift probe for the OpenCode SQLite database: migration head (from the V2 `migration` table), table counts (`session_v2`, `session_message`), json1 status, `busy_timeout`, and drift warnings against the required V2 columns. | Read |

## Write

The single mutation surface in the plugin.

| Tool | What It Does | Read/Write |
| --- | --- | --- |
| `unarchive-session` | Restores a previously archived session: clears `session_v2.time_archived` **and** refreshes `session_v2.time_updated` so the session resurfaces at the top of OpenCode's recency-ordered list. Returns `NOT_FOUND` only when the id does not exist. | **Write** |

The write is intentionally narrow: it runs through an isolated, short-lived
read-write connection while every other tool uses a read-only handle. The
`time_updated` refresh is required, not cosmetic — the V2 session picker loads
`session_v2` ordered by `time_updated DESC, id DESC` with a default limit per
directory, so a long-archived
session would otherwise stay buried below that window and fail to open. See
[architecture.md](architecture.md) for the single-writer model.

### CLI Executables

These ship as standalone commands (run with `bunx`) for materializing and
maintaining the search export and for verifying install health.

| Executable | What It Does |
| --- | --- |
| `opencode-sessions-explorer-bulk-export` | Materializes (and incrementally refreshes) the filesystem search export tree from `session_message`. `--reset` removes `.last_sync` and `by-channel/` and rebuilds from scratch (run it once when upgrading from a 0.1.x/V1-era tree); `--root <path>` targets a non-default export root. |
| `opencode-sessions-explorer-dedupe-export` | One-shot maintenance that removes duplicate part files (same `msg_…#N` part id, different sequence prefix). Dry-run by default; pass `--apply` to delete. |
| `opencode-sessions-explorer-check-deps` | Install health probe: database reachability, schema head and drift, SQLite `json1`, `busy_timeout`, export tree, channel views, `ck` CLI, and tool-output directory. `--json` emits machine-readable output. |

## Part Types

Every part the V2 adapter enumerates is one of `text`, `reasoning`, `tool`, or
`compaction` — for imported (pre-V2) and V2-live data alike. These are the only
values accepted by `get-message` `part_types` and `session-timeline` `types`
(`session-timeline` shows `text`/`tool`/`reasoning` by default; pass
`types:['compaction']` for compaction markers). Compaction markers are not
searchable and are not exported.

## Tool-Name Aliases

OpenCode V2 renamed two built-in tools. Tool parts in imported V1-era history
record the old names; V2-live parts record the new ones:

| V1-era name | V2 name (canonical) |
| --- | --- |
| `bash` | `shell` |
| `task` | `subagent` |

- **Exact `tool` filters** (`search-tool-calls`, `list-tool-failures`) match both
  spellings: `tool:'bash'` and `tool:'shell'` return the same calls.
- **`LIKE` patterns** (a `tool` value containing `%` or `_`) are not expanded and
  match the raw recorded name only (`tool:'sh%'` finds only `shell` calls).
- **Per-tool aggregates** — `list-tool-failures` `group_by:'tool'`,
  `session-summary` `tools_top`, and `current-session` `counters.tools_by_name` —
  group by the canonical V2 name, so both eras merge into one bucket.
- **Rows that list individual calls** (`search-tool-calls`, `get-part`,
  `get-message`, `session-timeline`) keep the raw recorded name.
- **MCP calls**: after the V2 migration, MCP tools run inside Code Mode and are
  recorded as `execute` calls, not under their MCP tool names. Filters such as
  `tool:'github_%'` therefore only match V1-era history.

The alias table lives in `src/lib/tool-aliases.ts`.

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

Open one part from a search hit or timeline row (part ids are `<messageId>#<index>`):

```text
opencode-sessions-explorer-get-part { "part_id": "msg_…#2", "dereference_output_path": true }
```

Fresh install health flow:

```bash
bunx opencode-sessions-explorer-check-deps  # warnings for missing export/ck are okay initially
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

## Argument Validation

All tools validate raw arguments against their JSON Schema before executing
(`defineTool` → `validateArgs`). Rejected calls return the standard envelope with
`ok: false` and `error.code = "BAD_ARGS"`:

| Problem | Message fragment |
| --- | --- |
| Value outside an enum (also inside arrays) | `part_types[0]: got "patch"; allowed: "text" \| "tool" \| "reasoning" \| "compaction"` |
| Typo in an enum value | `… (did you mean "reasoning"?)` |
| Unknown parameter | `sessionId: unknown parameter (did you mean "session_id"?); allowed parameters: …` |
| Missing required parameter | `session_id: missing required parameter (string)` |
| Wrong type | `limit: expected integer, got string "10"` |
| Out of range | `max_part_bytes: got 10; must be 256..65536` |
| Retired parameter | tool-specific text, e.g. `mode` on `search-text` / `grep-session` |

All problems are reported in one message; `error.hint` is the full signature
(`Valid parameters (* = required): …`). `null` on an optional parameter is treated
as omitted. Through OpenCode V2 Code Mode the host pre-validates with the same
schema (coercing numeric strings and dropping unknown keys before the call reaches
the plugin), so the plugin-side messages are what non-Code-Mode clients see.

### Applied arguments in `meta`

Successful envelopes carry `meta.args` (the effective arguments: provided values
plus schema defaults) and `meta.args_defaulted` (keys that came from defaults).
Because Code Mode strips unknown keys before the call reaches the plugin, a
misspelled optional parameter cannot be rejected server-side; it shows up here
instead — e.g. `archvied: "only"` yields `meta.args.archived = "any"` with
`"archived"` in `meta.args_defaulted`. `BAD_ARGS` envelopes do not include these
fields.
