# Changelog

All notable changes to `opencode-sessions-explorer` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
