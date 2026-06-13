# Getting Started

## Purpose

Get from a fresh install to a first successful query against your OpenCode session
history, then branch into the right workflow guide.

## Prerequisites

| Area | Requirement |
| --- | --- |
| OpenCode | A working OpenCode install that has run at least once (it owns the source database) |
| Bun | `>= 1.0` runtime; the plugin uses `bun:sqlite`. OpenCode ships Bun, so a standalone install is only needed to run the bundled CLIs directly |
| `ck` (optional) | [`ck`](https://github.com/BeaconBay/ck) `>= 0.7`, required only by `search-text` and `grep-session`; the other 16 tools work without it |

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
   lives outside your project workspace.

1. Quit and restart OpenCode. It auto-installs npm plugins with Bun on startup, so
   there is no separate `npm install` step, and all 18 tools auto-register.

1. Materialize the searchable export tree once so content search has data to scan:

   ```bash
   bunx opencode-sessions-explorer-bulk-export
   ```

1. (Optional) Build the semantic index to enable `mode:'sem'` and `mode:'hybrid'`
   search. This is a slow, one-time pass:

   ```bash
   cd ~/.local/share/opencode-sessions-explorer && ck --index .
   ```

## Validate

1. Run the install health probe and confirm no hard failures:

   ```bash
   bunx opencode-sessions-explorer-check-deps
   ```

   It reports the database, schema, export tree, and `ck` status. Exit code `0`
   means all green, `1` means optional pieces are missing, and `2` means the plugin
   cannot work yet.

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
