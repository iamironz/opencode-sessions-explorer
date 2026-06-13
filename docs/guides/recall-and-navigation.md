# Recall And Navigation Guide

## Purpose

Find a past OpenCode session, understand what it contains, and drill from a
high-level overview down to a single message or part — including the parent/child
chains created by subagent dispatch.

## Mental Model

Orient first, then drill down; walk the tree to follow subagent and
pair-execution chains.

- **Orient.** `current-session` tells the assistant which session it is running in
  (id, agent, model, directory, counts, and useful filesystem paths). It is the
  natural first call because the model has no native way to know its own session id.
- **Find and browse.** `list-sessions` and `search-sessions-meta` locate sessions by
  recency or structured metadata (agent, directory, title, cost, tokens). Neither
  returns message bodies.
- **Overview.** `get-session` returns one session's metadata and aggregate counts;
  `session-summary` returns a human-readable overview (first/last prompt, top files
  touched, top tools, errors, duration, cost).
- **Reconstruct.** `session-timeline` returns a chronological event stream (one
  short line per part) without raw bodies.
- **Drill into detail.** `get-message` fetches one turn and its parts (bodies
  capped); `get-part` fetches a single part and can dereference externalized
  tool-output files.
- **Trace relationships.** `session-genealogy` walks the `parent_id` chain up to
  ancestors and down to descendants — the graph that subagent dispatches create.

## Entry Points

| Tool | Answers | Key Args |
| --- | --- | --- |
| `current-session` | "What session am I in?", "where am I?", self-orientation | `detail` (`compact`/`full`), `include_suggestions` |
| `list-sessions` | "List my recent sessions", "sessions from last week", "sessions using agent X" | `limit`, `cursor`, `project_id`, `agent`, `model_id`, `directory_prefix`, `archived`, `since_ms`/`until_ms`, `title_like` |
| `search-sessions-meta` | "Sessions costing more than $5", "sessions with > 100K input tokens", "most expensive session" | `title_like`, `directory_like`, `project_id`, `agent`, `model_id`, `min_cost`, `min_tokens_input`, `since_ms`/`until_ms`, `archived` |
| `get-session` | "Metadata for `ses_X`", "how many messages/parts in `ses_Y`", "who is the parent of `ses_X`" | `session_id` |
| `session-summary` | "Summarize `ses_X`", "what files did I touch", "what tools did I use" | `session_id`, `max_prompt_bytes` |
| `session-timeline` | "Walk `ses_X` step by step", "show only the tool calls in order" | `session_id`, `types`, `granularity`, `from_ts`/`until_ts`, `limit`, `cursor` |
| `get-message` | "Fetch message `msg_X` with its parts" | `message_id`, `include_part_data`, `part_types`, `max_part_bytes` |
| `get-part` | "Show part `prt_X`", "dereference the externalized output of `prt_Z`" | `part_id`, `max_bytes`, `dereference_output_path` |
| `session-genealogy` | "Parent chain of `ses_X`", "what subagents did `ses_Y` spawn" | `session_id`, `direction` (`ancestors`/`descendants`/`both`), `max_depth`, `include_archived` |

## Recommended Flow

1. Start with `current-session` to capture your own `session_id` and context.

   ```json
   { "detail": "full" }
   ```

1. If you do not yet know the session, narrow with `list-sessions` (recency) or
   `search-sessions-meta` (cost/token/title thresholds).

   ```json
   { "agent": "build", "since_ms": 1717200000000, "limit": 20 }
   ```

1. Get the gist with `session-summary`, or raw counts with `get-session`.

   ```json
   { "session_id": "ses_XYZ", "max_prompt_bytes": 2048 }
   ```

1. Reconstruct the flow with `session-timeline`, filtering `types` to keep it tight.

   ```json
   { "session_id": "ses_XYZ", "types": ["tool", "patch"], "limit": 100 }
   ```

1. Expand a specific event with `get-message` (whole turn) or `get-part` (one part).
   For tool output that was externalized to a file, set `dereference_output_path`:

   ```json
   { "part_id": "prt_ABC", "dereference_output_path": true }
   ```

1. Trace dispatch chains with `session-genealogy` when a session spawned subagents.

   ```json
   { "session_id": "ses_XYZ", "direction": "both", "max_depth": 5 }
   ```

## Related Docs

- [Search and grep](search-and-grep.md)
- [Tool reference](../reference/tools.md)
- [Response format](../reference/response-format.md)
- [Getting Started](../getting-started.md)
