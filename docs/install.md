# Install

## Purpose

Register `opencode-sessions-explorer` in OpenCode, optionally pin a version, and
grant the one permission it needs to read the OpenCode session database.

## Prerequisites

| Area | Requirement |
| --- | --- |
| OpenCode | A working OpenCode **V2** install (plugin API `@opencode/plugin >= 2.1`, e.g. opencode v2.1.3). The V1 plugin API (`@opencode-ai/plugin`, pre-V2 hosts) is no longer supported. |
| Data schema | The OpenCode V2 SQLite schema (`session_v2` + `session_message`). Imported pre-V2 history is included; the frozen V1 `session`/`message`/`part` tables are not read. |
| Bun | `>= 1.0`; bundled with OpenCode, needed standalone only to run the CLIs directly. The plugin uses `bun:sqlite`, which should include SQLite `json1`; `check-deps` / `db-stats` verify it. |
| `ck` (optional) | `>= 0.7`, only for `search-text` and `grep-session` |

> **Upgrading from 0.1.x (V1 plugin)?** Part references changed shape: parts are
> now addressed as `<messageId>#<contentIndex>` (for example `msg_…#0`) instead
> of `prt_…` ids. Run `opencode-sessions-explorer-bulk-export --reset` once after
> upgrading; the export engine re-exports from `session_message` and tombstones the
> old `prt_`-keyed files.

## Steps

1. Add the plugin to the `plugin` array in `~/.config/opencode/opencode.json`. The
   V2 host loads a plugin from a **directory entry**: point `path` at the project
   directory that contains `index.ts`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [{ "path": "/absolute/path/to/opencode-sessions-explorer" }]
   }
   ```

   `index.ts` re-exports the `Plugin.define({ id, setup })` definition from
   `src/plugin.ts`; there is no separate install command beyond `bun install` in
   the checkout (see [From Source](#from-source-dev)).

1. (Optional) Use the npm package spec instead of a local path. OpenCode
   auto-installs npm plugins with Bun on startup and caches them under
   `~/.cache/opencode/node_modules`. Pin a version to avoid surprise upgrades:

   ```jsonc
   {
     "plugin": ["opencode-sessions-explorer@<version>"]
   }
   ```

   Only releases that include the V2 port load on a V2 host; the published 0.1.x
   releases target the V1 plugin API. Check [CHANGELOG.md](../CHANGELOG.md) before
   pinning.

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

1. Quit and restart OpenCode. All 18 tools auto-register through the V2
   `ctx.tool.transform` hook when the plugin's `setup` runs.

### From Source (Dev)

To run a local checkout instead of the published package, install dependencies in
the checkout first:

```bash
bun install --frozen-lockfile
```

Then register the checkout directory (the folder containing `index.ts`) with an
absolute path:

```jsonc
{
  "plugin": [{ "path": "/absolute/path/to/opencode-sessions-explorer" }]
}
```

The host runs the TypeScript sources directly, so there is no `dist/` rebuild step,
but a full OpenCode restart is still required after config or code changes. Do not
assume hot reload.

`bun run build` produces `dist/` — the npm package entry (`dist/plugin.js`), the
bundled CLIs under `dist/bin/`, and the MCP server `dist/mcp.js`. You need it for
publishing, for the MCP entry point below, and for validating the built CLIs; it is
not needed to load the plugin from a checkout.

Confirm the plugin wiring without starting OpenCode (hermetic: simulates the V2
host, runs `setup`, and checks that all 18 tools register):

```bash
bun tests/smoke-plugin-load.ts
```

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

If you have already run `bun run build`, you can also validate the built CLI:

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
