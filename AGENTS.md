# AGENTS.md

`opencode-sessions-explorer` is an **OpenCode plugin** that exposes the local OpenCode
SQLite DB (`~/.local/share/opencode/opencode.db`) to the LLM as 18 tools — 17 read-only
(recall, search, cost/usage analysis) plus one deliberate write (`unarchive-session`).
Runtime is **Bun** (it uses `bun:sqlite`), not Node. `README.md` has the full tool
catalog; `CHANGELOG.md` tracks status.

## Commands

| Task                    | Command                                                        |
| ----------------------- | -------------------------------------------------------------- |
| Install                 | `bun install`                                                  |
| Typecheck               | `bun run typecheck` (`tsc --noEmit`)                           |
| Test (full suite)       | `bun test`                                                     |
| Single test file        | `bun test tests/codec.test.ts`                                 |
| Build to `dist/`        | `bun run build`                                                |
| E2E verify vs SQL       | `bun tests/verify-end-to-end.ts`                               |
| Install health probe    | `bun src/bin/check-deps.ts`                                    |
| Build/refresh FTS index | `bun src/bin/fts-build.ts` (`--reset`, `--budget-ms N`)        |
| Test against real DB    | `bun run test:live` (sets `OPENCODE_SESSIONS_EXPLORER_LIVE=1`) |

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
- **`bun test` is hermetic by default via the `bunfig.toml` `[test].preload` of
  `tests/setup.ts`**, which runs against a synthetic fixture DB and deliberately
  points `OPENCODE_SESSIONS_EXPLORER_CK_BIN` at a non-existent binary (so `ck`
  paths are exercised as absent). `bun run test:live` opts into the real DB
  (`OPENCODE_SESSIONS_EXPLORER_LIVE=1`); `tests/fixtures.json` hardcodes real
  `ses_/msg_/prt_` IDs and `expected_counts` minimums from the author's machine
  for that mode only. Do not treat live-mode fixture-ID failures as regressions
  against the hermetic default.
- **Never open the FTS sidecar (`lib/fts.ts`) with `readonly: true`.** A
  `readonly: true` `bun:sqlite` connection throws `SQLITE_CANTOPEN` against a
  WAL-mode database whose `-shm` file is absent (e.g. right after
  `PRAGMA wal_checkpoint(TRUNCATE)`). A swallowed throw there previously
  silently disabled the entire fast search tier with no diagnostic trace. The
  sidecar is a file we exclusively own and write, so always open it read-write
  through the module's single cached handle (`openFts`); never add a second,
  read-only open path.
- **Never add an `ESCAPE` clause (or `GLOB`) to the trigram `LIKE` in
  `lib/fts.ts`.** Either one disables SQLite's trigram-index optimization for
  the operator entirely, forcing a full content scan. Measured on the real
  565k-doc / 5GB index: `EXPLAIN QUERY PLAN` shows
  `SCAN docs_sub VIRTUAL TABLE INDEX 0:L6` at 7.5ms without it, vs a bare
  `SCAN ... INDEX 0:` at 665ms with it — an 88x regression. Handle literal
  `%`/`_` and `case_sensitive` correctness without escaping: leave them as
  ordinary LIKE wildcards (a safe superset, never a subset) and drop false
  positives with an exact `instr()` post-filter instead.
- **`ck` must never be used for the `raw` channel/tree.** Measured 30-34s
  timeouts returning zero rows over 328,069 files, vs 6.2s for ripgrep over the
  same tree. `ck` is reserved for `sem`/`hybrid` only (see `lib/query-plan.ts`);
  `rg` is the terminal fallback for everything else, including `raw`.
- **A missing `rg` is a hard `RG_NOT_FOUND` throw when it's the primary
  backend, not a silent `ck` fallback.** `requireRg()` in `lib/query-plan.ts`
  throws `new SessionsError("RG_NOT_FOUND", ...)` rather than degrading —
  `runWithEnvelope` catches it into `{ ok: false, error }` automatically. Do
  not reintroduce a silent degrade-to-`ck` path: `ck` over the same tree
  previously timed out and returned nothing, which is a worse failure mode
  than a clear error.
- **The trigram (`docs_sub`) table's case folding is ASCII-only** —
  `FTS_CASE_FOLDING_ASCII_ONLY` in `lib/fts.ts` (`true`, surfaced via
  `FtsStats.caseFoldingAsciiOnly`). It folds `A-Z`<->`a-z` but not accented or
  non-Latin letters (verified: an indexed `ÄBC` matches `Äbc` but not `äbc`).
  Do not describe the FTS literal tier as having "zero recall loss" or full
  parity with ripgrep's Unicode-aware `-i` — it doesn't, by design.
