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
