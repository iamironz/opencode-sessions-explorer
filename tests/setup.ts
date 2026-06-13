/**
 * Bun test preload (configured via bunfig.toml [test].preload).
 *
 * Runs ONCE, before any test file / src module is imported. In the default
 * (hermetic) mode it points every OPENCODE_SESSIONS_EXPLORER_* path at a fresh
 * temp dir, materializes a small synthetic opencode.db fixture, and resets the
 * db/schema caches so the tools read the fixture instead of the author's real
 * ~/.local/share/opencode/opencode.db.
 *
 * Set OPENCODE_SESSIONS_EXPLORER_LIVE=1 to opt OUT and run against the live DB
 * (the legacy behavior — see `bun run test:live`).
 *
 * IMPORTANT: env vars are assigned in the module body BEFORE buildFixtureDb() is
 * called, so path-guard.ts (which captures OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR
 * at import time, later) and db.ts (lazy) both observe the fixture paths.
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildFixtureDb, FIXTURES } from "./fixtures/build-fixture.ts"
import { _resetForTest } from "../src/lib/db.ts"
import { _resetSchemaForTest } from "../src/lib/schema.ts"

if (!process.env.OPENCODE_SESSIONS_EXPLORER_LIVE) {
  const base = mkdtempSync(join(tmpdir(), "ose-fixture-"))
  const dbPath = join(base, "opencode.db")
  // Export root must contain the literal "opencode-sessions-explorer" (rehearsal CS-P).
  const exportRoot = join(base, "opencode-sessions-explorer-export")
  const toolOutputDir = join(base, "tool-output")

  process.env.OPENCODE_SESSIONS_EXPLORER_DB = dbPath
  process.env.OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT = exportRoot
  process.env.OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR = toolOutputDir
  // Point ck at a non-existent path; combined with skipIf-gating of ck-dependent
  // probes, this keeps the hermetic suite from shelling out to the real ck index.
  process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = join(base, "no-such-ck-binary")

  mkdirSync(exportRoot, { recursive: true })
  mkdirSync(toolOutputDir, { recursive: true })

  buildFixtureDb(dbPath)

  // current_session (CS-P) checks this session's export dir exists.
  mkdirSync(join(exportRoot, "by-session", FIXTURES.sessions.active), { recursive: true })

  // Drop any caches built during import so the tools re-read the fixture.
  _resetForTest()
  _resetSchemaForTest()

  // Proof line: the resolved DB must be the temp fixture, not ~/.local/share.
  // eslint-disable-next-line no-console
  console.log(`[hermetic-fixture] OPENCODE_SESSIONS_EXPLORER_DB=${dbPath}`)
}
