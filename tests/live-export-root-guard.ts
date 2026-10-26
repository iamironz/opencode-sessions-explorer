/**
 * Guard for LIVE verification runs: never let a LIVE run mutate the operator's
 * real export tree (`~/.local/share/opencode-sessions-explorer/.last_sync`).
 * Without an explicit OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT, a LIVE run used to
 * persist `insert_cursor="\uffff"` and rewind `session_cursor` in the real state.
 * Import this module FIRST (before ./setup.ts and any src module).
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (process.env.OPENCODE_SESSIONS_EXPLORER_LIVE && !process.env.OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT) {
  const root = mkdtempSync(join(tmpdir(), "ose-verify-export-"))
  process.env.OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT = root
  console.log(`[verify] LIVE mode: throwaway export root ${root} (set OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT to override)`)
}
