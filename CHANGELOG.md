# Changelog

All notable changes to `opencode-sessions-explorer` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Added: successful envelopes echo the effective arguments in `meta.args` (provided + schema defaults) and the defaulted keys in `meta.args_defaulted`, so parameters silently dropped by the host (OpenCode Code Mode strips unknown keys, e.g. a typo `archvied`) are visible as defaults instead of a silently unfiltered result.

- Added: `scripts/publish-live.sh` (`bun run publish:live`) — deploys an immutable snapshot and repoints the live config (hot-reload), avoiding the V2 server's per-path module cache pinning half-written modules.

- Added: strict argument validation for all 18 tools in `defineTool` (`validateArgs`/`describeArgs` in `src/lib/jsonschema.ts`): unknown parameters (with "did you mean" suggestions), type mismatches, out-of-range numbers, enum violations and missing required parameters return one `BAD_ARGS` envelope listing every problem, with the full valid signature in `hint`. Optional `null` counts as omitted; retired params use `removedArgs` messages.

- Fixed: `tool_audit` query-intent detection recognizes V2 tool names `shell` and `subagent` (not only V1 `bash`).

- Fixed: `tests/verify-end-to-end.ts` in LIVE mode now uses a throwaway export root unless `OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT` is set (`tests/live-export-root-guard.ts`); previously a LIVE run persisted `insert_cursor="\uffff"` and rewound `session_cursor` in the operator's real `.last_sync`.

- Changed: `get-part` description/examples now use synthesized V2 part ids (`msg_…#N`; no `prt_` ids exist in V2) and `unarchive-session` description names `session_v2` columns.
- Fixed: tool-name aliases across the V1→V2 tool rename (`bash`→`shell`,
  `task`→`subagent`; verified in live data). Exact `tool` filters in
  `search-tool-calls` and `list-tool-failures` now match both spellings
  (`tool:'bash'` also returns post-migration `shell` calls and vice versa);
  `LIKE` patterns are unchanged and match the raw name. Per-tool aggregates —
  `list-tool-failures` `group_by:'tool'`, `session-summary` `tools_top`,
  `current-session` `counters.tools_by_name` — group by the canonical V2 name so
  both eras merge into one bucket; rows listing individual calls keep the raw
  recorded name. The `tool` input descriptions document the aliases and that
  post-migration MCP calls are recorded as Code Mode `execute` calls. Single
  source of truth: `src/lib/tool-aliases.ts`.
- Removed: dead part types and channels. The V2 adapter only produces `text`,
  `reasoning`, `tool`, and `compaction` parts (imported and live data alike), so
  the `file`, `patch`, `subtask`, `step-start`, and `step-finish` part types and
  the `patch-summary` and `file` channels are gone from the `get-message`
  `part_types` / `session-timeline` `types` / `search-text` + `grep-session`
  `channels` enums, tool descriptions, decoders, and exporter. The `code` surface
  now searches `conversation`, `session-summary`, `code-touch`,
  `tool-input-summary`. Full reconcile prunes leftover `by-channel/patch-summary`
  and `by-channel/file` trees from older exports (no re-export needed).
- Tests: `tests/check-descriptions.ts` is now a forward-looking guard — exactly
  the 18 tool names, and no description / input enum / property description
  advertising the removed part types/channels or `prt_` ids (the V1 git-HEAD
  byte-identity comparison is dropped). The hermetic fixture gains a session
  spanning both tool-name eras; new `tests/tool-aliases.test.ts`;
  `verify-end-to-end` checks the alias filter and canonical failure grouping.

### Changed — OpenCode V2 port (breaking)
- **Plugin API**: the plugin now targets the OpenCode **V2** plugin API
  (`@opencode/plugin >= 2.1`). The entry is `Plugin.define({ id, setup })` at the
  project root (`index.ts`, loaded as a directory entry); tools register through
  `ctx.tool.transform(editor => editor.add(...))` with plain JSON Schema `input`
  and `{ content }` results. The V1 plugin API (`@opencode-ai/plugin`) is no
  longer supported.
