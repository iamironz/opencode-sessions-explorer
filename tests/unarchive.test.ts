/**
 * unarchive_session — the plugin's only WRITE tool.
 *
 * These tests MUST NOT mutate the real opencode.db. We build a trimmed snapshot
 * of the live DB (same V2 schema for `session_v2` + `session_message`, only the
 * rows under test), point $OPENCODE_SESSIONS_EXPLORER_DB at the copy, exercise
 * the tool against a REAL archived session row, and assert the live DB is
 * untouched.
 */
import { test, describe, expect, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { rmSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTool } from "./helpers.ts"
import { _resetForTest } from "../src/lib/db.ts"
import { _resetSchemaForTest } from "../src/lib/schema.ts"
import { unarchiveSession } from "../src/tools/unarchive-session.ts"

const LIVE_DB = process.env.OPENCODE_SESSIONS_EXPLORER_DB ?? `${process.env.HOME}/.local/share/opencode/opencode.db`

let tmpDir: string
let copyPath: string
let savedEnv: string | undefined
let archivedId: string
let archivedTs: number
let activeId: string

beforeAll(() => {
  // Build an isolated TRIMMED snapshot of the live DB: same V2 schema, but only
  // `session_v2` + `session_message` and only the rows under test. (The live
  // opencode.db is ~17 GB — a full file copy is impractical under disk quota;
  // the write path under test touches only these two tables anyway. In hermetic
  // mode the source DB is the tiny synthetic fixture, so the same builder works.)
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-sessions-explorer-unarchive-"))
  copyPath = join(tmpDir, "opencode.db")

  const src = new Database(LIVE_DB, { readonly: true })
  const snap = new Database(copyPath, { create: true })
  try {
    src.exec("PRAGMA busy_timeout=5000")
    snap.exec("PRAGMA journal_mode = WAL;")
    snap.exec(`ATTACH DATABASE '${LIVE_DB.replace(/'/g, "''")}' AS src`)
    for (const tbl of ["session_v2", "session_message"]) {
      const ddl = src.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(tbl) as { sql: string } | null
      if (!ddl?.sql) throw new Error(`missing ${tbl} in snapshot source`)
      snap.exec(ddl.sql)
    }
    // Copy the sessions + a bounded window of their messages (identity only).
    snap.exec(`
      INSERT INTO session_v2 SELECT * FROM src.session_v2
       WHERE time_archived IS NOT NULL
          OR id IN (SELECT id FROM src.session_v2 WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 5)
    `)
    snap.exec(`
      INSERT INTO session_message
      SELECT m.* FROM src.session_message m
       WHERE m.session_id IN (SELECT id FROM main.session_v2)
         AND m.rowid <= (SELECT MIN(rowid) + 50 FROM src.session_message m2 WHERE m2.session_id = m.session_id)
    `)
    snap.exec("DETACH DATABASE src")

    const arch = snap
      .query("SELECT id, time_archived FROM session_v2 WHERE time_archived IS NOT NULL ORDER BY time_archived DESC LIMIT 1")
      .get() as { id: string; time_archived: number } | null
    const act = snap
      .query("SELECT id FROM session_v2 WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 1")
      .get() as { id: string } | null
    if (!arch) throw new Error("no archived session in snapshot — cannot test unarchive")
    if (!act) throw new Error("no active session in snapshot")
    archivedId = arch.id
    archivedTs = arch.time_archived
    activeId = act.id
  } finally {
    snap.close()
    src.close()
  }

  // Redirect the shared (read) + write paths at the copy, and drop the
  // process-wide schema-state cache so later test files re-probe the snapshot.
  savedEnv = process.env.OPENCODE_SESSIONS_EXPLORER_DB
  process.env.OPENCODE_SESSIONS_EXPLORER_DB = copyPath
  _resetForTest()
  _resetSchemaForTest()
})

afterAll(() => {
  // Restore the real DB path for any later test files + clean up. Reset both
  // the DB handle and the cached schema state so subsequent files re-probe
  // whatever DB their mode selects.
  if (savedEnv === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_DB
  else process.env.OPENCODE_SESSIONS_EXPLORER_DB = savedEnv
  _resetForTest()
  _resetSchemaForTest()
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** Read time_archived straight from a file (fresh connection each call). */
function readArchived(dbPath: string, id: string): number | null {
  const d = new Database(dbPath, { readonly: true })
  try {
    d.exec("PRAGMA busy_timeout=5000")
    const r = d.query("SELECT time_archived FROM session_v2 WHERE id = ?").get(id) as { time_archived: number | null } | null
    return r ? (r.time_archived ?? null) : null
  } finally {
    d.close()
  }
}

describe("unarchive_session", () => {
  test("UA-NF unknown session id → NOT_FOUND", async () => {
    const r = await runTool(unarchiveSession, { session_id: "ses_does_not_exist_xyz" })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe("NOT_FOUND")
  })

  test("UA-ACTIVE already-active session is still resurfaced (time_updated bumped)", async () => {
    // Bury an active session with an OLD time_updated, then restore: it must stay
    // active AND get a fresh time_updated (so it's loadable, not a silent no-op).
    const OLD = 5_000
    const w = new Database(copyPath, { readwrite: true, create: false })
    try {
      w.exec("PRAGMA busy_timeout=5000")
      w.query("UPDATE session_v2 SET time_archived = NULL, time_updated = ? WHERE id = ?").run(OLD, activeId)
    } finally {
      w.close()
    }
    const t0 = Date.now()
    const r = await runTool(unarchiveSession, { session_id: activeId })
    expect(r.ok).toBe(true)
    expect(r.data.was_archived).toBe(false)
    expect(r.data.now_active).toBe(true)
    expect(r.data.resurfaced).toBe(true)
    expect(r.data.time_updated_before).toBe(OLD)
    expect(r.data.time_updated_after).toBeGreaterThanOrEqual(t0)
    expect(readArchived(copyPath, activeId)).toBeNull()
  })

  test("UA-H real archived session is unarchived (time_archived → NULL)", async () => {
    // Precondition: genuinely archived in the copy.
    expect(readArchived(copyPath, archivedId)).toBe(archivedTs)

    const r = await runTool(unarchiveSession, { session_id: archivedId })
    expect(r.ok).toBe(true)
    expect(r.data.session_id).toBe(archivedId)
    expect(r.data.was_archived).toBe(true)
    expect(r.data.now_active).toBe(true)
    expect(r.data.archived_after).toBe(false)
    expect(r.data.time_archived_before).toBe(archivedTs)
    // Warning about needing a reload/restart must be surfaced.
    expect(r.warnings.some((w) => /reload|restart/i.test(w))).toBe(true)

    // Ground truth: the row is now active in the copy.
    expect(readArchived(copyPath, archivedId)).toBeNull()
  })

  test("UA-IDEM second restore stays active and refreshes time_updated again", async () => {
    const t0 = Date.now()
    const r = await runTool(unarchiveSession, { session_id: archivedId })
    expect(r.ok).toBe(true)
    expect(r.data.was_archived).toBe(false) // already active after UA-H
    expect(r.data.now_active).toBe(true)
    expect(r.data.time_updated_after).toBeGreaterThanOrEqual(t0)
    expect(readArchived(copyPath, archivedId)).toBeNull()
  })

  test("UA-RESURFACE unarchive refreshes time_updated so the session resurfaces", async () => {
    // Archive a fresh row with a deliberately OLD time_updated, then unarchive
    // via the tool and confirm time_updated jumps to ~now (top of recency list).
    const OLD = 1_000
    const w = new Database(copyPath, { readwrite: true, create: false })
    let target: string
    try {
      w.exec("PRAGMA busy_timeout=5000")
      const row = w
        .query("SELECT id FROM session_v2 WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 1")
        .get() as { id: string }
      target = row.id
      w.query("UPDATE session_v2 SET time_archived = ?, time_updated = ? WHERE id = ?").run(Date.now(), OLD, target)
    } finally {
      w.close()
    }

    const t0 = Date.now()
    const r = await runTool(unarchiveSession, { session_id: target })
    expect(r.ok).toBe(true)
    expect(r.data.was_archived).toBe(true)
    expect(r.data.time_updated_before).toBe(OLD)
    expect(r.data.time_updated_after).toBeGreaterThanOrEqual(t0)
    expect(readArchived(copyPath, target)).toBeNull()

    const updatedAfter = (() => {
      const d = new Database(copyPath, { readonly: true })
      try {
        return (d.query("SELECT time_updated FROM session_v2 WHERE id = ?").get(target) as { time_updated: number }).time_updated
      } finally {
        d.close()
      }
    })()
    expect(updatedAfter).toBeGreaterThanOrEqual(t0)
    expect(updatedAfter).toBeGreaterThan(OLD)
  })

  test("UA-ISOLATION the real live DB was never modified", () => {
    // The same session we unarchived in the copy must still be archived live.
    expect(readArchived(LIVE_DB, archivedId)).toBe(archivedTs)
  })
})
