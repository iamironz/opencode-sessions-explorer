# Export And Maintenance Guide

## Purpose

Understand the searchable export tree that content search depends on, and keep it
healthy with the bundled command-line tools.

## Mental Model

Content search does not run against the database directly. The plugin maintains a
four-layer pipeline:

```text
SQLite DB (read-only source of truth)
  -> filesystem export tree (~/.local/share/opencode-sessions-explorer; by-session + by-channel)
  -> ck index (.ck/, BM25 + embeddings; optional)
  -> enriched response (re-fetches session/part metadata from SQLite per hit)
```

The export tree materializes each searchable part as a small text file under
`by-session/<ses_…>/` plus curated `by-channel/` views (such as conversation and
session-summary). `ck` searches these files; the plugin then re-reads session and
part metadata from SQLite to enrich each hit. The export root is overridable via
`OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`.

### Auto-Sync

`search-text` and `grep-session` delta-sync new parts into the export tree before
each call (a few-second best-effort budget), so day-to-day search stays current
without manual steps. The CLIs below are for the initial backfill and occasional
maintenance.

## Controls

| Command / Tool | Use It For | Notes |
| --- | --- | --- |
| `opencode-sessions-explorer-bulk-export` | Build or resume the export tree | Idempotent and resumable via `.last_sync`; `--reset` starts from scratch and rebuilds curated `by-channel/` views; `--root <path>` targets a non-default export root |
| `opencode-sessions-explorer-dedupe-export` | Remove duplicate part files from an older cursor-migration bug | Dry-run by default (reports only); pass `--apply` to actually delete, keeping the lowest-seq file per part |
| `opencode-sessions-explorer-check-deps` | Probe install health | Checks DB, schema/drift, export tree, channel views, and `ck`; `--json` for machine output; exit codes `0` ok, `1` soft warning, `2` hard fail |
| `db-stats` (tool) | Inspect database health from inside OpenCode | Returns migration head, table counts, json1 status, `busy_timeout`, and schema-drift warnings |

## Recommended Flow

1. Run the one-time backfill so search has content to scan:

   ```bash
   bunx opencode-sessions-explorer-bulk-export
   ```

1. If curated channel views are reported as partial (for example by
   `check-deps`), rebuild them once:

   ```bash
   bunx opencode-sessions-explorer-bulk-export --reset
   ```

1. (Optional) Build the semantic index to unlock `sem` and `hybrid` search modes.
   This is slow and only needs to run once:

   ```bash
   cd ~/.local/share/opencode-sessions-explorer && ck --index .
   ```

1. Verify everything is wired up, and re-run after any OpenCode upgrade:

   ```bash
   bunx opencode-sessions-explorer-check-deps
   ```

1. If an older export shows duplicate part files, preview then apply a cleanup:

   ```bash
   bunx opencode-sessions-explorer-dedupe-export
   bunx opencode-sessions-explorer-dedupe-export --apply
   ```

## Related Docs

- [Search and grep](search-and-grep.md)
- [Architecture](../reference/architecture.md)
- [Search surfaces](../reference/search-surfaces.md)
- [Configuration reference](../reference/configuration.md)
- [Troubleshooting](../support/troubleshooting.md)
