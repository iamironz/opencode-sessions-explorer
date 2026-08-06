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

The snippet above covers the common macOS/Linux default path. If `$XDG_DATA_HOME`,
Windows `%LOCALAPPDATA%`, or `OPENCODE_SESSIONS_EXPLORER_DB` points to another
database location, allow the actual directory that contains `opencode.db` and
restart OpenCode. Some existing global configs may set `external_directory: "allow"`;
that grants broad access and is useful for local power users, but the scoped path
rule is preferred for normal installs.

## Runtime Compatibility

The plugin targets the OpenCode plugin host contract provided by
`@opencode-ai/plugin >= 1.15.0`. It runs on Bun and uses `bun:sqlite`, which should
include SQLite `json1`; the bundled health probes (`check-deps` CLI and `db-stats`
tool) verify `json1`, schema drift, database runtime settings, ripgrep
availability, and FTS sidecar health for the active OpenCode database.

### Search Backend Dependencies

Text search uses three backends, only one of which is optional:

| Backend | Dependency | When Used |
| --- | --- | --- |
| `fts` | None (built-in `bun:sqlite` FTS5) | Literal queries with a usable 3+ character trigram run, and `lex` mode, when the sidecar is built and covers the requested channels. See [architecture.md](architecture.md) for latency, the trigram-length floor, and coverage limitations (ASCII-only case folding, `tool-output` excerpting, the substring-channel subset). |
| `rg` (ripgrep) | **Required** whenever the planner picks it as the primary backend | Real regex patterns, the `raw` channel, a literal/`lex` query too short for the trigram index, and any query the `fts` tier cannot serve. `grep-session` uses only `rg` — it has no fallback. When `rg` is required and missing, or present but not executable / fails to spawn, the query returns a hard structured error (`RG_NOT_FOUND` or `RG_FAILED`) rather than silently degrading to `ck` or an empty result; a query that doesn't need `rg` (served by `fts` or `ck`) is unaffected. |
| `ck` | Optional, `>= 0.7` | `sem`/`hybrid` modes only. If absent, only those two modes on `search-text` return `CK_NOT_FOUND`; every other search path, including all of `grep-session`, works without it. |

`check-deps` reports the resolved path and version for `rg`, plus presence,
doc count, on-disk bytes, indexed channels, and cursor for the FTS sidecar —
it does not currently report the sidecar's completeness or failure counts.
The `db-stats` tool's `fts` section is the more complete picture: it adds
`complete` (drain-based — true once a sync has walked the entire source
corpus with no unresolved failures, independent of whether that run had a
time budget), `at_source` / `lag_ms` (informational freshness only — lag
never disables the fast tier), `failed_parts`, `dead_letters`, and
`case_folding_ascii_only`. See [architecture.md](architecture.md#partial-index-and-dead-letters)
for the full completeness model, and [tools.md](tools.md) for the exact
`db-stats` field names.

## Environment Overrides

Every path the plugin uses is overridable through an environment variable. These are
the simplest way to point the plugin (or its tests) at non-default locations.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_SESSIONS_EXPLORER_DB` | `$XDG_DATA_HOME/opencode/opencode.db` (macOS/Linux) or `%LOCALAPPDATA%\opencode\opencode.db` (Windows); falls back to `~/.local/share/opencode/opencode.db` | Absolute path to the OpenCode SQLite database the plugin reads. Set this when the database is not in the default OpenCode data directory. |
| `OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT` | `~/.local/share/opencode-sessions-explorer` | Directory where searchable session content is materialized (the `by-session` and `by-channel` export trees that ripgrep and `ck` search, plus the default location of the FTS sidecar file). |
| `OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR` | `$XDG_DATA_HOME/opencode/tool-output` (macOS/Linux) or `%LOCALAPPDATA%\opencode\tool-output` (Windows); falls back to `~/.local/share/opencode/tool-output` | Whitelist root for `get-part` dereference. Only files resolving inside this root may be read when `dereference_output_path:true`; any other path is rejected with `PATH_TRAVERSAL`. |
| `OPENCODE_SESSIONS_EXPLORER_RG_BIN` | `rg` discovered on `PATH` (common install locations checked first) | Absolute path to the ripgrep binary. Set this when `rg` is installed outside `PATH`; used by `search-text` (regex mode and the fallback tier) and `grep-session` (always). |
| `OPENCODE_SESSIONS_EXPLORER_FTS_DB` | `<export root>/fts-index.sqlite` | Absolute path to the FTS5 sidecar file. Set this to relocate the fast literal/`lex` index independently of the export root. |
| `OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS` | Every derived channel except `raw` | Comma-separated override of which channels the FTS sidecar indexes at all. An unknown channel name in the list is ignored; an empty/invalid result falls back to the default set. |
| `OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS` | Same as `OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS` (every indexed channel) | Comma-separated subset of indexed channels that also get a trigram substring row (`docs_sub`), in addition to always getting a BM25 row (`docs_lex`). Channels outside this subset are still `lex`-searchable, just not literal-searchable via `fts`. Trigram storage is roughly 4.6x the source text size on disk versus roughly 1.65x for the BM25 table, so trimming this is a lever for disk-constrained installs. |
| `OPENCODE_SESSIONS_EXPLORER_CK_BIN` | `ck` discovered on `PATH` | Absolute path to the `ck` binary. Set this when `ck` is installed outside `PATH`; only `sem`/`hybrid` `search-text` modes use it. |

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

Use an `rg` binary that is not on `PATH`, and build the FTS sidecar:

```bash
export OPENCODE_SESSIONS_EXPLORER_RG_BIN="$HOME/.cargo/bin/rg"
bunx opencode-sessions-explorer-fts-build
```

Trim the FTS sidecar's channel coverage on a disk-constrained install:

```bash
export OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS="conversation,session-summary,tool-error"
bunx opencode-sessions-explorer-fts-build --reset
```

## Related Docs

- Tool catalog: [tools.md](tools.md)
- Search surfaces and channels: [search-surfaces.md](search-surfaces.md)
- Architecture and query planner: [architecture.md](architecture.md)
- Data exposure and redaction policy: [../../.github/SECURITY.md](../../.github/SECURITY.md)
- Install walkthrough: [../install.md](../install.md)
- Troubleshooting: [../support/troubleshooting.md](../support/troubleshooting.md)
