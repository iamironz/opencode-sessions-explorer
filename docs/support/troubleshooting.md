# Troubleshooting

## How To Use This Page

Find the symptom that matches what you are seeing, run its quick checks, then apply
the fix. Each block is phrased the way the problem usually appears — an error code in
a tool response, an empty result, or a failed restore. Run the baseline checks below
first; they resolve or explain most issues on their own.

## Baseline Checks

Two commands cover the health of every layer the plugin depends on.

1. Probe the install end to end:

   ```bash
   bunx opencode-sessions-explorer-check-deps
   ```

   This reports database reachability, schema head and drift, SQLite `json1`,
   `busy_timeout`, export tree presence, curated channel views, the ripgrep
   binary + version, FTS5 sidecar health (present, doc count, bytes, indexed
   channels, cursor, last error), `ck` CLI, `ck` index, and the tool-output
   directory. Add `--json` for machine-readable output.

2. Probe the database from inside OpenCode with the `db-stats` tool. It returns the
   migration head, table counts, json1 status, `busy_timeout`, any schema-drift
   warnings, and the same FTS sidecar health section as `check-deps`.

If both come back clean, the plugin core is healthy and the issue is likely scoped
to one tool or to the optional `ck` semantic search path.

## Plugin Tools Do Not Appear After Config Change

OpenCode starts, but the `opencode-sessions-explorer-*` tools are not available to
the model after editing config.

Quick checks:

- Confirm you edited the active OpenCode config path, usually
  `~/.config/opencode/opencode.json`.
- Confirm the `plugin` array contains either the package spec
  (`"opencode-sessions-explorer"` or a pinned version) or an absolute local path.
- Confirm you fully quit and restarted OpenCode; do not assume plugin hot reload.
- If using source TypeScript, confirm the path to `src/plugin.ts` exists.
- If using built JavaScript, confirm `bun run build` produced `dist/plugin.js`.
- Confirm `src/plugin.ts` exports only the plugin function; extra non-function
  exports can make OpenCode reject the plugin entrypoint.

Fix:

- Correct the config, then fully restart OpenCode.
- For source checkouts, see the supported source TS and built JS options in
  [install.md#from-source-dev](../install.md#from-source-dev).
- If a local source path still fails, run a local import check from the checkout:

  ```bash
  bun -e 'import("./src/plugin.ts").then((m) => { if (typeof m.default !== "function") throw new Error("default export is not a function") })'
  ```

## Search Returns CK_NOT_FOUND

`search-text` returns the error code `CK_NOT_FOUND` for a `sem` or `hybrid` query.

Quick checks:

- Confirm whether `ck` is installed and on `PATH`: `ck --version`.
- Run `bunx opencode-sessions-explorer-check-deps` and look at the `ck CLI` line.

Fix:

- Install [`ck`](https://github.com/BeaconBay/ck) (>= 0.7), e.g.
  `cargo install ck-search`. If it is installed outside `PATH`, point the
  plugin at it with `OPENCODE_SESSIONS_EXPLORER_CK_BIN=/abs/path/to/ck`.
- `ck` is only needed for `sem`/`hybrid` `search-text` modes. Every other
  search path — literal, `lex`, `regex`, and all of `grep-session` — works
  without it, along with the other 16 tools. See
  [configuration.md](../reference/configuration.md).

## Search Returns RG_NOT_FOUND, Or `regex` Mode Fails

`search-text` (mode `regex`) or `grep-session` returns `RG_NOT_FOUND`, or
`check-deps` reports the `ripgrep (rg)` line as a hard failure.

Quick checks:

- Confirm `rg` is installed and on `PATH`: `rg --version`.
- Run `bunx opencode-sessions-explorer-check-deps` and look at the
  `ripgrep (rg)` line for the resolved path and version.

Fix:

- Install ripgrep: `brew install ripgrep` (macOS), `apt install ripgrep`
  (Debian/Ubuntu), or `cargo install ripgrep`.
- If it is installed outside `PATH`, point the plugin at it with
  `OPENCODE_SESSIONS_EXPLORER_RG_BIN=/abs/path/to/rg`.
- `rg` is required for `regex`-mode `search-text` queries, the exhaustive
  fallback tier, and `grep-session` (which uses ripgrep exclusively — every
  `grep-session` call fails without `rg`, regardless of channel). A query
  that needs `rg` as its primary backend fails outright with `RG_NOT_FOUND`
  when `rg` is missing — it no longer silently falls back to `ck` (the old
  behavior, which then timed out over the full export tree and returned
  nothing). Literal/`lex` queries served by the FTS sidecar, and `sem`/
  `hybrid` queries served by `ck`, are unaffected by a missing `rg`. See
  [configuration.md](../reference/configuration.md).

## FTS Index Missing Or Search Feels Slow

`search-text` warns that the FTS index is not built and literal search is
using a slower backend, or `check-deps` reports the `FTS sidecar` line as
"not built".

Quick checks:

- Run `bunx opencode-sessions-explorer-check-deps` and look at the
  `FTS sidecar` line for doc count, size, indexed channels, and cursor.
- Confirm the query is actually literal (no regex metacharacters) — a real
  regex pattern is always served by ripgrep, never the FTS index, so this is
  expected behavior, not a problem.
- Confirm the query has a usable 3+ character contiguous run. A 1-2
  character literal (including a 1-2 character CJK or emoji query) is below
  the trigram index's floor and is always routed to ripgrep — that is
  expected, not a sign the index is broken. See
  [architecture.md](../reference/architecture.md#latency).
- If you ran `fts-build` with `--budget-ms` (or it was interrupted), check
  its own output for `COMPLETE = false` — a partial build is not treated as
  authoritative and the intended behavior is to fall back to ripgrep until a
  full build finishes.

Fix:

- Build (or finish building) the sidecar:

  ```bash
  bunx opencode-sessions-explorer-fts-build
  ```

  Run it without `--budget-ms` until it reports `COMPLETE = true` if a
  previous run was partial.
- Without a usable index, a literal query transparently falls back to
  ripgrep with a warning rather than failing — search still works, just
  slower (see [architecture.md](../reference/architecture.md#latency) for
  measured numbers; a common short word is not "milliseconds" even on the
  fast path).
- If the index exists but does not cover the channels you requested (see
  `OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS` in
  [configuration.md](../reference/configuration.md)), the same fallback
  applies for those channels only.

## Reading `backend` And `plan_reason` When A Search Feels Unexpectedly Slow

Every `search-text` response includes `backend` (`fts`, `rg`, or `ck` — which
engine actually produced the results), `backends_tried` (the full escalation
chain attempted), `plan_reason` (why the planner chose the primary backend),
and `search_duration_ms` (total wall-clock across the whole chain, including
any escalation).

Quick checks:

- If `backend` is `rg` when you expected fast `fts` speed: check
  `plan_reason`. It names one of: "fts index unavailable", "fts does not
  cover requested channels: …", or (for a 1-2 character literal) that the
  query has no usable 3+ character trigram run. The first two point at the
  FTS Index Missing fix above (or, for the channel case, adding those
  channels to `OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS` and re-running
  `fts-build`); the trigram-length case is expected behavior for a very
  short query, not a bug.
- If `backends_tried` has more than one entry, the first backend returned zero
  hits and the tool escalated automatically — this is expected recall-
  preserving behavior, not an error. Note that escalation only fires on
  **zero** hits for the whole query — a term found once in an indexed
  `tool-output` excerpt and once in an omitted middle (or via a non-ASCII
  case fold `fts` cannot match but `rg` can — see
  [architecture.md](../reference/architecture.md#fts-coverage-limitations))
  will not escalate, because the excerpt hit already made the result
  non-empty.
- Even on the `fts` path, `search_duration_ms` in the tens to low hundreds of
  milliseconds is normal for a common short literal (high row cardinality
  plus an `ORDER BY` temp B-tree) — see
  [architecture.md](../reference/architecture.md#latency) for the measured
  table. Only a rare, selective literal is reliably single-digit
  milliseconds.
- A slow `rg` result over the `raw` channel or an unscoped `surface:'forensics'`
  sweep is expected: ripgrep is the exhaustive tier and reads the full
  filesystem export tree. Pre-filter with `session_ids`/`project_id`/
  `since_ms` to narrow it.
- `ck` is never in `backends_tried` for a literal or regex query — if you see
  slow results and expected `ck` involvement, confirm you actually requested
  `mode:'sem'` or `mode:'hybrid'`.

## Database Not Found

A tool returns `DB_NOT_FOUND`, or `check-deps` fails the "OpenCode DB" line.

Quick checks:

- Confirm the database exists at the default path
  (`~/.local/share/opencode/opencode.db` on common macOS/Linux installs).
- Confirm OpenCode has run at least once so the database has been created.

Fix:

- If the database lives elsewhere, set `OPENCODE_SESSIONS_EXPLORER_DB` to its
  absolute path. If `$XDG_DATA_HOME` or Windows `%LOCALAPPDATA%` changes the data
  root, use that actual path.
- If the path is correct but access is blocked, add the `external_directory`
  permission rule (next block) and restart OpenCode.
- See [configuration.md](../reference/configuration.md) for the full override table.

## Search Finds Nothing

A search returns zero hits for a term you expect to exist.

Quick checks:

- Confirm the export tree (and, for literal/`lex` queries, the FTS sidecar) has
  been materialized at least once.
- Note whether the session you expect is very new — its parts may not be exported
  or indexed yet.
- Confirm the term is not being narrowed away by `role`, `surface`, or a time/scope
  filter.

Fix:

- Run the one-time export and FTS build, then retry:

  ```bash
  bunx opencode-sessions-explorer-bulk-export
  bunx opencode-sessions-explorer-fts-build
  ```

- New parts are delta-synced automatically before each `search-text` /
  `grep-session` call (the `fts` backend syncs the sidecar directly from
  SQLite; `rg`/`ck` sync the export tree), so a missing recent part usually
  resolves on the next search.
- Widen the search: try `surface:'forensics'` (or `channels:['raw']`) to include raw
  bodies, and confirm `role` is `any`. See
  [search-surfaces.md](../reference/search-surfaces.md).
- If the term should exist and none of the above explain it, consider two
  known FTS limitations: the trigram substring table's case folding is
  ASCII-only (a non-ASCII case fold ripgrep's `-i` would find can be missed —
  try `mode:'regex'` with an explicit case-insensitive pattern, which routes
  to ripgrep), and `tool-output` is indexed as a 4 KB head + 4 KB tail
  excerpt, so a term that only appears in the omitted middle of a very large
  tool-output document is not in the fast index — `surface:'forensics'`
  reaches it. See
  [architecture.md](../reference/architecture.md#fts-coverage-limitations).

## grep-session Returns INDEX_MISSING

`grep-session` returns `INDEX_MISSING`, usually with a message that the session is
not in the export tree.

Quick checks:

- Verify the `session_id` is correct with `get-session` or `list-sessions`.
- Confirm the export tree exists and includes that session under `by-session/`.
- If you requested a curated surface/channel, confirm channel views are complete in
  `check-deps`.

Fix:

- Run the one-time export, then retry `grep-session`:

  ```bash
  bunx opencode-sessions-explorer-bulk-export
  ```

- If the session is very new, retry after the tool's auto-sync has had a chance to
  export recent parts.
- If channel views are partial or missing, rebuild them:

  ```bash
  bunx opencode-sessions-explorer-bulk-export --reset
  ```

## Permission Denied / external_directory

A tool cannot reach the database even though the path is correct, or OpenCode
reports an external-directory permission error.

Quick checks:

- Confirm the `external_directory` allow rule is present in your OpenCode config.
- Confirm you fully restarted OpenCode after editing the config.

Fix:

- Add the allow rule and restart OpenCode:

  ```jsonc
  // ~/.config/opencode/opencode.json
  {
    "permission": {
      "external_directory": {
        "~/.local/share/opencode/**": "allow"
      }
    }
  }
  ```

- The database lives outside your project workspace, so this rule is required. The
  default snippet covers the common macOS/Linux path. If `$XDG_DATA_HOME`, Windows
  `%LOCALAPPDATA%`, or `OPENCODE_SESSIONS_EXPLORER_DB` points elsewhere, allow the
  actual containing directory and restart. Some global configs use
  `external_directory: "allow"`; that also permits access, but a scoped allow rule is
  preferred for normal users. The change only takes effect after a full restart. See
  [configuration.md](../reference/configuration.md).

## Schema Drift Warnings

A tool returns `SCHEMA_DRIFT`, or `db-stats` / `check-deps` reports drift warnings.

Quick checks:

- Run `db-stats` and read `migrations_head` and `drift_warnings`.
- Run `bunx opencode-sessions-explorer-check-deps` and check the schema line.
- Note whether you recently upgraded OpenCode.

Fix:

- Drift warnings usually mean the installed OpenCode version moved the database
  schema ahead of (or behind) what the plugin expects. Align the plugin version with
  your OpenCode version.
- If the warning is soft, read tools still work; treat the warning as a prompt to
  update. If `hard_drift` is reported, update the plugin before relying on affected
  tools.

## get-part Returns PATH_TRAVERSAL

`get-part` with `dereference_output_path:true` returns `PATH_TRAVERSAL`.

Quick checks:

- Confirm the part's externalized output path resolves inside the tool-output
  directory.
- Confirm `OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR`, if set, points at the
  directory that actually holds the externalized files.

Fix:

- Dereference is deliberately whitelisted to the tool-output directory; any path
  outside it (including a symlink that escapes the root) is rejected by design. This
  is a guardrail, not a bug.
- If your externalized output lives in a non-default location, set
  `OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR` to that root and retry. See
  [configuration.md](../reference/configuration.md) and the redaction/guard policy in
  [SECURITY.md](../../.github/SECURITY.md).

## Related Docs

- Tool catalog: [../reference/tools.md](../reference/tools.md)
- Configuration and environment overrides: [../reference/configuration.md](../reference/configuration.md)
- Search surfaces and channels: [../reference/search-surfaces.md](../reference/search-surfaces.md)
- Architecture and query planner: [../reference/architecture.md](../reference/architecture.md)
- Export and maintenance workflow: [../guides/export-and-maintenance.md](../guides/export-and-maintenance.md)
- Data exposure and redaction policy: [../../.github/SECURITY.md](../../.github/SECURITY.md)