- **Data layer**: all reads now use the V2 SQLite tables — `session_v2` for
  sessions and `session_message` for messages, with parts INLINE in
  `data.content[]`. The frozen V1 `session`/`message`/`part` tables are no
  longer read. Imported (pre-V2) and V2-live rows are normalized through one
  adapter (`src/lib/v2-parts.ts`); both shapes verified against a live
  `opencode.db` (v2.1.3).
- **Part identity**: V2 has no part rows, so parts are addressed by synthesized
  ids `<messageId>#<contentIndex>` everywhere (`get-part`, `get-message`,
  `session-timeline`, `search-text` hits, export filenames). All 18 tool names
  are unchanged from 0.1.x; descriptions changed only where V2 semantics differ
  (part ids, removed part types/channels, tool-name aliases); envelope/table
  wire formats are unchanged.
- **`db-stats`**: drift detection rebased onto `session_v2` + `session_message`
  (expected columns + counts); the migration head now comes from the V2
  `migration` table (legacy `__drizzle_migrations` fallback) and is reported
  through the same `migrations_head` field.
- **`unarchive-session`**: the sanctioned single write now targets
  `session_v2` (`UPDATE session_v2 SET time_archived = NULL,
  time_updated = <now>`). Verified against the v2.1.3 binary: the V2 session
  picker (`SessionStore.list`) reads `session_v2` ordered by
  `time_updated DESC, id DESC` with archived rows filtered via
  `time_archived IS NULL`, so the resurface semantics carry over unchanged.
- **Export engine**: enumerates parts from `session_message` (message-id-keyset
  insert cursor + session-dirty scans). Sync state moved to schema `v4`; old
  v1–v3 `.last_sync` states migrate to a fresh v4 state, and tombstone
  reconcile removes the stale `prt_`-keyed files from pre-V4 export trees.
  Run `bulk-export --reset` once when upgrading.
- **`search-text` / `grep-session` enrichment + `session-summary` /
  `list-repeated-prompts` / `search-tool-calls` / `list-tool-failures`**:
  rebased onto `session_message` (`json_each` over `data.content[]`); tool
  stats read `$.name`, outputs join `state.content[]` texts (falling back to
  `state.metadata.output`), errors unwrap `state.error.message`.
  `session-summary` files-touched now matches both the legacy `filePath` and
  V2 `path` input keys across legacy + V2 tool names (`apply_patch` → `patch`).
- **Tooling**: dev dependency `@opencode-ai/plugin` + `zod` replaced by
  `@opencode/plugin` (typecheck-only); tool args are declared as JSON Schema
  with local default application (`src/lib/jsonschema.ts`).
- Tests: the hermetic fixture builds the V2 schema; LIVE fixtures were
  refreshed against the migrated live corpus; `verify-end-to-end` compares
  against `session_v2`/`session_message` ground truth and now verifies a
  representative OLD (imported) and NEW (V2-live) session.

### Fixed
- SQLite 3.53 mis-groups `json_extract(...)` expressions aliased as `key` in
  `GROUP BY key`; aggregation aliases renamed (`grp`) in `list-tool-failures`
  and `cost-by-project` so grouped counts are correct.

### Removed
- Removed the `lex` mode from `search-text` and `grep-session`.
- Removed `sem` and `hybrid` search modes. `search-text` and `grep-session` are now
  regex-only and expose no `mode` argument; `ck` is invoked purely as a stateless
  regex scanner, with no semantic index build/refresh/status behavior.

### Added
- MCP stdio entry point (`dist/mcp.js`, bin `opencode-sessions-explorer-mcp`) that
  serves the tool registry to non-OpenCode MCP hosts. Exposes 16 of the 18 tools with
  the `opencode-sessions-explorer-` prefix stripped; `current-session` (depends on
  OpenCode host identity) and `unarchive-session` (the only database write path) are
  withheld, keeping this entry point read-only. The OpenCode plugin entry point and
  its build output are unchanged.

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
