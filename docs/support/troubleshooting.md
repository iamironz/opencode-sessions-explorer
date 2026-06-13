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
   `busy_timeout`, export tree presence, curated channel views, `ck` CLI, `ck`
   index, and the tool-output directory. Add `--json` for machine-readable output.

2. Probe the database from inside OpenCode with the `db-stats` tool. It returns the
   migration head, table counts, json1 status, `busy_timeout`, and any schema-drift
   warnings.

If both come back clean, the plugin core is healthy and the issue is likely scoped
to one tool or to the optional `ck` search path.

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

`search-text` or `grep-session` returns the error code `CK_NOT_FOUND`.

Quick checks:

- Confirm whether `ck` is installed and on `PATH`: `ck --version`.
- Run `bunx opencode-sessions-explorer-check-deps` and look at the `ck` line.

Fix:

- Install [`ck`](https://github.com/BeaconBay/ck) (>= 0.7). If it is installed
  outside `PATH`, point the plugin at it with
  `OPENCODE_SESSIONS_EXPLORER_CK_BIN=/abs/path/to/ck`.
- `ck` is only needed for `search-text` and `grep-session`. The other 16 tools work
  without it, so recall, browse, cost, and analysis tools remain available
  meanwhile. See [configuration.md](../reference/configuration.md).

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

- Confirm the export tree has been materialized at least once.
- Note whether the session you expect is very new — its parts may not be exported
  yet.
- Confirm the term is not being narrowed away by `role`, `surface`, or a time/scope
  filter.

Fix:

- Run the one-time export, then retry:

  ```bash
  bunx opencode-sessions-explorer-bulk-export
  ```

- New parts are delta-synced automatically before each `search-text` /
  `grep-session` call, so a missing recent part usually resolves on the next search.
- Widen the search: try `surface:'forensics'` (or `channels:['raw']`) to include raw
  bodies, and confirm `role` is `any`. See
  [search-surfaces.md](../reference/search-surfaces.md).

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
- Four-layer architecture: [../reference/architecture.md](../reference/architecture.md)
- Export and maintenance workflow: [../guides/export-and-maintenance.md](../guides/export-and-maintenance.md)
- Data exposure and redaction policy: [../../.github/SECURITY.md](../../.github/SECURITY.md)
