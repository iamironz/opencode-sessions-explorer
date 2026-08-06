# Getting Started

## Purpose

Get from a fresh install to a first successful query against your OpenCode session
history, then branch into the right workflow guide.

## Prerequisites

| Area | Requirement |
| --- | --- |
| OpenCode | A working OpenCode install that has run at least once (it owns the source database) and a plugin host compatible with `@opencode-ai/plugin >= 1.15.0` |
| Bun | `>= 1.0` runtime; the plugin uses `bun:sqlite`, which should include SQLite `json1`. OpenCode ships Bun, so a standalone install is only needed to run the bundled CLIs directly. `check-deps` / `db-stats` verify it. |
| `ripgrep` (`rg`) | Required whenever the search planner picks it as the primary backend — `regex` mode, the exhaustive fallback tier, and every `grep-session` call. Install via `brew install ripgrep` (macOS), `apt install ripgrep` (Debian/Ubuntu), or `cargo install ripgrep`. `check-deps` verifies it; a missing `rg` returns a hard `RG_NOT_FOUND` error for a query that needs it, rather than silently falling back to `ck`. |
| `ck` (optional) | [`ck`](https://github.com/BeaconBay/ck) `>= 0.7`, required only by `sem`/`hybrid` search modes; every other tool, including literal/`lex`/`regex` search and all of `grep-session`, works without it |

## Steps

1. Register the plugin and grant access to the OpenCode data directory in
   `~/.config/opencode/opencode.json`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-sessions-explorer"],
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

1. Quit and restart OpenCode. It auto-installs npm plugins with Bun on startup, so
   there is no separate `npm install` step, and all 18 tools auto-register.

1. Run the install health probe before exporting. Warnings for a missing export
   tree, missing FTS index, missing `ck`, or missing `ck` index are expected on a
   fresh install; a **failure** on the ripgrep line means `regex`-mode search
   will not work until it is installed (`brew install ripgrep` on macOS,
   `apt install ripgrep` on Debian/Ubuntu, or `cargo install ripgrep`):

   ```bash
   bunx opencode-sessions-explorer-check-deps
   ```

1. Materialize the searchable export tree once so ripgrep/`ck` search have data
   to scan:

   ```bash
   bunx opencode-sessions-explorer-bulk-export
   ```

1. Build the FTS5 sidecar once so literal (3+ character) and `lex` search
   can use the fast indexed path instead of ripgrep. Let it run to
   completion — a run stopped early with `--budget-ms` leaves the index
   partial, and `fts-build` prints `COMPLETE = false` and a warning when
   that happens:

   ```bash
   bunx opencode-sessions-explorer-fts-build
   ```

1. (Optional) Prewarm the `ck` index. This only matters for `mode:'sem'` and
   `mode:'hybrid'` searches, which otherwise let `ck` lazily build or refresh
   indexes during the search; prewarming only avoids first-search latency or
   helps troubleshooting. Run it in the export root, not in the repository
   checkout:

   ```bash
   cd ~/.local/share/opencode-sessions-explorer
   ck --index .  # optional prewarm in the export root; sem/hybrid only
   ```

1. Run the install health probe again and confirm there are no hard failures:

   ```bash
   bunx opencode-sessions-explorer-check-deps
   ```

## Validate

1. Read the final `check-deps` output. It reports database reachability, schema and
   drift, SQLite `json1`, `busy_timeout`, export tree, channel views, ripgrep
   binary + version, FTS sidecar health, `ck` CLI, `ck` index, and tool-output
   directory status. Exit code `0` means all green, `1` means optional pieces are
   missing, and `2` means the plugin cannot work yet.

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
