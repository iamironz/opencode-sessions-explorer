# Export And Maintenance Guide

## Purpose

Understand the searchable export tree that content search depends on, and keep it
healthy with the bundled command-line tools.

## Mental Model

Content search does not run against the database directly, and it does not run
against a single index either. The plugin maintains two parallel derived
stores plus a query planner that picks between them:

```text
SQLite DB (read-only source of truth)
  |-> FTS5 sidecar (fts-index.sqlite; fast literal + lex/BM25 tier)
  `-> filesystem export tree (~/.local/share/opencode-sessions-explorer; by-session + by-channel)
        |-> ripgrep (exhaustive regex/fallback tier, and grep-session's only backend)
        `-> ck index (.ck/, embeddings; optional, sem/hybrid only)
  -> enriched response (re-fetches session/part metadata from SQLite per hit)
```

The FTS sidecar reads straight from SQLite and holds its own resumable cursor;
it never touches the filesystem export tree. The export tree separately
materializes each searchable part as a small text file under
`by-session/<ses_…>/` plus curated `by-channel/` views (such as conversation
and session-summary), which ripgrep and `ck` search. Either way, the plugin
re-reads session and part metadata from SQLite to enrich each hit before
returning it. The export root is overridable via
`OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`; the FTS sidecar path is overridable
via `OPENCODE_SESSIONS_EXPLORER_FTS_DB`. See
[architecture.md](../reference/architecture.md) for the full planner rules.

### Auto-Sync

`search-text` delta-syncs whichever store the query planner is about to use:
the `fts` backend syncs only the sidecar directly from SQLite (skipping the
filesystem export tree entirely — that's the latency win), while `rg`/`ck`
sync the filesystem export tree instead (a few-second best-effort budget).
`grep-session` always syncs the filesystem export tree, since it only uses
ripgrep. Day-to-day search stays current without manual steps either way. The
CLIs below are for the initial backfill and occasional maintenance.

## Controls

| Command / Tool | Use It For | Notes |
| --- | --- | --- |
| `opencode-sessions-explorer-bulk-export` | Build or resume the export tree | Idempotent and resumable via `.last_sync`; `--reset` starts from scratch and rebuilds curated `by-channel/` views; `--root <path>` targets a non-default export root |
| `opencode-sessions-explorer-fts-build` | Build or resume the FTS5 sidecar | Idempotent and resumable via a cursor stored inside the sidecar file; `--reset` rebuilds from cursor zero; `--budget-ms N` stops after N ms |
| `opencode-sessions-explorer-dedupe-export` | Remove duplicate part files from an older cursor-migration bug | Dry-run by default (reports only); pass `--apply` to actually delete, keeping the lowest-seq file per part |
| `opencode-sessions-explorer-check-deps` | Probe install health | Checks DB, schema/drift, SQLite `json1`, `busy_timeout`, export tree, channel views, ripgrep binary + version, FTS sidecar (doc count, bytes, channels, cursor), `ck` CLI, `ck` index, and tool-output dir; `--json` for machine output; exit codes `0` ok, `1` soft warning, `2` hard fail |
| `db-stats` (tool) | Inspect database health from inside OpenCode | Returns migration head, table counts, json1 status, `busy_timeout`, schema-drift warnings, and an additive `fts` section: `present`, `complete`, `docs`, `bytes`, `channels`, `cursor`, `at_source`, `lag_ms`, `failed_parts`, `dead_letters`, `case_folding_ascii_only`, `last_error` — this is the tool to check for completeness (`check-deps`'s FTS line only reports presence/doc-count/bytes/channels/cursor, not completeness) |

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

1. Build the FTS5 sidecar so literal (3+ character) and `lex` search can use
   the fast indexed path instead of ripgrep:

   ```bash
   bunx opencode-sessions-explorer-fts-build
   ```

   `--reset` rebuilds from cursor zero (needed after changing
   `OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS` or
   `OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS`); `--budget-ms N` stops
   the run after N ms, useful for a first build against a very large history.

   **Completeness is drain-based, not budget-based.** A run — budgeted or
   not — is marked `COMPLETE = true` once it has drained the entire source
   `part` table with no unresolved failures; a budgeted run that finishes
   before its time limit is complete just like an unbudgeted one, and a
   completed index stays complete even if a later budgeted delta-sync stops
   early. A run only ends `COMPLETE = false` when the source wasn't fully
   drained yet (first build interrupted before finishing) or a part still has
   an unresolved (retriable) failure. `fts-build` always prints
   `COMPLETE = true`/`false` and, when `false`, a loud warning naming why and
   the exact re-run command. A part whose document build throws is retried
   up to 5 times before being moved to a dead-letter set — it doesn't block
   completeness, but the index permanently misses that part's content until
   the part itself changes. Re-run `opencode-sessions-explorer-fts-build`
   without `--budget-ms` (or run it again if a previous run stopped early)
   until it reports `COMPLETE = true` if you need the fast tier to be
   authoritative for every query. A missing/corrupt sidecar table also
   forces a full rebuild and clears completeness, so a damaged index reports
   as not-built rather than silently serving as authoritative.

   Measured on a large real corpus (507,840 parts -> 565,516 indexed
   documents): about 210 seconds for a full build, producing a roughly 5.0 GB
   sidecar file, with peak memory around 1.5 GB during that one-time build and
   roughly 250 MB at query time afterward. Your numbers will differ with
   history size; the first build is the expensive one — delta-syncs afterward
   only process new/changed parts.

1. (Optional) Prewarm the `ck` index for `sem`/`hybrid` search only. Normal
   `sem`/`hybrid` searches invoke `ck` in the requested mode so `ck` can
   lazily build or refresh indexes during the search. Run these commands only
   to avoid first-search latency or to troubleshoot stale/partial coverage
   warnings, and run them from the export root, not from the repository
   checkout:

   ```bash
   cd ~/.local/share/opencode-sessions-explorer
   ck --index .  # optional prewarm in the export root
   ck --reindex .  # optional troubleshooting refresh
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
