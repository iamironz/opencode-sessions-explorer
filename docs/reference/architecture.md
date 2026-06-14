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
L3  ck index (.ck/, BM25 + embeddings; optional)
      | incremental; built by the ck CLI
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

### L2 — Filesystem Export Tree

Searchable content is materialized to a filesystem tree (default
`~/.local/share/opencode-sessions-explorer`, overridable via
`OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`). It has two arms:

- `by-session/<ses_id>/` — the raw, lossless per-part export plus `meta.json`.
- `by-channel/<channel>/by-session/<ses_id>/` — curated channel views derived from
  the raw parts (see [search-surfaces.md](search-surfaces.md)).

The tree is built once by `opencode-sessions-explorer-bulk-export` and then
delta-synced automatically before each `search-text` / `grep-session` call, so new
parts become searchable without a manual re-export. Budgeted sync uses an id-cursor
insert fast path for newly appended parts, plus session-dirty scans keyed by
`session.time_updated` to re-export sessions whose part status or metadata changed.
Short search-triggered syncs also schedule a throttled background reconcile, while
unbudgeted bulk exports perform full tombstone cleanup inline.

### L3 — ck Index (Optional)

`search-text` and `grep-session` shell out to the [`ck`](https://github.com/BeaconBay/ck)
CLI, which walks the export tree. `ck` supports plain regex with no index, a BM25
full-text index, and semantic embeddings; the index lives under `.ck/` in the export
root and is incremental. `ck` is optional: when it is absent these two tools return
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
`UPDATE session SET time_archived = NULL, time_updated = <now>` — and closes
immediately.

Both fields are updated deliberately. OpenCode loads sessions ordered by
`time_updated DESC` with a default limit per directory, so clearing `time_archived`
alone would leave a long-archived session buried below that window, and opening it
would fail with "Unable to retrieve session". Refreshing `time_updated` resurfaces
the session at the top of the list, which is also the intuitive meaning of
"restore". OpenCode exposes no HTTP or SDK endpoint that can *clear* the archived
flag, so the direct database write is the only mechanism.

## Examples

Materialize the export tree (L2), then build the optional `ck` index (L3):

```bash
bunx opencode-sessions-explorer-bulk-export
cd ~/.local/share/opencode-sessions-explorer
ck --index .   # run in the export root, not the repository checkout
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
