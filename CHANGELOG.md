# Changelog

All notable changes to `opencode-sessions-explorer` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- SQLite FTS5 sidecar index (`fts-index.sqlite` in the export root, override via
  `OPENCODE_SESSIONS_EXPLORER_FTS_DB`) backing a new fast tier for literal and
  `lex` (BM25) search. Built from the OpenCode SQLite DB directly, not the
  filesystem export tree. Two FTS5 tables share the same documents: a `trigram`
  table for substring matching, and a `unicode61` table for BM25 ranking.
  Indexed channels default to every derived channel except `raw`, overridable
  via `OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS`; the substring-table subset is
  overridable via `OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS`.
- New CLI `opencode-sessions-explorer-fts-build` builds/refreshes the FTS sidecar.
  Supports `--reset` (rebuild from cursor zero) and `--budget-ms N` (stop after N
  ms). Prints `COMPLETE = true/false` and, when partial, a loud warning naming
  why and the exact re-run command. `search-text` also delta-syncs the sidecar
  itself on each call with a ~1.5s budget.
- **New required dependency: ripgrep (`rg`)**, needed whenever the search
  planner picks it as the primary backend: `regex` mode, the exhaustive
  fallback tier, and every `grep-session` call. Override the binary path via
  `OPENCODE_SESSIONS_EXPLORER_RG_BIN`. A missing `rg` at that point is now a
  **hard, structured failure** (`RG_NOT_FOUND`) rather than a silent
  degradation to `ck` — the old behavior silently fell back to `ck` over the
  same file tree, which then timed out and returned nothing. A query that
  doesn't need `rg` (served by `fts` or `ck`) is unaffected. Availability is
  now a real probe (checks the resolved path is a regular, executable file),
  not an assumption — a present-but-non-executable binary, or one that fails
  to spawn for another reason, is classified `RG_FAILED` rather than
  silently returning an empty successful result.
- `check-deps` now probes ripgrep (resolved path + version) and the FTS sidecar
  (presence, doc count, on-disk bytes, indexed channels, cursor, last error), and
  prints the exact remediation command when the index is missing. It does not
  report the sidecar's completeness or failure counts — see `db-stats` below,
  or `fts-build`'s own console output, for that.
- `db-stats` gained an additive `fts` section: `present`, `complete`,
  `docs`, `bytes`, `channels`, `cursor`, `at_source`, `lag_ms`,
  `failed_parts`, `dead_letters`, `case_folding_ascii_only`, and
  `last_error` — the way to check FTS completeness and failure state
  programmatically (`check-deps` does not surface these).
- `search-text` responses gained new debug fields: `backend` (`fts`/`rg`/`ck`),
  `backends_tried`, `plan_reason`, `literal`, and `search_duration_ms`. The
  existing `recall_strategy`, `ck_duration_ms`, `ck_timed_out`, and
  `ck_scope_coverage` fields are preserved for compatibility.
- The FTS sidecar now tracks build completeness (`sync_complete`) on a
  **drain-based** rule: an index is `complete` once a sync has drained the
  entire source `part` table with no unresolved failures, regardless of
  whether that run had a `--budget-ms` time budget — a budgeted run that
  finishes before its limit is complete, and a completed index stays
  complete through a later budget-stopped delta-sync. Freshness (how far
  behind the live source the indexed cursor is, surfaced as `at_source` /
  `lag_ms`) is a separate, purely informational property and never gates the
  fast tier. Literal/`lex` search does not trust an incomplete index as
  authoritative — it falls back to ripgrep instead of silently returning a
  truncated fraction of the corpus. The sidecar also tracks per-part
  failure/dead-letter state (`failedParts`, `deadLetters` in `FtsStats`; a
  part is retried up to 5 times before being dead-lettered), and a
  missing/corrupt sidecar table now forces a full rebuild and clears
  completeness, so a damaged index reports as not-built instead of silently
  serving stale/incomplete results.
- `mode:"lex"` queries are now always treated as text, never as a regular
  expression, regardless of metacharacters in the query — this fixes queries
  like `v1.2.3`, `C++`, or `*` under `lex` mode silently being reinterpreted as
  regular expressions on the FTS-served path.
- An unscoped `sem`/`hybrid` `search-text` query whose channels explicitly
  resolve to `raw` (`surface:'forensics'`, or an explicit `channels:['raw']`,
  with no session/project/agent/time filter) now returns `BAD_ARGS` instead
  of handing `ck` the full raw replay tree and timing out — the error names
   the fix (scope the query, use a curated surface, or use `mode:'regex'`).
  A second guard runs after scope resolution and applies the same refusal when
  an unscoped `sem`/`hybrid` query on a *curated* surface falls back onto the
  raw tree because the curated channel export is still partial, so that
  indirect route is covered too.

