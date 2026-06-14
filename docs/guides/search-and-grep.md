# Search And Grep Guide

## Purpose

Search across the bodies of your entire OpenCode session history, grep inside one
known session, and audit individual tool invocations by name, status, or substring.

## Default Behavior

- `search-text` is the canonical "where in my history did X happen?" tool. Its
  default surface is `recall`: session-first, channel-aware, and evidence-limited,
  searching high-signal conversation and session-summary views before raw replay.
- The default `mode` is `regex` (a drop-in grep that needs no index and always
  works). `lex` adds BM25 phrase search (auto-builds a Tantivy index), while `sem`
  and `hybrid` add semantic embeddings.
- The default `role` is `any`. Natural-language questions like "where did I mention
  X" or "have I discussed Y" ask about appearances anywhere in the corpus — only set
  `role:'user'` when the question is explicitly about prompts you authored.
- For unscoped recall, results default to one row per matching session
  (`group_by_session`); scoped, single-session searches default to flat per-part hits.
- Snippets redact common secret shapes by default. Pass `redact:false` only for
  local forensics.

### The `ck` Dependency

`search-text` and `grep-session` shell out to the optional [`ck`](https://github.com/BeaconBay/ck)
CLI over the filesystem export tree. If `ck` is not installed, both return
`CK_NOT_FOUND` cleanly; the other 16 tools keep working without it. Normal `lex`,
`sem`, and `hybrid` searches invoke `ck` in that mode so `ck` can lazily build or
refresh its own indexes during the search. Explicit `ck --index .` or
`ck --reindex .` runs from the export root are optional prewarm/troubleshooting
steps, not required before first use. If an index is missing, stale, or partially
verified, the tools warn that the first/lazy-refresh run may be slow or partial. See
[search surfaces](../reference/search-surfaces.md) for the surface/channel model.

## Controls

| Tool | Use It For | Key Args |
| --- | --- | --- |
| `search-text` | Cross-session content search across all bodies (prompts, responses, tool I/O, reasoning, patches) | `q`, `mode` (`regex`/`lex`/`sem`/`hybrid`), `surface`, `channels`, `group_by_session`, `role`, `session_ids`, `project_id`, `agent`, `since_ms`/`until_ms`, `archived`, `limit`, `redact` |
| `grep-session` | Fast regex/lex grep inside one known session | `session_id`, `pattern`, `surface`, `channels`, `mode` (`regex`/`lex`), `fixed_string`, `case_sensitive`, `whole_word`, `context_lines`, `limit`, `redact` |
| `search-tool-calls` | Find tool invocations by name, status, or input/output/error substring | `tool` (exact or `LIKE` wildcard), `status`, `input_like`, `output_like`, `error_like`, `session_id`, `project_id`, `since_ms`/`until_ms`, `archived`, `limit`, `cursor` |

## Recommended Flow

1. For a broad recall question, start with `search-text` and let the default
   `recall` surface curate results:

   ```json
   { "q": "export codec", "limit": 20 }
   ```

1. Speed up cross-session search by pre-filtering scope. Unscoped full-corpus search
   can take 10-30 seconds; scoped searches return in under a second:

   ```json
   { "q": "retry backoff", "project_id": "global", "since_ms": 1717200000000 }
   ```

1. For exhaustive raw replay over tool output, reasoning, and patches, switch the
   surface:

   ```json
   { "q": "SQLITE_BUSY", "surface": "forensics" }
   ```

1. Once you know the session, grep inside it with `grep-session` (faster, narrower):

   ```json
   { "session_id": "ses_XYZ", "pattern": "TODO", "context_lines": 2 }
   ```

1. To audit commands rather than prose, use `search-tool-calls` — for example every
   failed `read`, or every Jira MCP call via a `LIKE` wildcard:

   ```json
   { "tool": "read", "status": "error", "limit": 20 }
   ```

   ```json
   { "tool": "mcp-atlassian_jira_%", "limit": 20 }
   ```

## Related Docs

- [Search surfaces](../reference/search-surfaces.md)
- [Recall and navigation](recall-and-navigation.md)
- [Export and maintenance](export-and-maintenance.md)
- [Tool reference](../reference/tools.md)
- [Troubleshooting](../support/troubleshooting.md)
