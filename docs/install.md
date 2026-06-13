# Install

## Purpose

Register `opencode-sessions-explorer` in OpenCode, optionally pin a version, and
grant the one permission it needs to read the OpenCode session database.

## Prerequisites

| Area | Requirement |
| --- | --- |
| OpenCode | A working OpenCode install (the plugin host and source of the database) |
| Bun | `>= 1.0`; bundled with OpenCode, needed standalone only to run the CLIs directly |
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
   the package spec:

   ```jsonc
   {
     "plugin": ["opencode-sessions-explorer@0.1.0"]
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

1. Quit and restart OpenCode. All 18 tools auto-register on the next launch.

### From Source (Dev)

To run a local checkout instead of the published package:

1. Build the bundle:

   ```bash
   bun run build
   ```

1. Point the `plugin` array at the built entrypoint using an absolute path:

   ```jsonc
   {
     "plugin": ["/absolute/path/to/opencode-sessions-explorer/dist/plugin.js"]
   }
   ```

   Bun can also load the TypeScript source directly during iteration by pointing at
   `src/plugin.ts` instead of `dist/plugin.js`. See the
   [Development Guide](maintainers/development.md) for the full dev loop.

## Validate

Confirm the install resolved and the database is reachable:

```bash
bunx opencode-sessions-explorer-check-deps
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