### Changed
- Text search is now served by a three-tier query planner instead of shelling out
  to `ck` for everything. A literal query with a usable 3+ character contiguous
  run is served from the FTS sidecar when the index covers the requested
  channels — latency ranges from single-digit milliseconds for a rare
  identifier to several hundred milliseconds for a common short word (measured:
  `MP-4493` ~8ms, `MP-44` ~19ms, `the` ~508ms on a 566,958-document index,
  warm cache), not uniformly "milliseconds". A real regex pattern, a literal
  query shorter than 3 characters, or a literal query the index can't serve is
  routed to ripgrep; `sem`/`hybrid` still use `ck` exclusively, since it is the
  only engine with embeddings. If a backend returns zero hits for the whole
  query it escalates to the next backend in the plan (`fts` -> `rg`; `ck` is
  never a fallback for literal/regex, since it reads the same file tree as `rg`
  and can find nothing more).
- `grep-session` now shells out to ripgrep instead of `ck` and no longer depends
  on `ck` at all. The public contract (`mode`, `fixed_string`, `case_sensitive`,
  `whole_word`, `context_lines`, response shape) is unchanged.
- README, architecture, and configuration docs updated to describe the fts/rg/ck
  three-tier planner in place of the previous ck-only search path.

### Fixed
- `search-text` no longer describes unscoped search as uniformly taking 10-30
  seconds: that estimate now applies only to raw/forensic file-tree scans over
  the full export tree, not to indexed literal recall (see the latency numbers
  above).

### Known Limitations

- **Not a superset of ripgrep.** The FTS-served path is equivalent-or-superset
  of `rg -F` only for ASCII-case-insensitive substring matches over fully
  indexed channels. Three concrete gaps:
  - `tool-output` is indexed as a 4 KB head + 4 KB tail excerpt (the largest
    channel: ~876 MB / 168,261 documents; ~135,000 of those fit entirely
    within 8 KB and are indexed in full — only the middle of the largest
    ~33,000 documents is excerpted out). Escalation to `rg` only fires on
    **zero** hits for the whole query, so a term appearing once in an indexed
    excerpt and once in an omitted middle surfaces only the indexed
    occurrence in that search. The omitted content stays fully readable via
    `get-part` and fully searchable by a query that reaches the `rg` tier
    directly (e.g. `surface:'forensics'`).
  - The trigram substring table's case folding is **ASCII-only**
    (`FTS_CASE_FOLDING_ASCII_ONLY`, surfaced as `FtsStats.caseFoldingAsciiOnly`):
    it folds `A-Z`<->`a-z` but not accented or non-Latin letters, so an
    indexed `ÄBC` is matched by `Äbc` but not by `äbc`. Ripgrep's `-i` is
    Unicode-aware and can find such a match that the fast tier misses.
  - A channel excluded from `OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS`
    is `lex`-searchable but not literal-searchable via `fts`.
