# Install

## Purpose

Register `opencode-sessions-explorer` in OpenCode, optionally pin a version, and
grant the one permission it needs to read the OpenCode session database.

## Prerequisites

| Area | Requirement |
| --- | --- |
| OpenCode | A working OpenCode install with plugin host compatibility for `@opencode-ai/plugin >= 1.15.0` |
| Bun | `>= 1.0`; bundled with OpenCode, needed standalone only to run the CLIs directly. The plugin uses `bun:sqlite`, which should include SQLite `json1`; `check-deps` / `db-stats` verify it. |
| `ck` (optional) | `>= 0.7`, only for `search-text` and `grep-session` |

## Steps

1. Add the plugin to the `plugin` array in `~/.config/opencode/opencode.json`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-sessions-explorer"]
   }
   ```

   OpenCode auto-installs npm plugins with Bun on startup and caches them under
   `~/.cache/opencode/node_modules`, so there is no separate install command.

1. (Optional) Pin a version to avoid surprise upgrades by appending the version to
   the package spec (for example, the current latest):

   ```jsonc
   {
     "plugin": ["opencode-sessions-explorer@0.1.1"]
   }
   ```

1. Grant access to the OpenCode data directory. This is required because the
   database lives outside your project workspace:

   ```jsonc
   {
     "permission": {
       "external_directory": {
         "~/.local/share/opencode/**": "allow"
       }
     }
   }
   ```

   This default snippet covers the common macOS/Linux path. If `$XDG_DATA_HOME`,
   Windows `%LOCALAPPDATA%`, or `OPENCODE_SESSIONS_EXPLORER_DB` points elsewhere,
   allow the actual containing directory and restart OpenCode. Some current global
   configs may use `external_directory: "allow"`; that works, but the scoped path
   rule above is preferred for normal users.

1. Quit and restart OpenCode. All 18 tools auto-register on the next launch.

### From Source (Dev)

To run a local checkout instead of the published package, install dependencies in
the checkout first:

```bash
bun install --frozen-lockfile
```

Then choose one source-dev mode.

#### Option A: Source TypeScript For Iteration

Point the `plugin` array at the source entrypoint using an absolute path:

```jsonc
{
  "plugin": ["/absolute/path/to/opencode-sessions-explorer/src/plugin.ts"]
}
```

This is the fastest iteration path because there is no `dist/` rebuild step, but a
full OpenCode restart is still required after config or code changes. Do not assume
hot reload.

#### Option B: Built JavaScript

Build the bundle, then point OpenCode at the built entrypoint:

```bash
bun run build
```

```jsonc
{
  "plugin": ["/absolute/path/to/opencode-sessions-explorer/dist/plugin.js"]
}
```

When using `dist/`, rebuild and fully restart OpenCode after code changes. There is
no hot reload guarantee for local plugin paths.

For contributor commands, quality gates, and source-dev maintenance pointers, see
the [Development Guide](maintainers/development.md).

## Use From A Non-OpenCode MCP Host

The package ships a second entry point, `dist/mcp.js`, that serves the same tools
over the Model Context Protocol on stdio. Use it when the caller is **not**
OpenCode (any MCP-capable agent or client). OpenCode users do not need this; the
plugin path above already registers every tool.

Both entry points read the same registry in `src/tools/index.ts`, so there is no
second tool catalog to keep in sync.

### Host Configuration

Build once (`bun run build`), then point the host at the built file:

```yaml
mcp_servers:
  opencode-history:
    command: bun
    args: ["run", "/home/iamironz/projects/opencode-sessions-explorer/dist/mcp.js"]
```

Replace the path with your own checkout. Installed as a package, the equivalent
command is the `opencode-sessions-explorer-mcp` bin.

The host still needs read access to `~/.local/share/opencode/` — the MCP server
reads the same database described in [Configuration](reference/configuration.md),
and honors the same `OPENCODE_SESSIONS_EXPLORER_*` environment overrides.

### Exposed Tools

16 of the 18 tools are exposed. The `opencode-sessions-explorer-` prefix is
stripped because the MCP host supplies its own namespace, so
`opencode-sessions-explorer-list-sessions` is called as `list-sessions`:

| Category | Tools |
| --- | --- |
| Recall and navigation | `list-sessions`, `get-session`, `session-summary`, `session-timeline`, `session-genealogy`, `get-message`, `get-part` |
| Search | `search-text`, `grep-session`, `search-sessions-meta`, `search-tool-calls` |
| Cost and usage | `cost-by-period`, `cost-by-project`, `list-repeated-prompts`, `list-tool-failures` |
| Diagnostics | `db-stats` |

### Deliberate Exclusions

| Tool | Why It Is Withheld |
| --- | --- |
| `current-session` | Answers "which session am I running in", which is resolved from OpenCode host identity. A foreign host has no such identity, so the result would be meaningless. |
| `unarchive-session` | The only write path into the live `opencode.db`. This entry point is read-only by design. |

To restore an archived session, use the OpenCode plugin path and
[Manage Archived Sessions](guides/manage-archived-sessions.md).

### Validate The MCP Entry Point

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun run dist/mcp.js
```

A healthy server replies with a JSON-RPC result listing 16 tools. Unknown tool
names return an MCP result with `isError: true` rather than terminating the
server. `stdout` carries only JSON-RPC frames, so never add logging to it.

## Validate

Confirm the install resolved and the database is reachable:

```bash
bunx opencode-sessions-explorer-check-deps
```

For source checkouts, run local checkout commands instead of `bunx` while iterating:

```bash
bun src/bin/check-deps.ts
bun src/bin/bulk-export.ts
```

If you selected the built-JS option and have already run `bun run build`, you can
also validate the built CLI:

```bash
bun dist/bin/check-deps.js
```

A `0` exit code is all green; `1` flags optional pieces (such as a missing export
tree or `ck`); `2` means a hard failure that must be fixed before the tools work.

## Next Steps

Continue with [getting-started.md](getting-started.md) to materialize the search
export and run a first query.

## Related Docs

- [Getting Started](getting-started.md)
- [Configuration reference](reference/configuration.md)
- [Development Guide](maintainers/development.md)
- [Troubleshooting](support/troubleshooting.md)
