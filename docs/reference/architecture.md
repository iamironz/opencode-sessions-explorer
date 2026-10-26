# Architecture Reference

## Scope

This page describes the four-layer pipeline that turns the OpenCode session
database into enriched, searchable tool responses, and the single-writer exception
to the otherwise read-only design. It is a conceptual reference; for the
contributor-facing build and code layout, see the
[Development Guide](../maintainers/development.md).

## The Four Layers

```
L1  SQLite DB (read-only source of truth)
      | PRAGMA query_only = 1; opened readonly
      v
L2  filesystem export tree (~/.local/share/opencode-sessions-explorer)
      | by-session/<ses_id>/...  +  by-channel/<channel>/by-session/<ses_id>/...
      | delta-synced before each search call
      v
L3  ck regex scan (stateless; optional)
      | walks the export tree; no index to build or refresh
      v
L4  enriched response
      | re-fetches session/part metadata from SQLite per hit
      v
    { ok, data, meta, warnings } envelope
```

### L1 — SQLite Source Of Truth

The OpenCode database is the authoritative source. The shared handle opens it
read-only and sets `PRAGMA query_only = 1` as a belt-and-braces guard, so any
accidental write through that handle throws. The live OpenCode process may be
writing concurrently — the database runs in WAL mode and multiple readers plus a
writer is safe, with a `busy_timeout` covering rare lock collisions. All metadata,
counts, and message/part bodies ultimately come from here.

The plugin reads only the OpenCode V2 tables: `session_v2` (one row per session)
and `session_message` (one row per message, ordered by `seq` within a session).
Parts are not rows: they live **inline** in `session_message.data.content[]`, and
`src/lib/v2-parts.ts` enumerates them under synthesized ids `<messageId>#<index>`
(user/system/synthetic text and compaction markers are `#0`). Imported pre-V2 and
V2-live rows share the same shape. The legacy V1 `session` / `message` / `part`
tables are frozen at the V2 migration and are not read. Column-level detail is in
[configuration.md](configuration.md#database-schema).

### L2 — Filesystem Export Tree

Searchable content is materialized to a filesystem tree (default
`~/.local/share/opencode-sessions-explorer`, overridable via
`OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`). It has two arms:

- `by-session/<ses_id>/` — the raw, lossless per-part export plus `meta.json`. Each
  part is one file named `<seq5>-<messageId>#<index>.txt` (for example
  `00004-msg_…#0.txt`); the `#` is preserved so the part id round-trips through the
  filename.
- `by-channel/<channel>/by-session/<ses_id>/` — curated channel views derived from
  the raw parts (see [search-surfaces.md](search-surfaces.md)), plus a
  `session-summary` document per session.

The tree is built once by `opencode-sessions-explorer-bulk-export` and then
delta-synced automatically before each `search-text` / `grep-session` call, so new
parts become searchable without a manual re-export. Sync enumerates parts from
`session_message`: budgeted sync uses a message-id keyset insert cursor for newly
appended messages, plus session-dirty scans keyed by `session_v2.time_updated` to
re-export sessions whose part status or metadata changed (each dirty session keeps
its own message-id cursor). Short search-triggered syncs also schedule a throttled
background reconcile, while unbudgeted bulk exports perform full tombstone cleanup
inline.

Sync state lives in `<export root>/.last_sync` as schema `v4`. Older v1–v3 states
were keyed on V1 `prt_` part ids and are migrated to a fresh v4 state, which forces
a full re-export; tombstone reconcile then removes the stale `prt_`-keyed files.

### L3 — ck Regex Scan (Optional)

`search-text` and `grep-session` shell out to the [`ck`](https://github.com/BeaconBay/ck)
CLI as a stateless regex scanner over the export tree; there is no index to build,
refresh, or verify. `ck` is optional: when it is absent these two tools return
`CK_NOT_FOUND` cleanly and the other 16 tools are unaffected.

### L4 — Enriched Response

Search hits from `ck` carry file paths, not domain objects. The final layer parses
the session and part ids out of each hit path and re-fetches fresh metadata from
SQLite (session title, agent, model, part type, message role) before returning
results. Every tool wraps its payload in a uniform `{ ok, data, meta, warnings }`
envelope; list-shaped data inside `data` uses the compact format described in
[response-format.md](response-format.md).

## Single-Writer Exception

The plugin is read-only with exactly one sanctioned write: `unarchive-session`.
Reads never write through the shared read-only handle. The write goes through a
separate, short-lived read-write connection that performs a single statement —
`UPDATE session_v2 SET time_archived = NULL, time_updated = <now>` — and closes
immediately.

Both fields are updated deliberately. The V2 session picker (`SessionStore.list`)
loads `session_v2` ordered by `time_updated DESC, id DESC`, filtering archived rows
via `time_archived IS NULL`, with a default limit per directory, so clearing `time_archived`
alone would leave a long-archived session buried below that window, and opening it
would fail with "Unable to retrieve session". Refreshing `time_updated` resurfaces
the session at the top of the list, which is also the intuitive meaning of
"restore". OpenCode exposes no HTTP or SDK endpoint that can *clear* the archived
flag, so the direct database write is the only mechanism.

## Examples

Materialize the export tree (L2):

```bash
bunx opencode-sessions-explorer-bulk-export
```

Verify all four layers are healthy:

```bash
bunx opencode-sessions-explorer-check-deps
```

## Related Docs

- Tool catalog: [tools.md](tools.md)
- Search surfaces and channels: [search-surfaces.md](search-surfaces.md)
- Compact result format: [response-format.md](response-format.md)
- Configuration and environment overrides: [configuration.md](configuration.md)
- Export and maintenance workflow: [../guides/export-and-maintenance.md](../guides/export-and-maintenance.md)
- Development Guide: [../maintainers/development.md](../maintainers/development.md)
- Troubleshooting: [../support/troubleshooting.md](../support/troubleshooting.md)
