# opencode-sessions-explorer

> Access to every prior OpenCode session on your machine — recall, search/grep, and historical analysis via 18 LLM-discoverable tools (17 read-only + one explicit unarchive write).

[![CI](https://github.com/iamironz/opencode-sessions-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/iamironz/opencode-sessions-explorer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-sessions-explorer.svg)](https://www.npmjs.com/package/opencode-sessions-explorer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`opencode-sessions-explorer` is an [OpenCode](https://opencode.ai) plugin that exposes your local SQLite session history (`~/.local/share/opencode/opencode.db`) to the running LLM as a set of named tools. Ask in natural language — *"Where in my history did I mention X?"*, *"How much did I spend on Claude this month?"*, *"Which tool fails most for me?"* — and the LLM picks the right tool automatically.

---

## Install

This is published on npm as
[`opencode-sessions-explorer`](https://www.npmjs.com/package/opencode-sessions-explorer).
Add it to the `plugin` array in your OpenCode config — OpenCode auto-installs npm
plugins with Bun on startup (cached under `~/.cache/opencode/node_modules/`), so
there is no separate `npm install` step:

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",

  "plugin": [
    "opencode-sessions-explorer"
  ],

  "permission": {
    "external_directory": {
      "~/.local/share/opencode/**": "allow"
    }
  }
}
```

To pin a version, use `"opencode-sessions-explorer@0.1.0"`.

Then **quit and restart OpenCode**. All 18 tools auto-register.

The `external_directory` permission is required because the OpenCode DB lives
outside your project workspace; you grant read+write to it explicitly (the lone
write is `unarchive-session` — see [Writes](#writes)).

### From source (dev)

To run a local checkout, point the `plugin` entry at the built file instead of
the npm package:

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",

  "plugin": [
    "file:///absolute/path/to/opencode-sessions-explorer/dist/plugin.js"
  ],

  "permission": {
    "external_directory": {
      "~/.local/share/opencode/**": "allow"
    }
  }
}
```

Run `bun run build` first to produce `dist/plugin.js`. For active development you
can point at `src/plugin.ts` directly — Bun loads TS without a build step. Then
**quit and restart OpenCode**.

---

## First run

The text-search tools (`search-text`, `grep-session`) need a filesystem export of your session content (used by `ck` for indexed search). The export contains both raw replay files and derived channel views used for cleaner default recall:

```bash
# One-time, ~30-60s for typical histories
bunx opencode-sessions-explorer-bulk-export

# After upgrading from pre-channel versions, backfill curated recall views
bunx opencode-sessions-explorer-bulk-export --reset

# Optional: build the semantic search index (~5 h for ~150k parts; resumable)
cd ~/.local/share/opencode-sessions-explorer && ck --index .
```

After the first export, the plugin auto-syncs new parts on every search call (3-4s budget).

Run the health check anytime:

```bash
bunx opencode-sessions-explorer-check-deps
```

---

## External dependencies

| Dependency       | Required for                                                   | Install                                                                                            |
| ---------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Bun ≥ 1.0**        | Everything (the plugin uses `bun:sqlite`)                        | OpenCode ships Bun. If running CLIs standalone: <https://bun.sh>                                     |
| **OpenCode DB**      | Everything (the source of truth)                               | Auto-created at `~/.local/share/opencode/opencode.db` by OpenCode. Override path via `$OPENCODE_SESSIONS_EXPLORER_DB` |
| **`ck` CLI ≥ 0.7**     | `search-text` + `grep-session` (the other 16 tools work without)   | `cargo install ck-search` — see <https://github.com/BeaconBay/ck>                                       |

If `ck` is missing, `search-text`/`grep-session` cleanly return `CK_NOT_FOUND`; the other 16 tools work fine.

---

## The 18 tools

### Recall

| Tool                                | Answers                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `opencode-sessions-explorer-current-session`   | *"What session am I in / who am I / where am I"*                         |
| `opencode-sessions-explorer-get-session`       | *"Tell me about session ses_…"* (metadata + counts + children)             |
| `opencode-sessions-explorer-session-summary`   | *"Summarize session ses_…"* (prompts, files, tools, errors, cost)          |
| `opencode-sessions-explorer-session-timeline`  | *"Walk through session ses_… chronologically"*                             |
| `opencode-sessions-explorer-get-message`       | *"Fetch message msg_… with its parts"*                                     |
| `opencode-sessions-explorer-get-part`          | *"Show me part prt_…"* (+ optional tool-output dereference)                |
| `opencode-sessions-explorer-session-genealogy` | *"Parent chain / subagents spawned from ses_…"*                            |

### Browse / filter

| Tool                                   | Answers                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `opencode-sessions-explorer-list-sessions`        | *"List my recent sessions / sessions using agent X / sessions in directory Y"*    |
| `opencode-sessions-explorer-search-sessions-meta` | *"Find sessions costing more than $5 / title matching X / under directory Y"*     |

### Content search

| Tool                                | Answers                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `opencode-sessions-explorer-search-text`       | *"Where in my history did I mention X?"* (curated session-first recall by default; `surface:'forensics'` for raw replay) |
| `opencode-sessions-explorer-grep-session`      | *"Inside session ses_…, grep for X"* (curated channels by default; raw via `surface:'forensics'`)                   |
| `opencode-sessions-explorer-search-tool-calls` | *"Every time I ran git push / every read that errored / all my Jira MCP calls"*                    |

### Analysis

| Tool                                    | Answers                                                |
| --------------------------------------- | ------------------------------------------------------ |
| `opencode-sessions-explorer-cost-by-project`       | *"Cost by project / directory / agent / model"*          |
| `opencode-sessions-explorer-cost-by-period`        | *"OpenCode spend per day / week / month"*                |
| `opencode-sessions-explorer-list-tool-failures`    | *"Which tool fails most / what errors keep recurring"*   |
| `opencode-sessions-explorer-list-repeated-prompts` | *"Have I asked this question before / repeated prompts"* |

### Health

| Tool                       | Answers                                              |
| -------------------------- | ---------------------------------------------------- |
| `opencode-sessions-explorer-db-stats` | *"Is the local OpenCode DB healthy / any schema drift"* |

### Mutate (the one write tool)

| Tool                                       | Answers                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `opencode-sessions-explorer-unarchive-session` | *"Unarchive / restore an archived session ses_…"* (clears `time_archived` + resurfaces) |

This is the **only** tool that writes to `opencode.db`; see [Writes](#writes) below.

### Search Surfaces

`search-text` and `grep-session` are curated by default. They preserve raw recall by reference instead of dumping every matching byte.

| Surface | Default channels | Use when |
| ------- | ---------------- | -------- |
| `recall` | `conversation`, `session-summary` | normal "have I discussed X?" memory questions |
| `debug_trace` | `conversation`, `session-summary`, `tool-error`, `tool-input-summary` | errors, stack traces, failed commands, logs |
| `tool_audit` | `tool-input-summary`, `tool-error` | tool invocation history |
| `code` | `conversation`, `session-summary`, `code-touch`, `patch-summary`, `tool-input-summary` | files, symbols, diffs, code paths |
| `forensics` | `raw` | exhaustive raw replay, including tool output and reasoning |

---

## Compact result format (columnar + interning)

List-shaped results (`list-sessions`, `search-sessions-meta`, `search-tool-calls`, `session-timeline`, `cost-by-project`, `cost-by-period`, `list-tool-failures`, `list-repeated-prompts`, `search-text`, `grep-session`, `session-genealogy` ancestors) are returned as a **lossless columnar table** instead of an array-of-objects. This removes per-row key repetition and interns high-repetition values (model, directory, agent, project, channel, event type) into a small dictionary — measured **−33% to −56%** payload size with no information removed.

```jsonc
"sessions": {
  "cols": ["id","title","agent","model","directory", "...", "archived"],
  "dict": { "agent": ["build","executor-gpt"], "model": [{"id":"gpt-5.5-fast", "...": "..."}], "directory": ["/Users/you"] },
  "rows": [ ["ses_…","Title…",0,0,0, "…", true] ]
}
```

**Decode rule (single):** a cell in a column whose name is a key in `dict` is an integer index into `dict[col]`; otherwise it is the literal value. Scalars next to the table (`has_more`, `mode`, `suppressed`, …) are unchanged. A reference decoder ships as `decodeTable()` in `src/lib/table.ts`. The envelope (`ok`/`data`/`meta`/`warnings`) is unchanged.

---

## Architecture (4 layers)

```
L1  SQLite DB                  ← source of truth (read-only access)
    ↓ (delta sync, runs before every search call)
L2  opencode-sessions-explorer/ tree      ← raw by-session replay + derived by-channel views
    ↓                             (conversation, session-summary, tool-error,
    ↓                             code-touch, tool-output, reasoning, etc.)
L3  .ck/ index                 ← BM25 (Tantivy) + embeddings (bge-small),
    ↓                             auto-incremental via blake3 chunk hash
L4  enriched response          ← every hit re-fetches session/part metadata
                                  from SQLite for accuracy
```

All **reads** go through a shared `bun:sqlite` handle opened `readonly: true` + `PRAGMA query_only = 1`; any accidental write on that path throws. The single exception is the `unarchive-session` tool — see [Writes](#writes).

---

## Writes

17 of the 18 tools are strictly read-only. The lone exception is **`unarchive-session`**, which restores an archived session so it can be opened and prompted again.

- **Why a direct DB write?** OpenCode exposes no archive/unarchive endpoint that can *clear* the flag: its HTTP `UpdatePayload` types `time.archived` as a finite number and the handler ignores `undefined`, so a clear/`null` can't be sent over the wire (verified against v1.15.12 source). `opencode session` only offers `list`/`delete`. A direct DB write is the only mechanism.
- **What it writes.** It clears `time_archived` **and** refreshes `time_updated` to now, in one `UPDATE`, via a separate short-lived read-write connection (`src/lib/db-write.ts`); the shared read handle stays read-only. It **always restores to a usable state** — including an already-active-but-buried session (e.g. one unarchived by an older build that didn't refresh `time_updated`) — so it is not a silent no-op on active sessions; it is idempotent in effect (active + at the top). Only a non-existent id is rejected (`NOT_FOUND`).
- **Why bump `time_updated`?** OpenCode's app/server load the session list ordered by `time_updated DESC` with a default `LIMIT 100` **per directory**. A long-archived session keeps an old `time_updated`, so merely clearing `time_archived` leaves it buried below that window — the app never loads it and prompting fails with *"Unable to retrieve session"*. Refreshing `time_updated` resurfaces the restored session at the top, where the app loads it (this is also the intuitive meaning of "restore").
- **Permission.** No extra permission is needed: the existing `external_directory: { "~/.local/share/opencode/**": "allow" }` rule already covers read+write access to the DB file.
- **After restoring.** An external write emits no `session.updated` event, so an already-open OpenCode window won't update live. **Reload/restart the window** and open OpenCode in the session's **directory** (sessions are listed per directory). Because `time_updated` is refreshed, the restored session then appears at the top of the list.

---

## Configuration

All paths are env-overridable:

| Env var                                | Default                                                          | Purpose                                          |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| `OPENCODE_SESSIONS_EXPLORER_DB`                   | `$XDG_DATA_HOME/opencode/opencode.db` (Linux/Mac) / `%LOCALAPPDATA%/opencode/opencode.db` (Win) | Path to the OpenCode SQLite DB                   |
| `OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`          | `$XDG_DATA_HOME/opencode-sessions-explorer`                          | Where to materialize searchable session content  |
| `OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR`      | `$XDG_DATA_HOME/opencode/tool-output`                              | Whitelist root for `get-part` dereference         |
| `OPENCODE_SESSIONS_EXPLORER_CK_BIN`               | `ck` (via $PATH)                                                 | Override `ck` binary location                      |

---

## Privacy

The plugin exposes **all your prior OpenCode conversations** to the LLM — including tool inputs/outputs that may contain credentials, API tokens, file contents, and other sensitive material. Consider:

- The `search-text` and `grep-session` tools redact common secret shapes (`AKIA…`, `ghp_…`, `sk-…`, JWTs, bearer tokens, etc.) in returned snippets by default. Pass `redact:false` only for explicit local forensics.
- All access is **local read-only** — no data leaves your machine via this plugin.
- The `external_directory` permission rule is required because the DB lives outside your project workspace; you grant it explicitly.

---

## Development

```bash
# Install
bun install

# Typecheck
bun run typecheck

# Build to dist/
bun run build

# Run the rehearsal harness (hermetic by default; live DB via OPENCODE_SESSIONS_EXPLORER_LIVE=1)
bun test

# End-to-end verifier (compares tool output vs ground-truth SQL; needs a live DB)
bun tests/verify-end-to-end.ts

# Plugin invocation (sanity)
bun src/plugin.ts
```

### Repo layout

```
src/
├── plugin.ts                  default Plugin export — registers all 18 tools
├── tools/
│   ├── index.ts               registry { "opencode-sessions-explorer-…": toolDefinition, … }
│   ├── current-session.ts     1 per tool — named const, not default export
│   ├── unarchive-session.ts   the only write tool (clears time_archived + resurfaces)
│   └── (16 more)
├── lib/                       shared internals (db, db-write, ck, export, decode, …)
└── bin/
    ├── bulk-export.ts         materializes session content for ck
    ├── dedupe-export.ts       maintenance
    └── check-deps.ts          install health probe

tests/
├── rehearsal.test.ts          read-only probes (hermetic fixture by default; live DB opt-in)
├── unarchive.test.ts          write-path probes (run against a throwaway DB copy)
├── helpers.ts
├── fixtures.json              session IDs used by the rehearsal probes
└── verify-end-to-end.ts       smoke verifier — runs every tool + compares vs SQL
```

---

## Status

- 18 tools registered (17 read-only + 1 unarchive write)
- Published on npm as [`opencode-sessions-explorer`](https://www.npmjs.com/package/opencode-sessions-explorer)
- Test suite passing **hermetically by default** against a synthetic fixture DB (live-DB probes opt-in via `OPENCODE_SESSIONS_EXPLORER_LIVE=1`; unarchive write-path probes run against a throwaway DB copy)
- 17/17 end-to-end tool verification passing (unarchive probed via the zero-mutation NOT_FOUND path)
- Local and npm plugin installs verified end-to-end

## License

[MIT](LICENSE)
