# AGENTS.md

`opencode-sessions-explorer` is an **OpenCode V2 plugin** that exposes the local
OpenCode SQLite DB (`~/.local/share/opencode/opencode.db`, V2 schema:
`session_v2` + `session_message`, parts INLINE in `data.content[]`) to the LLM
as 18 tools — 17 read-only (recall, search, cost/usage analysis) plus one
deliberate write (`unarchive-session`). Runtime is **Bun** (it uses
`bun:sqlite`), not Node. `README.md` has the full tool catalog; `CHANGELOG.md`
tracks status.

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

CI runs in GitHub Actions: `.github/workflows/ci.yml` runs typecheck, build, the
hermetic test suite, the end-to-end verify, and `pack:dry` on ubuntu + macos;
`publish.yml` publishes to npm on `v*` tags; `labels.yml` syncs issue labels.

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
- **Tests are hermetic by default; LIVE mode is opt-in.** `bun test` preloads
  `tests/setup.ts`, which points every `OPENCODE_SESSIONS_EXPLORER_*` path at a
  temp dir and builds a synthetic V2 fixture DB (`tests/fixtures/build-fixture.ts`).
  With `OPENCODE_SESSIONS_EXPLORER_LIVE=1` (`bun run test:live`) the preload no-ops
  and tests run against your real `~/.local/share/opencode/opencode.db` using
  `tests/fixtures.json` — those LIVE IDs/counts are from the author's machine, so
  LIVE fixture-ID failures are NOT regressions. LIVE grep/search tests also need a
  populated export tree (`bulk-export --reset`) first.
- **The V2 entry is the default export of `Plugin.define` at the project root.**
  `index.ts` (directory entry for the V2 host) re-exports `src/plugin.ts`, whose ONLY
  export is the `Plugin.define({ id, setup })` result. Tools register through the
  SYNCHRONOUS `ctx.tool.transform(editor => editor.add(tool))` hook — keep it cheap;
  one-time side effects (e.g. capturing the location directory) belong in `setup`.
  Tool args are plain JSON Schema; `lib/tool-v2.ts` (`defineTool`) applies defaults and
  wraps the envelope string into the V2 `{ content }` result shape.
- **The shared `lib/db.js` handle is read-only — never write through it.** It opens
  `readonly: true` + `PRAGMA query_only = 1`, so any write on that path throws. The live
  OpenCode process may be writing concurrently (WAL). The ONE sanctioned write surface is
  `lib/db-write.js` (used only by the `unarchive-session` tool), which opens a SEPARATE,
  short-lived `readwrite: true` connection for a single
  `UPDATE session_v2 SET time_archived = NULL, time_updated = <now>` and closes it
  immediately. The `time_updated` bump is REQUIRED, not cosmetic: verified against the
  opencode v2.1.3 binary, the V2 session picker (`SessionStore.list`) loads
  `session_v2` ordered by `time_updated DESC, id DESC` (archived rows filtered via
  `time_archived IS NULL`), so clearing only `time_archived` leaves a long-archived
  session buried below the recency window and the app fails to retrieve it. Do not add
  other writers, and do not route writes through the shared read handle. (OpenCode
  exposes no HTTP/SDK endpoint that can CLEAR the archived flag, so the direct DB write
  is the only mechanism. See `src/tools/unarchive-session.ts`.)
- **V2 part identity is synthesized.** There are no `part` rows anymore; parts are
  `session_message.data.content[]` items addressed as `<messageId>#<index>`
  (`lib/v2-parts.ts` enumerates them, including user/system/synthetic text as `#0`
  text parts and compaction markers as `#0` compaction parts). Export filenames,
  timeline events, and search hits all use this id; `#` is preserved in filenames.
- **`.d.ts` declaration emit is disabled** (`tsconfig` `declaration: false`) because
  JSON-Schema tool inputs + the V2 `Info` generics leak host internals. Do not enable
  it without adding explicit annotations per tool.

- **Arguments are validated centrally in `defineTool`** (`lib/jsonschema.js`
  `validateArgs`): unknown keys, wrong types, ranges and enums produce one `BAD_ARGS`
  envelope listing every problem plus `describeArgs()` as the hint. Keep tool schemas
  accurate — `tests/arg-validation.test.ts` asserts every tool's defaults and minimal
  required input validate cleanly. Retired parameters get a specific message via the
  `removedArgs` field of `defineTool` (e.g. `mode` on search-text/grep-session).
- **Never point the live OpenCode config at this repo; publish snapshots.** The
  long-running V2 server caches plugin modules by file path for the life of the
  process, so hot-reloading straight from the mutable repo can pin a half-written
  module (2026-10-26: every reload failed with "Export named … not found" until a fresh
  path was used). Edit here, run the validation workflow, then `bun run publish:live`
  (`scripts/publish-live.sh`): it copies `index.ts`/`package.json`/`src` to a new
  `~/.cache/opencode-sessions-explorer-live/<UTC-stamp>/`, symlinks `node_modules`,
  repoints the `plugin` entry in `~/.config/opencode/opencode.json` (hot-reload, no
  server restart) and keeps the newest 3 snapshots. Never restart the operator's
  OpenCode server to deploy.

## Architecture (4 layers)

```
SQLite DB (read-only source of truth)
  -> filesystem export tree (~/.local/share/opencode-sessions-explorer; by-session + by-channel)
  -> ck regex scan (stateless; optional)
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
  (`lib/envelope.js`) inside a `defineTool({ name, description, args, execute })`
  (`lib/tool-v2.js`). `defineTool` applies JSON-Schema defaults and wraps the
  envelope into the V2 `{ content }` result; `runWithEnvelope` builds the
  `{ ok, data, meta, warnings }` envelope, runs schema-drift detection, and sizes
  the payload against `capKb`.
- Raise recoverable errors via `fail(code, msg, hint)` or
  `throw new SessionsError(code, msg, hint)` using a code from `lib/errors.ts`
  (`NOT_FOUND`, `BAD_ARGS`, `CK_NOT_FOUND`, …). Do not invent ad-hoc error shapes.
- Query the DB through `stmt(sql).all/get(...)` (`lib/db.js`) — cached prepared
  statements; use `json_each(sm.data,'$.content')` + `json_extract(...)` for the
  inline V2 parts, and NEVER alias a `json_extract` expression as `key` in
  `GROUP BY key` (SQLite 3.53 mis-groups it — use `grp` and map back in TS).
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
