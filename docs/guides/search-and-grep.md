# Search And Grep Guide

## Purpose

Search across the bodies of your entire OpenCode session history, grep inside one
known session, and audit individual tool invocations by name, status, or substring.

## Default Behavior

- `search-text` is the canonical "where in my history did X happen?" tool. Its
  default surface is `recall`: session-first, channel-aware, and evidence-limited,
  searching high-signal conversation and session-summary views before raw replay.
- The default `mode` is `regex` (a drop-in grep that needs no index and always
  works). `lex` adds BM25 phrase search over the FTS sidecar and is always
  treated as text, never as a regular expression, regardless of
  metacharacters in the query (so `v1.2.3` or `C++` under `lex` searches for
  that literal text). `sem` and `hybrid` add semantic embeddings via `ck`.
- The default `role` is `any`. Natural-language questions like "where did I mention
  X" or "have I discussed Y" ask about appearances anywhere in the corpus — only set
  `role:'user'` when the question is explicitly about prompts you authored.
- For unscoped recall, results default to one row per matching session
  (`group_by_session`); scoped, single-session searches default to flat per-part hits.
- Snippets redact common secret shapes by default. Pass `redact:false` only for
  local forensics.

### How A Query Picks Its Backend

You never pick a search engine directly — a planner routes each query to one
of three backends:

- **`fts`** — a SQLite FTS5 sidecar, built from the OpenCode database. Serves
  a literal query with a usable 3+ character run and `lex` (BM25) mode, as
  long as it has been built and covers the requested channels. Latency
  ranges from single-digit milliseconds for a selective identifier to
  several hundred milliseconds for a common short word — see
  [architecture.md](../reference/architecture.md#latency) for measured
  numbers. Build/refresh it once with `opencode-sessions-explorer-fts-build`;
  `search-text` also delta-syncs it on every call.
- **`rg`** (ripgrep) — serves real regex patterns (anything with `.*`, `|`,
  `[]`, `^`, `$`, etc.), the `raw` channel, a literal/`lex` query shorter than
  3 characters, and any query the `fts` tier can't answer (missing index, or
  requested channels outside its coverage). Also the only backend
  `grep-session` uses — `grep-session` has no `fts` tier at all. Required
  whenever the planner picks it as the primary backend: if `rg` is missing
  at that point, the call fails with a hard `RG_NOT_FOUND` error rather than
  silently falling back to `ck`. Install it with `brew install ripgrep`
  (macOS), `apt install ripgrep` (Debian/Ubuntu), or `cargo install ripgrep`,
  or point `OPENCODE_SESSIONS_EXPLORER_RG_BIN` at an existing binary.
- **`ck`** — used only for `sem`/`hybrid` semantic-embedding modes. Optional;
  if absent, only those two modes return `CK_NOT_FOUND`.

Passing `fixed_string:true` guarantees the query is eligible for the `fts`
path (subject to the 3-character floor and index coverage above) rather than
being evaluated as a live regex. If a backend returns zero hits, `search-text`
automatically escalates to the next backend in the plan (`fts` -> `rg`; `ck`
is never used as a fallback for literal/regex, since it reads the same file
tree `rg` already searched) so recall never regresses on that axis — this
happens transparently and is reported via the `backend`, `backends_tried`,
and `plan_reason` response fields. Escalation only fires on **zero** hits for
the whole query, so a term that exists both in an indexed `tool-output`
excerpt and in an omitted middle (see
[architecture.md](../reference/architecture.md#fts-coverage-limitations))
surfaces only the indexed occurrence. See
[architecture.md](../reference/architecture.md) for the full planner rules,
the ASCII-only case-folding limitation, and the `tool-output` excerpt
trade-off.

### The `ck` Dependency (`sem`/`hybrid` Only)

`search-text` shells out to the optional [`ck`](https://github.com/BeaconBay/ck)
CLI over the filesystem export tree, but only for `sem`/`hybrid` modes. If `ck`
is not installed, those two modes return `CK_NOT_FOUND` cleanly; every other
search path — literal, `lex`, `regex`, and all of `grep-session` — keeps
working without it. Normal `sem`/`hybrid` searches invoke `ck` in that mode so
`ck` can lazily build or refresh its own indexes during the search. Explicit
`ck --index .` or `ck --reindex .` runs from the export root are optional
prewarm/troubleshooting steps, not required before first use. If an index is
missing, stale, or partially verified, the tool warns that the first/lazy-
refresh run may be slow or partial. See
[search surfaces](../reference/search-surfaces.md) for the surface/channel
model.

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

1. Speed up cross-session search by pre-filtering scope. Indexed literal recall
   (the `fts` backend) is near-instant regardless of scope; an unscoped raw or
   forensic scan (the `rg` tier over the full export tree) can still take
   several seconds to tens of seconds. Pre-filtering always helps the file-tree
   backends and never hurts:

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
