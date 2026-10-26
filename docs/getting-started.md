# Getting Started

## Purpose

Get from a fresh install to a first successful query against your OpenCode session
history, then branch into the right workflow guide.

## Prerequisites

| Area | Requirement |
| --- | --- |
| OpenCode | A working OpenCode **V2** install that has run at least once (it owns the source database, V2 schema `session_v2` + `session_message`) with the V2 plugin API (`@opencode/plugin >= 2.1`, e.g. opencode v2.1.3) |
| Bun | `>= 1.0` runtime; the plugin uses `bun:sqlite`, which should include SQLite `json1`. OpenCode ships Bun, so a standalone install is only needed to run the bundled CLIs directly. `check-deps` / `db-stats` verify it. |
| `ck` (optional) | [`ck`](https://github.com/BeaconBay/ck) `>= 0.7`, required only by `search-text` and `grep-session`; the other 16 tools work without it |

## Steps

1. Register the plugin (a directory entry: `path` points at the project directory
   containing `index.ts`) and grant access to the OpenCode data directory in
   `~/.config/opencode/opencode.json`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [{ "path": "/absolute/path/to/opencode-sessions-explorer" }],
     "permission": {
       "external_directory": {
         "~/.local/share/opencode/**": "allow"
       }
     }
   }
   ```

   The `external_directory` allow rule is required because the OpenCode database
   lives outside your project workspace. This snippet covers the common macOS/Linux
   default path. If `$XDG_DATA_HOME`, Windows `%LOCALAPPDATA%`, or
   `OPENCODE_SESSIONS_EXPLORER_DB` points elsewhere, allow the actual containing
   directory and restart OpenCode. Some global configs use
   `external_directory: "allow"`; that also permits access, but the scoped path rule
   is preferred for normal users.

1. Quit and restart OpenCode. All 18 tools auto-register through the V2
   `ctx.tool.transform` hook when the plugin's `setup` runs. For a local checkout,
   run `bun install` in it first; for the npm package-spec form, see
   [install.md](install.md).

1. Run the install health probe before exporting. Warnings for a missing export
   tree or missing `ck` are expected on a fresh install:

   ```bash
   bunx opencode-sessions-explorer-check-deps
   ```

1. Materialize the searchable export tree once so content search has data to scan
   (add `--reset` when upgrading from a 0.1.x/V1-era export tree, whose files are
   keyed by legacy `prt_` ids):

   ```bash
   bunx opencode-sessions-explorer-bulk-export
   ```

1. Run the install health probe again and confirm there are no hard failures:

   ```bash
   bunx opencode-sessions-explorer-check-deps
   ```

## Validate

1. Read the final `check-deps` output. It reports database reachability, schema and
   drift, SQLite `json1`, `busy_timeout`, export tree, channel views, `ck` CLI, and
   tool-output directory status. Exit code `0` means all green, `1` means optional
   pieces are missing, and `2` means the plugin cannot work yet.

1. In OpenCode, ask an orientation question such as "what session am I in?" — the
   model routes to `current-session` and returns this session's id, agent, model,
   directory, and useful paths.

## Next Steps

- Recall and navigation: [guides/recall-and-navigation.md](guides/recall-and-navigation.md)
- Search and grep: [guides/search-and-grep.md](guides/search-and-grep.md)
- Cost and usage analysis: [guides/cost-and-usage-analysis.md](guides/cost-and-usage-analysis.md)
- Export and maintenance: [guides/export-and-maintenance.md](guides/export-and-maintenance.md)
- Manage archived sessions: [guides/manage-archived-sessions.md](guides/manage-archived-sessions.md)

## Related Docs

- [Install](install.md)
- [Tool reference](reference/tools.md)
- [Configuration reference](reference/configuration.md)
- [Troubleshooting](support/troubleshooting.md)
