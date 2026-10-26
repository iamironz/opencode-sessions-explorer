# Development Guide

## Purpose

Define the local contributor workflow, quality gates, and project-specific
gotchas for `opencode-sessions-explorer`.

## Prerequisites

- [Bun](https://bun.sh) >= 1.4 for working on the checkout (`bun.lock` uses lockfile
  v2; the pinned version is `packageManager` in `package.json`, which CI also reads).
  OpenCode ships Bun; install it standalone only if you work on the checkout or run
  the bundled CLIs directly. The runtime is Bun, not Node — the plugin
  uses `bun:sqlite`, which should include SQLite `json1`; `check-deps` / `db-stats`
  verify it.
- An OpenCode **V2** plugin host (`@opencode/plugin >= 2.1`, e.g. opencode v2.1.3).
  `@opencode/plugin` is a typecheck-only dev dependency; the host supplies the
  runtime. The V1 API (`@opencode-ai/plugin`) is no longer supported.
- [`ck`](https://github.com/BeaconBay/ck) >= 0.7 — required only when working on
  `search-text` / `grep-session`; the other 16 tools work without it.
- A populated OpenCode V2 SQLite DB at `~/.local/share/opencode/opencode.db` —
  required only for live testing (`OPENCODE_SESSIONS_EXPLORER_LIVE=1`).

## Local Setup

```bash
bun install --frozen-lockfile
```

Load the plugin into a running OpenCode while iterating by pointing the config at
your local checkout directory (the V2 host loads its `index.ts`, which re-exports
the `Plugin.define` default from `src/plugin.ts`). See
[Install: From Source (Dev)](../install.md#from-source-dev); that page is the
authoritative source-dev registration flow, including the full-restart requirement.

## Local Dev Loop

```bash
bun run typecheck   # tsc --noEmit (strict mode)
bun test            # hermetic by default
bun run build       # bundle to dist/
```

For changes that affect tool output, also run the end-to-end verifier, which
compares each tool against ground-truth SQL over `session_v2` / `session_message`.
It is hermetic by default (synthetic fixture DB); prefix it with
`OPENCODE_SESSIONS_EXPLORER_LIVE=1` to verify against your real database:

```bash
bun tests/verify-end-to-end.ts
OPENCODE_SESSIONS_EXPLORER_LIVE=1 bun tests/verify-end-to-end.ts
```

To check the V2 plugin wiring (directory entry `index.ts` → `Plugin.define` →
`setup` → `ctx.tool.transform` registering all 18 tools) without starting
OpenCode:

```bash
bun tests/smoke-plugin-load.ts
```

To guard the LLM-facing tool surface (exactly the 18 tool names; no description,
input enum, or property description advertising part types/channels the V2
adapter never produces — `file`, `patch`, `subtask`, `step-start`, `step-finish`,
`patch-summary` — or legacy `prt_` ids):

```bash
bun tests/check-descriptions.ts
```

Check install health any time:

```bash
bun src/bin/check-deps.ts
```

For source-dev first-run validation, use the local checkout CLIs from
[Install](../install.md#validate) (`bun src/bin/check-deps.ts`,
`bun src/bin/bulk-export.ts`, or `bun dist/bin/check-deps.js` after a build) rather
than `bunx`, which exercises the published npm package.

## Architecture (pointer)

The plugin is a 4-layer pipeline:

```
SQLite DB (read-only source of truth)
  -> filesystem export tree (~/.local/share/opencode-sessions-explorer; by-session + by-channel)
  -> ck regex scan (stateless; optional)
  -> enriched response (re-fetches session/part metadata from SQLite per hit)
```

See the [Architecture Reference](../reference/architecture.md) for the full layer
diagram and read-only / single-writer invariants, and the
[Export And Maintenance Guide](../guides/export-and-maintenance.md) for export
operations. `AGENTS.md` holds the authoritative per-tool contract.

## Environment Overrides

All paths are env-overridable, which is the easiest way to point tests or a dev
session at non-default locations:

| Env var | Purpose |
| --- | --- |
| `OPENCODE_SESSIONS_EXPLORER_DB` | Path to the OpenCode SQLite DB |
| `OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT` | Where searchable session content is materialized |
| `OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR` | Whitelist root for `get-part` dereference |
| `OPENCODE_SESSIONS_EXPLORER_CK_BIN` | Override the `ck` binary location |

## Tests: Hermetic vs Live

- `bun test` is **hermetic by default** — the `tests/setup.ts` preload builds a
  synthetic V2 fixture DB (`tests/fixtures/build-fixture.ts`: `session_v2`,
  `session_message`, `migration`, including an imported pre-V2-shaped session) and
  does not need your real history. This is what CI runs.
- To exercise the suite against your real `~/.local/share/opencode/opencode.db`,
  opt in:

  ```bash
  OPENCODE_SESSIONS_EXPLORER_LIVE=1 bun test
  # or
  bun run test:live
  ```

  Live runs read real `ses_`/`msg_` IDs, `msg_…#N` part IDs, and minimum counts
  from `tests/fixtures.json` (recorded on the author's machine) against your
  OpenCode database; failures there reflect your own data, not necessarily a
  regression. LIVE grep/search tests also need a populated export tree
  (`bun src/bin/bulk-export.ts --reset`) first.

## The `.js`-Import Gotcha (do not "fix" it)

Inside `src/`, sibling imports use a **`.js`** extension even though the files are
`.ts`:

```ts
import { stmt } from "../lib/db.js"; // the file is db.ts — this is correct
```

This is required by `tsc` (`moduleResolution: bundler`) and `bun build`. Rewriting
these to `.ts` will break typecheck and the build. Files under `tests/` import
`src` with `.ts`; that is fine, because Bun runs them unbuilt.

## Adding or Editing a Tool

- One tool per file in `src/tools/`, exported as a **named const** (not default).
- Register it in `src/tools/index.ts` under the
  `opencode-sessions-explorer-<name>` key and the re-export block.
- Declare it with `defineTool({ name, description, args, execute })`
  (`src/lib/tool-v2.ts`). `args` is plain JSON Schema (no zod); `defineTool`
  applies defaults (`src/lib/jsonschema.ts`) and wraps the envelope string into the
  V2 `{ content }` result. `src/plugin.ts` registers every tool via
  `ctx.tool.transform(editor => editor.add(tool))`; keep that hook cheap.
- Wrap the body in `runWithEnvelope("<fn_name>", capKb, async (ctx) => { … })`.
- Raise recoverable errors via `fail(code, msg, hint)` using a code from
  `src/lib/errors.ts`; do not invent ad-hoc error shapes.
- Query `session_v2` / `session_message`, never the frozen V1 `session` /
  `message` / `part` tables. Read inline parts with
  `json_each(sm.data,'$.content')` + `json_extract(...)`, or enumerate them with
  `messageToParts()` from `src/lib/v2-parts.ts` (part ids `<messageId>#<index>`).
  Never alias a `json_extract` expression as `key` in `GROUP BY key` (SQLite 3.53
  mis-groups it).
- Wrap list-shaped results in `table(records, { dict: [...] })` (lossless
  columnar + interning).

See `AGENTS.md` for the authoritative, fully detailed version of this contract.

## Change Checklist

- Run `bun run typecheck`, `bun test`, and `bun run build` locally.
- For tool-output changes, run `bun tests/verify-end-to-end.ts`.
- Update [`README.md`](../../README.md) for any user-facing change.
- Add a note under `## [Unreleased]` in [`CHANGELOG.md`](../../CHANGELOG.md).
- Keep commit scope focused.

## Related Docs

- [Docs Writing Standard](docs-writing.md)
- [Install Guide](../install.md)
- [Release Guide](release.md)
- [Triage Guide](triage.md)
