# opencode-sessions-explorer

[![CI](https://github.com/iamironz/opencode-sessions-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/iamironz/opencode-sessions-explorer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-sessions-explorer.svg)](https://www.npmjs.com/package/opencode-sessions-explorer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Recall, search, and analyze every past [OpenCode](https://opencode.ai) session —
18 LLM-discoverable tools over the OpenCode SQLite database.

`opencode-sessions-explorer` is an OpenCode plugin that exposes your OpenCode
session history (`~/.local/share/opencode/opencode.db`) to the running model as a
set of named tools — 17 read-only (recall, search/grep, cost/usage analysis) plus
one explicit `unarchive-session` write. Ask in natural language and the model picks
the right tool automatically; nothing leaves your device.

Example questions it answers:

```text
Where in my history did I mention the export codec?
Summarize session ses_… and list the files it touched.
How much did I spend on Claude this month, by project?
Which tool fails most for me, and what errors keep recurring?
Unarchive session ses_… so I can open it again.
```

## Compatibility

| Area | Support | Notes |
| --- | --- | --- |
| OpenCode | Plugin host compatible with `@opencode-ai/plugin >= 1.15.0` | Loads the plugin and owns the source database |
| Bun | `>= 1.0` | Runtime; the plugin uses `bun:sqlite` (OpenCode ships Bun), which should include SQLite `json1`; `check-deps` / `db-stats` verify it |
| `ck` | `>= 0.7`, optional | Only `search-text` / `grep-session` need it; the other 16 tools work without it |
| OS | macOS / Linux | Windows paths resolve via `%LOCALAPPDATA%` |

## Quick Start

1. Add the plugin and grant access to the OpenCode data directory:

```jsonc
// ~/.config/opencode/opencode.json
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

The `external_directory` snippet covers the common macOS/Linux default path. If
`$XDG_DATA_HOME`, Windows `%LOCALAPPDATA%`, or
`OPENCODE_SESSIONS_EXPLORER_DB` points elsewhere, allow the actual containing
directory and restart OpenCode. Some existing global configs use
`external_directory: "allow"`; that also permits access, but the scoped path rule
above is preferred for normal users.

1. **Quit and restart OpenCode.** All 18 tools auto-register. OpenCode auto-installs
   npm plugins with Bun on startup, so there is no separate `npm install` step.
1. Run the health probe once. Warnings for the missing export tree, missing `ck`, or
   missing `ck` index are okay at this stage:

```bash
bunx opencode-sessions-explorer-check-deps
```

1. Materialize the search export once:

```bash
bunx opencode-sessions-explorer-bulk-export
```

1. (Optional) Build the `ck` index from the export root, not the repo root:

```bash
cd ~/.local/share/opencode-sessions-explorer
ck --index .  # run in the export root, not the repo root
```

1. Run the health probe again to confirm the export and optional index state:

```bash
bunx opencode-sessions-explorer-check-deps
```

The `external_directory` permission is required because the OpenCode database lives
outside your project workspace. For installing from source, version pinning, and the
full first-run walkthrough, see [docs/install.md](docs/install.md) and
[docs/getting-started.md](docs/getting-started.md).

## Features

### Recall and Navigation

- **Find your bearings.** `current-session`, `get-session`, and `session-summary`
  report where you are and what a session contains.
- **Walk a session.** `session-timeline` and `session-genealogy` trace the
  chronology and the parent/subagent chain.
- **Drill into detail.** `get-message` and `get-part` fetch individual messages and
  parts, with optional tool-output dereference.
- **Browse and filter.** `list-sessions` and `search-sessions-meta` find sessions by
  recency, agent, directory, title, or cost.
- See [docs/guides/recall-and-navigation.md](docs/guides/recall-and-navigation.md).

### Content Search and Grep

- **Search across history.** `search-text` answers "where did I mention X?" with
  curated session-first recall by default.
- **Grep one session.** `grep-session` scans a single session's curated channels,
  with raw replay via `surface:'forensics'`.
- **Audit tool calls.** `search-tool-calls` finds every invocation of a command,
  every read that errored, or all calls to a given MCP.
- See [docs/guides/search-and-grep.md](docs/guides/search-and-grep.md).

### Cost and Usage Analysis

- **Spend by dimension.** `cost-by-project` breaks cost down by project, directory,
  agent, or model.
- **Spend over time.** `cost-by-period` reports OpenCode spend per day, week, or month.
- **Failure and repetition signals.** `list-tool-failures` and
  `list-repeated-prompts` surface recurring errors and duplicated questions.
- See [docs/guides/cost-and-usage-analysis.md](docs/guides/cost-and-usage-analysis.md).

### Export and Maintenance

- **One-time export.** `bulk-export` materializes searchable session content for `ck`.
- **Stay current.** The plugin auto-syncs new parts before each search call; rebuild
  the optional semantic index explicitly (`ck --reindex .` / `ck --index .`) when
  `sem` or `hybrid` warnings report stale or partial coverage.
- **Health probe.** `check-deps` and the `db-stats` tool report dependency and schema
  health.
- See [docs/guides/export-and-maintenance.md](docs/guides/export-and-maintenance.md).

### Archived Session Recovery

- **Restore a buried session.** `unarchive-session` is the one write tool — it clears
  `time_archived` **and** refreshes `time_updated` so the session resurfaces at the
  top of the per-directory list and can be opened again.
- See [docs/guides/manage-archived-sessions.md](docs/guides/manage-archived-sessions.md).

### Privacy and Safety

- **Local and read-only by default.** 17 of 18 tools never write; no data leaves your
  device through this plugin.
- **Secret redaction.** `search-text` / `grep-session` redact common secret shapes in
  snippets by default; `get-part` dereference is path-guarded to a whitelist root.
- See [docs/reference/configuration.md](docs/reference/configuration.md) and
  [.github/SECURITY.md](.github/SECURITY.md).

## Documentation

Docs home: [docs/README.md](docs/README.md)

| Goal | Doc |
| --- | --- |
| Install and first run | [docs/install.md](docs/install.md), [docs/getting-started.md](docs/getting-started.md) |
| Recall and navigation | [docs/guides/recall-and-navigation.md](docs/guides/recall-and-navigation.md) |
| Search and grep | [docs/guides/search-and-grep.md](docs/guides/search-and-grep.md) |
| Cost and usage analysis | [docs/guides/cost-and-usage-analysis.md](docs/guides/cost-and-usage-analysis.md) |
| Export and maintenance | [docs/guides/export-and-maintenance.md](docs/guides/export-and-maintenance.md) |
| Archived session recovery | [docs/guides/manage-archived-sessions.md](docs/guides/manage-archived-sessions.md) |
| Tool reference | [docs/reference/tools.md](docs/reference/tools.md) |
| Configuration | [docs/reference/configuration.md](docs/reference/configuration.md) |
| Search surfaces | [docs/reference/search-surfaces.md](docs/reference/search-surfaces.md) |
| Response format | [docs/reference/response-format.md](docs/reference/response-format.md) |
| Architecture | [docs/reference/architecture.md](docs/reference/architecture.md) |
| Troubleshooting | [docs/support/troubleshooting.md](docs/support/troubleshooting.md) |
| Maintainer and release | [docs/maintainers/development.md](docs/maintainers/development.md), [docs/maintainers/release.md](docs/maintainers/release.md) |
| Change log | [CHANGELOG.md](CHANGELOG.md) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
