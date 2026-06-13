# AGENTS.md

`opencode-sessions-explorer` is an **OpenCode plugin** that exposes the local OpenCode
SQLite DB (`~/.local/share/opencode/opencode.db`) to the LLM as 18 tools — 17 read-only
(recall, search, cost/usage analysis) plus one deliberate write (`unarchive-session`).
Runtime is **Bun** (it uses `bun:sqlite`), not Node. `README.md` has the full tool
catalog; `CHANGELOG.md` tracks status.

## Commands

| Task                 | Command                                  |
| -------------------- | ---------------------------------------- |
| Install              | `bun install`                            |
| Typecheck            | `bun run typecheck` (`tsc --noEmit`)     |
| Test (full suite)    | `bun test`                               |
| Single test file     | `bun test tests/codec.test.ts`           |
| Build to `dist/`     | `bun run build`                          |
| E2E verify vs SQL    | `bun tests/verify-end-to-end.ts`         |
| Install health probe | `bun src/bin/check-deps.ts`              |

There is **no CI** — `.github/workflows/` is empty. All verification is manual.

## Required workflow before declaring work done

1. `bun run typecheck` must pass (strict mode; `.d.ts` emit is intentionally off — see
   gotchas).
2. `bun test` — but read the **Tests** caveat below before trusting any failure.
3. For changes to tool output, run `bun tests/verify-end-to-end.ts` (compares each tool
   against ground-truth SQL).
4. If you touched anything user-facing, update `README.md` and `CHANGELOG.md`
   (`[Unreleased]`).

## Critical gotchas (verified; easy to get wrong)

- **Imports in `src/` always use `.js`, never `.ts`.** Sibling imports reference the
  compiled path, e.g. `import { stmt } from "../lib/db.js"` — even though the file is
  `db.ts`. Required by `tsc` (`moduleResolution: bundler`) and `bun build`. (Files under
  `tests/` import `src` with `.ts`; that is fine because bun runs them unbuilt.)
- **Tests need a populated *live* DB and are NOT portable.** `tests/fixtures.json`
  hardcodes real `ses_/msg_/prt_` IDs and `expected_counts` minimums (e.g.
  `part_min: 240000`) from the author's machine. `bun test` runs against your real
  `~/.local/share/opencode/opencode.db` and fails if it lacks those IDs/counts. No
  hermetic fixture exists yet (roadmap). Do not treat fixture-ID failures as regressions.
- **`src/plugin.ts` must export only the Plugin function.** OpenCode's loader rejects
  with `Plugin export is not a function` if any non-function export sits beside it; the
  `default` and named exports are the same function by design. Do not add stray exports.
- **The shared `lib/db.js` handle is read-only — never write through it.** It opens
  `readonly: true` + `PRAGMA query_only = 1`, so any write on that path throws. The live
  OpenCode process may be writing concurrently (WAL). The ONE sanctioned write surface is
  `lib/db-write.js` (used only by the `unarchive-session` tool), which opens a SEPARATE,
  short-lived `readwrite: true` connection for a single
  `UPDATE session SET time_archived = NULL, time_updated = <now>` and closes it immediately.
  The `time_updated` bump is REQUIRED, not cosmetic: OpenCode loads sessions ordered by
  `time_updated DESC` with a default `LIMIT 100` per directory, so clearing only
  `time_archived` leaves a long-archived session buried below that window and the app fails
  to retrieve it ("Unable to retrieve session"). Do not add other writers, and do not route
  writes through the shared read handle. (OpenCode exposes no HTTP/SDK endpoint that can
  CLEAR the archived flag — `UpdatePayload.time.archived` is a finite number and the handler
  ignores `undefined` — so the direct DB write is the only mechanism. See
  `src/tools/unarchive-session.ts`.)
- **`.d.ts` declaration emit is disabled** (`tsconfig` `declaration: false`) because
  `tool({…})` leaks zod internals. Do not enable it without adding explicit
  `: ToolDefinition` annotations per tool.

## Architecture (4 layers)

```
SQLite DB (read-only source of truth)
  -> filesystem export tree (~/.local/share/opencode-sessions-explorer; by-session + by-channel)
  -> ck index (.ck/, BM25 + embeddings; optional)
  -> enriched response (re-fetches session/part metadata from SQLite per hit)
```

`search-text` and `grep-session` shell out to the optional **`ck` CLI**. If `ck` is
absent they must return `CK_NOT_FOUND` cleanly — the other 16 tools work without it. The
export tree is materialized by `bin/bulk-export.ts`; the plugin auto-syncs new parts
before each search call.

## Adding or editing a tool

- One tool per file in `src/tools/`, exported as a **named const** (not default).
  Register it in `src/tools/index.ts` under the `opencode-sessions-explorer-<name>` key
  **and** the re-export block.
- Wrap the body in `runWithEnvelope("<fn_name>", capKb, async (ctx) => { … })`
  (`lib/envelope.js`). This builds the `{ ok, data, meta, warnings }` envelope, runs
  schema-drift detection, and sizes the payload against `capKb`.
- Raise recoverable errors via `fail(code, msg, hint)` or
  `throw new SessionsError(code, msg, hint)` using a code from `lib/errors.ts`
  (`NOT_FOUND`, `BAD_ARGS`, `CK_NOT_FOUND`, …). Do not invent ad-hoc error shapes.
- Query the DB through `stmt(sql).all/get(...)` (`lib/db.js`) — cached prepared
  statements; use `json_extract(...)` for the JSON `data` columns on `message`/`part`.
- **List-shaped results must be wrapped in `table(records, { dict: [...] })`**
  (`lib/table.ts`) — lossless columnar + interning format. Reference decoder is
  `decodeTable()`.
- Tool `description`s are long natural-language strings containing `Answers: "..."`
  example phrasings; that text is how the LLM routes to the tool. Match the existing style.

## Env overrides (useful for tests / non-default paths)

`OPENCODE_SESSIONS_EXPLORER_DB`, `OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`,
`OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR`, `OPENCODE_SESSIONS_EXPLORER_CK_BIN`.
`get-part` dereference is path-guarded to the tool-output whitelist (`lib/path-guard.ts`);
search snippets redact secrets by default (pass `redact:false` for local forensics only).
