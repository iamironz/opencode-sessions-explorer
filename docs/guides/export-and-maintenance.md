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
  -> ck regex scan (stateless; optional)
  -> enriched response (re-fetches session/part metadata from SQLite per hit)
```

The export tree materializes each searchable part as a small text file under
`by-session/<ses_…>/` plus curated `by-channel/` views (such as conversation and
session-summary). Parts come from the V2 `session_message` table, where they are
stored inline in `data.content[]`; each file is named `<seq5>-<messageId>#<index>.txt`
(for example `00004-msg_…#0.txt`), so the `#` in the part id is preserved. `ck`
searches these files; the plugin then re-reads session and part metadata from
SQLite to enrich each hit. The export root is overridable via
`OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`.

### Sync State And Upgrades

Progress is tracked in `<export root>/.last_sync` (schema `v4`: a message-id keyset
insert cursor plus per-session dirty hints keyed by `session_v2.time_updated`).
States written by 0.1.x (v1–v3) were keyed on V1 `prt_` part ids; they are migrated
to a fresh v4 state, which forces a full re-export, and tombstone reconcile removes
the stale `prt_`-keyed files. After upgrading from 0.1.x, run
`bulk-export --reset` once (see the flow below).

### Auto-Sync

`search-text` and `grep-session` delta-sync new parts into the export tree before
each call (a few-second best-effort budget), so day-to-day search stays current
without manual steps. The CLIs below are for the initial backfill and occasional
maintenance.

## Controls

| Command / Tool | Use It For | Notes |
| --- | --- | --- |
| `opencode-sessions-explorer-bulk-export` | Build or resume the export tree | Idempotent and resumable via `.last_sync`; `--reset` removes `.last_sync` and `by-channel/`, starts from scratch, and rebuilds curated `by-channel/` views; `--root <path>` targets a non-default export root |
| `opencode-sessions-explorer-dedupe-export` | Remove duplicate part files (same `msg_…#N` part id under two sequence prefixes) | Dry-run by default (reports only); pass `--apply` to actually delete, keeping the lowest-seq file per part |
| `opencode-sessions-explorer-check-deps` | Probe install health | Checks DB, schema/drift, SQLite `json1`, `busy_timeout`, export tree, channel views, `ck` CLI, and tool-output dir; `--json` for machine output; exit codes `0` ok, `1` soft warning, `2` hard fail |
| `db-stats` (tool) | Inspect database health from inside OpenCode | Returns migration head, table counts (`session_v2`, `session_message`), json1 status, `busy_timeout`, and schema-drift warnings |

## Recommended Flow

1. Run the one-time backfill so search has content to scan:

   ```bash
   bunx opencode-sessions-explorer-bulk-export
   ```

1. If curated channel views are reported as partial (for example by
   `check-deps`), or you just upgraded from a 0.1.x/V1-era export tree, rebuild
   once:

   ```bash
   bunx opencode-sessions-explorer-bulk-export --reset
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
