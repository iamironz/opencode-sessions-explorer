# Configuration Reference

## Scope

This page documents how to configure `opencode-sessions-explorer`: the OpenCode
`permission` rule the plugin needs, the environment variables that override every
filesystem path, and the opt-in switch for running the test suite against real
session data.

The plugin has no settings object of its own — it is configured entirely through
OpenCode permissions and environment variables. All defaults work out of the box on
macOS and Linux; Windows paths resolve via `%LOCALAPPDATA%`.

## Required Permission

The OpenCode session database lives outside your project workspace, so OpenCode
must be granted access to its data directory. Add an `external_directory` allow rule
to your OpenCode config and restart:

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

Without this rule the read-only database handle cannot open the file and tools fail
with `DB_NOT_FOUND` or a permission error. The change takes effect only after a full
OpenCode restart. See [Permission Denied / external_directory](../support/troubleshooting.md#permission-denied--external_directory)
if a tool still cannot reach the database after adding the rule.

## Environment Overrides

Every path the plugin uses is overridable through an environment variable. These are
the simplest way to point the plugin (or its tests) at non-default locations.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_SESSIONS_EXPLORER_DB` | `$XDG_DATA_HOME/opencode/opencode.db` (macOS/Linux) or `%LOCALAPPDATA%\opencode\opencode.db` (Windows); falls back to `~/.local/share/opencode/opencode.db` | Absolute path to the OpenCode SQLite database the plugin reads. Set this when the database is not in the default OpenCode data directory. |
| `OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT` | `~/.local/share/opencode-sessions-explorer` | Directory where searchable session content is materialized (the `by-session` and `by-channel` export trees that `ck` indexes). |
| `OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR` | `$XDG_DATA_HOME/opencode/tool-output` (macOS/Linux) or `%LOCALAPPDATA%\opencode\tool-output` (Windows); falls back to `~/.local/share/opencode/tool-output` | Whitelist root for `get-part` dereference. Only files resolving inside this root may be read when `dereference_output_path:true`; any other path is rejected with `PATH_TRAVERSAL`. |
| `OPENCODE_SESSIONS_EXPLORER_CK_BIN` | `ck` discovered on `PATH` | Absolute path to the `ck` binary. Set this when `ck` is installed outside `PATH`; only `search-text` and `grep-session` use it. |

### `get-part` Dereference Guard

The `OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR` whitelist is enforced before any
externalized tool output is read. Symlinks are resolved before the path is compared
to the root, so a symlink inside the whitelist that points outside it is also
rejected. This is why `get-part` returns `PATH_TRAVERSAL` for any path outside the
tool-output directory — see the troubleshooting page for the recovery steps.

## Testing Override (Dev Only)

`bun test` is hermetic by default and runs against a synthetic fixture database. To
exercise the suite against real session data instead, opt in with:

```bash
OPENCODE_SESSIONS_EXPLORER_LIVE=1 bun test
```

Live runs read real `ses_`/`msg_`/`prt_` ids and minimum counts from your own
history, so failures there reflect local data rather than a regression. This switch
is for contributors only and has no effect on the plugin at runtime; see the
[Development Guide](../maintainers/development.md) for the full contributor loop.

## Examples

Point the plugin at a database in a custom location:

```bash
export OPENCODE_SESSIONS_EXPLORER_DB="/data/opencode/opencode.db"
```

Materialize the search export to a dedicated disk:

```bash
export OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT="/fast-ssd/opencode-search"
bunx opencode-sessions-explorer-bulk-export
```

Use a `ck` binary that is not on `PATH`:

```bash
export OPENCODE_SESSIONS_EXPLORER_CK_BIN="$HOME/.cargo/bin/ck"
```

## Related Docs

- Tool catalog: [tools.md](tools.md)
- Search surfaces and channels: [search-surfaces.md](search-surfaces.md)
- Four-layer architecture: [architecture.md](architecture.md)
- Data exposure and redaction policy: [../../.github/SECURITY.md](../../.github/SECURITY.md)
- Install walkthrough: [../install.md](../install.md)
- Troubleshooting: [../support/troubleshooting.md](../support/troubleshooting.md)
