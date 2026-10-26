# Search Surfaces Reference

## Scope

This page documents the retrieval presets (`surface`) and the underlying channels
that `search-text` and `grep-session` use to decide *what* exported content to
search. Raw session data always stays lossless in the database and export tree;
channels are derived search views that let default recall search high-signal content
first while preserving raw drill-down through part and message ids.

Both tools accept a `surface` argument and an optional `channels` override. If you
pass `channels` explicitly, it takes precedence over the surface-derived set.

## Surfaces

A surface is a named preset that expands to a curated set of channels. The default
is `recall`.

| Surface | Channels Searched | Use For |
| --- | --- | --- |
| `recall` | `conversation`, `session-summary` | Default. Session-first, high-signal recall — "where did I mention X", "find sessions about Y". |
| `debug_trace` | `conversation`, `session-summary`, `tool-error`, `tool-input-summary` | Investigating failures and what led to them — errors, exceptions, stack traces, logs. |
| `tool_audit` | `tool-input-summary`, `tool-error` | Auditing tool usage — bash commands, tool calls, MCP calls, and their errors. |
| `code` | `conversation`, `session-summary`, `code-touch`, `tool-input-summary` | Tracing file and code changes — paths, diffs, edits, patches. |
| `forensics` | `raw` | Exhaustive replay over raw exported bodies, including full tool output and reasoning. Slowest; use when curated channels miss something. |

### Surface Inference

When `surface` is left at its default (`recall`), the query text is inspected and
the surface may be auto-promoted:

- Error vocabulary (`error`, `exception`, `stack trace`, `failed`, `timeout`,
  `logs`, `stderr`, `stdout`) promotes to `debug_trace`.
- Tool vocabulary (`tool calls`, `bash`, `command`, `grep`, `read tool`,
  `edit tool`, `apply_patch`, `mcp`, …) promotes to `tool_audit`.
- Code vocabulary (`file`, `path`, `class`, `function`, `symbol`, `diff`, `patch`,
  `edited`, `src/`, `.ts`, `.kt`, `.py`, …) promotes to `code`.

Passing an explicit non-`recall` surface disables inference and uses that surface
as-is.

## Channels

Channels are the derived views the export tree materializes under
`by-channel/<channel>/by-session/<ses_id>/`. The raw, lossless export lives under
`by-session/<ses_id>/` and is reachable through the `raw` channel.

| Channel | Contents |
| --- | --- |
| `conversation` | User, system, and assistant text. |
| `session-summary` | Per-session synthesized summary: title, directory, first and last user prompt. |
| `tool-input-summary` | Compact summary of each tool invocation's inputs (command, paths, query, ids). |
| `tool-error` | Normalized error text from failed tool calls. |
| `code-touch` | File paths from file-tool inputs (`filePath`, `path`, `paths`, `files`). |
| `tool-output` | Raw output bodies produced by tool calls. |
| `reasoning` | Assistant reasoning text. |
| `raw` | The full-fidelity per-session export, including every searchable body. Selected by the `forensics` surface. |

Channel documents are derived per part, where a part is one item of
`session_message.data.content[]` (or the `#0` text part of a user message) and is
identified as `<messageId>#<index>`. The V2 adapter enumerates only `text`,
`reasoning`, and `tool` parts (plus compaction markers, which are not searchable)
for imported and V2-live data alike, so these are the only channels that exist.
Export trees written by older releases may still contain `by-channel/patch-summary`
or `by-channel/file`; nothing writes them anymore, and a full reconcile (the
unbudgeted `bulk-export` run or the plugin's background reconcile) prunes them.

## Grep Defaults

`grep-session` defaults to the same curated channels as the active surface
(`recall` → `conversation`, `session-summary`) when the curated channel export is
available. To search the raw exported bodies of a single session — including tool
output and reasoning — set `surface:'forensics'` or pass `channels:['raw']`.

If the curated channel export is only partial (not yet backfilled), both tools fall
back to the raw `by-session` export to avoid false negatives and add a warning;
running `opencode-sessions-explorer-bulk-export --reset` backfills the curated
channels. Run the same `--reset` once after upgrading from a 0.1.x/V1-era export
tree so hits carry `msg_…#N` part ids instead of legacy `prt_` ids. See [export-and-maintenance.md](../guides/export-and-maintenance.md).

## Examples

Default recall search across all sessions:

```text
opencode-sessions-explorer-search-text { "q": "rate limiting" }
```

Force a raw forensic sweep with explicit channels:

```text
opencode-sessions-explorer-search-text { "q": "AKIA", "surface": "forensics" }
```

Grep one session's raw bodies (tool output included):

```text
opencode-sessions-explorer-grep-session { "session_id": "ses_…", "pattern": "ETIMEDOUT", "channels": ["raw"] }
```

Audit tool inputs and errors only:

```text
opencode-sessions-explorer-search-text { "q": "git push", "surface": "tool_audit" }
```

## Related Docs

- Tool catalog: [tools.md](tools.md)
- Compact result format: [response-format.md](response-format.md)
- Four-layer architecture: [architecture.md](architecture.md)
- Search and grep workflow: [../guides/search-and-grep.md](../guides/search-and-grep.md)
- Export and maintenance workflow: [../guides/export-and-maintenance.md](../guides/export-and-maintenance.md)
- Troubleshooting: [../support/troubleshooting.md](../support/troubleshooting.md)