- **KNOWN GAP (worth checking before relying on it): `search-text.ts` calls
  `ftsPresent(root)` for the planner's `ftsAvailable` input, not
  `ftsUsable(root)`.** `lib/query-plan.ts`'s own doc comment says callers
  MUST pass `ftsUsable()` semantics (index present AND complete), not mere
  presence, because escalation only fires on zero hits — a present-but-partial
  index would otherwise be trusted as authoritative and silently return a
  truncated result set instead of falling back to `rg`. If you're touching
  backend selection in `search-text.ts`, wire this to `ftsUsable()` and add a
  regression test asserting a `--budget-ms`-partial index does not get chosen
  as authoritative. Similarly, `search-text.ts`'s `makeRgRunner` currently
  passes `fixedString: args.fixed_string` (the raw user arg) to `runRg`, not
  `plan.treatAsFixedString` — so a `mode:"lex"` query that falls back to `rg`
  (FTS unavailable/insufficient) is not yet guaranteed to be treated as a
  fixed string there; pass `fixed_string:true` explicitly as a workaround
  until this is wired through.
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

## Architecture (search is a 3-tier planner, not a single ck path)

```
SQLite DB (read-only source of truth)
  |-> FTS5 sidecar (fts-index.sqlite; trigram substring + unicode61 BM25)
  |     reads DB directly, never the file tree -- fast tier for literal/lex
  |-> filesystem export tree (~/.local/share/opencode-sessions-explorer; by-session + by-channel)
  |     |-> ripgrep (rg)   -- exhaustive tier for real regex + fts fallback + raw channel
  |     `-> ck (.ck/, BM25 + embeddings; optional) -- sem/hybrid ONLY
  `-> enriched response (re-fetches session/part metadata from SQLite per hit)
```

`src/lib/query-plan.ts` (pure, unit-tested, no I/O) picks the backend per query:
`lex` mode is ALWAYS literal/text, never regex, regardless of metacharacters
(the fix for `v1.2.3`/`C++`/`*` under `lex` no longer being silently
reinterpreted as regexes); a literal query needs a usable 3+ character
contiguous run (`hasUsableTrigram()`) before `fts` is even a candidate — below
that floor it routes straight to `rg` (`fts` would otherwise degrade to an
unbounded content scan; measured 12.2s for a 2-char query). Given a usable
trigram run, literal + FTS index covers the requested channels -> `fts`
(fallback `["rg"]` on zero hits); otherwise -> `rg`. A real regex -> always
`rg`. `sem`/`hybrid` -> `ck` always. `ck` is NEVER a fallback for literal/regex
— `rg` and `ck` read the same file tree, so escalating to `ck` after a
zero-hit `rg` pass adds latency with no additional recall. When `rg` is
required as the primary backend and unavailable, `planSearch()` throws
`RG_NOT_FOUND` (a `SessionsError`) instead of falling back to `ck` — see the
RG_NOT_FOUND gotcha below. `search-text` shells out to `rg` and, for
`sem`/`hybrid` only, the optional **`ck` CLI**; `grep-session` shells out to
`rg` only and no longer depends on `ck` at all. If `ck` is absent, only
`sem`/`hybrid` `search-text` calls return `CK_NOT_FOUND` — every other search
path works without it. The export tree is materialized by
`bin/bulk-export.ts`; the FTS sidecar is materialized by `bin/fts-build.ts`.
`search-text` delta-syncs whichever backend it is about to run: the `fts`
backend syncs only the sidecar (straight from SQLite, skipping the file tree
entirely), while `rg`/`ck` sync the file-tree export.

## Adding or editing a tool

- One tool per file in `src/tools/`, exported as a **named const** (not default).
  Register it in `src/tools/index.ts` under the `opencode-sessions-explorer-<name>` key
  **and** the re-export block.
- Wrap the body in `runWithEnvelope("<fn_name>", capKb, async (ctx) => { … })`
  (`lib/envelope.js`). This builds the `{ ok, data, meta, warnings }` envelope, runs
  schema-drift detection, and sizes the payload against `capKb`.
- Raise recoverable errors via `fail(code, msg, hint)` or
  `throw new SessionsError(code, msg, hint)` using a code from `lib/errors.ts`
  (`NOT_FOUND`, `BAD_ARGS`, `CK_NOT_FOUND`, `RG_NOT_FOUND`, `RG_FAILED`, …). Do not
  invent ad-hoc error shapes.
- Query the DB through `stmt(sql).all/get(...)` (`lib/db.js`) — cached prepared
  statements; use `json_extract(...)` for the JSON `data` columns on `message`/`part`.
- **List-shaped results must be wrapped in `table(records, { dict: [...] })`**
  (`lib/table.ts`) — lossless columnar + interning format. Reference decoder is
  `decodeTable()`.
- Tool `description`s are long natural-language strings containing `Answers: "..."`
  example phrasings; that text is how the LLM routes to the tool. Match the existing style.

## Env overrides (useful for tests / non-default paths)

`OPENCODE_SESSIONS_EXPLORER_DB`, `OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`,
`OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR`, `OPENCODE_SESSIONS_EXPLORER_CK_BIN`,
`OPENCODE_SESSIONS_EXPLORER_RG_BIN`, `OPENCODE_SESSIONS_EXPLORER_FTS_DB`,
`OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS`,
`OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS`.
`get-part` dereference is path-guarded to the tool-output whitelist (`lib/path-guard.ts`);
search snippets redact secrets by default (pass `redact:false` for local forensics only).