- A literal or `lex` query shorter than 3 contiguous characters (the
  trigram tokenizer's floor) is never served by `fts`; it's routed straight to
  `rg` by the planner. As a defensive backstop, the sidecar's own query
  function also bounds any such too-short query to a deadline (750ms by
  default) rather than letting it run as an unbounded scan.
- `check-deps`'s `FTS sidecar` line still reports only presence, doc count,
  bytes, channels, and cursor — it does not surface completeness or failure
  counts. Use the `db-stats` tool's `fts` section (see Added, above) or
  `fts-build`'s own console output to check completeness.
- The `BAD_ARGS` refusal for an unscoped `sem`/`hybrid` query over the raw
  tree (see Added, above) only checks the explicitly requested channels; it
  does not yet also refuse the indirect case where a curated-surface
  `sem`/`hybrid` query falls back to the same raw tree because the curated
  channel export is partial.

## [0.1.4] - 2026-06-14

### Fixed
- `search-text` now preserves requested `sem`/`hybrid` modes when the `ck` semantic
  index is missing, allowing `ck` to perform its normal lazy auto-indexing instead
  of falling back to regex.

## [0.1.3] - 2026-06-14

### Fixed
- `search-text` now reports honest `ck` semantic index freshness for `sem`/`hybrid`
  modes (missing/stale/partial) and directs users to explicit `ck --index` /
  `ck --reindex` workflows instead of implying inline rebuilds.
- `search-text` and `grep-session` now expose partial multi-scope `ck` coverage when
  timeout truncation leaves some session/channel scopes unsearched.

## [0.1.2] - 2026-06-13

### Changed
- Clarified installation, source-dev, and first-run docs, including plugin
  registration troubleshooting, platform-specific database paths, and export/index
  setup; shipped `docs/` in the npm package so README guide links resolve for
  package consumers.

## [0.1.1] - 2026-06-13

### Changed
- Documentation restructure: organized the `docs/` tree (getting started, install, guides,
  reference, support, maintainers) and reworked `README.md` into a concise entry point that
  links out to the new docs.
- Generalized the product descriptions and wording across `package.json`, `README.md`, and
  the docs tree so they are non-parochial (removed machine- and author-specific phrasing).
  No runtime or API changes.

## [0.1.0] - 2026-06-13

Initial public release on npm.

### Added
- `opencode-sessions-explorer-unarchive-session` — the first and only **write** tool. Restores a session to a usable state by clearing `session.time_archived` **and** refreshing `session.time_updated` in one `UPDATE`. It always resurfaces (even an already-active-but-buried session), so it is not a silent no-op on active rows; idempotent in effect (active + at the top). Only a non-existent id returns `NOT_FOUND`. The `time_updated` bump is required: OpenCode loads sessions ordered by `time_updated DESC` with a default `LIMIT 100` per directory, so merely clearing `time_archived` leaves a long-archived session buried below that window — the app never loads it and prompting fails with "Unable to retrieve session". Bumping resurfaces it at the top. OpenCode exposes no HTTP/SDK endpoint that can clear the flag (its `UpdatePayload.time.archived` is a finite number and the handler ignores `undefined`; verified against v1.15.12 source) and `opencode session` only offers list/delete, so a direct DB write is the only mechanism. Reads stay on the shared read-only handle; the write goes through a separate short-lived read-write connection in `src/lib/db-write.ts`. New `WRITE_FAILED` error code. The plugin namespace is now 18 tools (17 read-only + 1 write).
- `tests/unarchive.test.ts` — exercises the write path against a throwaway snapshot copy of the live DB (real archived session → unarchived, already-active-but-buried session → resurfaced, `time_updated` refresh, NOT_FOUND, and live-DB isolation), so the suite never mutates the real DB. `verify-end-to-end.ts` probes the tool via the zero-mutation NOT_FOUND path (now 17/17).
- Columnar + interning result codec (`src/lib/table.ts`: `table()`/`decodeTable()`/`isTable()`) applied to all list-shaped tool results. Lossless; measured −33% to −56% payload size by removing per-row key repetition and interning repeated model/directory/agent/project/channel/type values. Envelope and tool descriptions unchanged. Flat `search-text` hits drop the constant `raw_ref` (use the in-row `part_id` with `get-part`); duplicate `ranked_sessions` removed in favor of the single `sessions` table.
- Hermetic synthetic fixture DB so `bun test` runs without a live OpenCode history by default; live runs are opt-in via `OPENCODE_SESSIONS_EXPLORER_LIVE=1` (or `bun run test:live`).
- Curated recall surfaces for `search-text` and `grep-session`: `recall`, `debug_trace`, `tool_audit`, `code`, and `forensics`.
- Channelized export views under `by-channel/` while preserving raw `by-session/` replay data.
- Session-first ranked `search-text` results for unscoped recall, with evidence snippets, channel counts, suppressed counts, and raw refs.
- Structured `truncated_fields` metadata in `get-part` and `get-message`.
- `current-session` compact/default output with explicit `detail:'full'` for counters, children, paths, and suggestions.
- Redaction regression coverage and forensic/raw parity coverage in the rehearsal suite.
- Initial extraction from `~/.config/opencode/` into a standalone repo.
- 18 tools registered under the `opencode-sessions-explorer-*` namespace:
  - **Recall**: `current-session`, `get-session`, `session-summary`, `session-timeline`, `get-message`, `get-part`, `session-genealogy`
  - **Browse**: `list-sessions`, `search-sessions-meta`
  - **Search**: `search-text`, `grep-session`, `search-tool-calls`
  - **Analysis**: `cost-by-project`, `cost-by-period`, `list-tool-failures`, `list-repeated-prompts`
  - **Health**: `db-stats`
  - **Mutate** (write): `unarchive-session`
- CLI bins: `opencode-sessions-explorer-bulk-export`, `opencode-sessions-explorer-dedupe-export`, `opencode-sessions-explorer-check-deps`.
- Single Plugin entry point at `src/plugin.ts` returning `{ tool: { ... } }` per OpenCode plugin contract.
- 99 rehearsal probes covering the read-only tools (hermetic by default; live mode opt-in via `OPENCODE_SESSIONS_EXPLORER_LIVE=1`).
- README + LICENSE (MIT) + CHANGELOG.

### Fixed
- Fixed `ck` multi-scope hangs by running bounded single-scope invocations and merging results.
- Reduced default noise in `search-tool-calls`, `session-timeline`, `session-summary`, `list-tool-failures`, and `list-repeated-prompts`.
- Defaulted search snippet redaction to on and expanded common secret patterns.
- Removed hardcoded `/Users/aleksandr.efremenkov/.cargo/bin/ck` from `lib/ck.ts`; added `OPENCODE_SESSIONS_EXPLORER_CK_BIN` env override.
- Replaced CJS `require("node:fs")` with ESM import in `lib/ck.ts`.
- Added `OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR` env override in `lib/path-guard.ts`; added Windows support via `%LOCALAPPDATA%`.
- All tool imports rewritten from `"../opencode-sessions-explorer/lib/…"` (home-dir-coupled) to `"../lib/…"` (portable repo-relative).
