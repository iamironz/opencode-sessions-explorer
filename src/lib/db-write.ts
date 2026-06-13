/**
 * Isolated read-WRITE access to `opencode.db` — the ONLY write surface in this plugin.
 *
 * Every other code path opens the DB read-only (`lib/db.js`, `readonly:true` +
 * `PRAGMA query_only=1`). This module deliberately opens a SEPARATE, short-lived
 * read-write handle so the shared read path keeps its read-only guarantee intact.
 *
 * Scope is intentionally tiny: clearing `session.time_archived` (unarchive) and,
 * paired with it, refreshing `session.time_updated`. OpenCode has NO external
 * unarchive path — the HTTP `UpdatePayload` types `time.archived` as a finite
 * number and the handler ignores `undefined`, so `null`/clear can't be sent over
 * the wire (verified against v1.15.12 source). A direct DB write is the only way.
 *
 * Why we also bump `time_updated`: OpenCode's app/server load the session list
 * ordered by `time_updated DESC` with a default `LIMIT 100` *per directory*. A
 * session archived long ago keeps an old `time_updated`, so merely clearing
 * `time_archived` leaves it buried far below that window — the app never loads it
 * and prompting fails with "Unable to retrieve session". Refreshing
 * `time_updated` resurfaces the restored session at the top, where the app loads
 * it (this is also the intuitive meaning of "restore"). See README → Writes.
 *
 * Concurrency: the live OpenCode process may hold the DB open in WAL mode. WAL
 * allows many readers + one writer across processes; `busy_timeout=5000` covers
 * transient lock collisions. We open → write → close per call to keep the write
 * window (and any writer lock) as short as possible.
 *
 * Caveat (surfaced to callers): an external write emits no `session.updated`
 * event, so an already-open OpenCode window won't update live — but because we
 * refresh `time_updated`, a reload/restart re-loads the session correctly.
 */
import { Database } from "bun:sqlite"
import { locateDb } from "./db.js"
import { SessionsError } from "./errors.js"

export type UnarchiveResult = {
  /** True if the row had been archived (time_archived was set) before this call. */
  wasArchived: boolean
  /** Previous time_archived value (epoch-ms), or null if it was already active. */
  archivedBefore: number | null
  /** Previous time_updated value (epoch-ms). */
  updatedBefore: number | null
  /** New time_updated value written (epoch-ms). */
  updatedAfter: number
}

/** Open a short-lived read-write handle. Throws WRITE_FAILED on failure. */
function openWrite(): Database {
  try {
    // bun:sqlite requires an explicit readwrite flag; `{ readonly: false }` alone
    // yields SQLITE_MISUSE. `create: false` so we never fabricate an empty DB.
    const wdb = new Database(locateDb(), { readwrite: true, create: false })
    wdb.exec("PRAGMA busy_timeout = 5000;")
    return wdb
  } catch (e) {
    throw new SessionsError("WRITE_FAILED", `could not open DB for writing: ${(e as Error).message}`)
  }
}

/**
 * Restore a session to a fully usable state: clear `time_archived` AND refresh
 * `time_updated` so the session resurfaces at the top of OpenCode's
 * recency-ordered list (where the app loads it).
 *
 * This ALWAYS writes both columns when the session exists — including when the
 * session is already active. That is deliberate: a session can be active yet
 * buried below the app's default `LIMIT 100` window (e.g. unarchived by an older
 * build that didn't refresh `time_updated`), which leaves it unloadable and
 * unpromptable. "Restore" guarantees usability, so it is not a no-op on
 * already-active rows; it is idempotent in effect (active + at the top).
 *
 * @throws SessionsError("NOT_FOUND") if the session id does not exist
 * @throws SessionsError("WRITE_FAILED") on any underlying write failure
 */
export function unarchiveSessionRow(sessionID: string, now: number = Date.now()): UnarchiveResult {
  const wdb = openWrite()
  try {
    const row = wdb
      .query("SELECT time_archived, time_updated FROM session WHERE id = ?")
      .get(sessionID) as { time_archived: number | null; time_updated: number | null } | null
    if (!row) throw new SessionsError("NOT_FOUND", `session not found: ${sessionID}`)

    const archivedBefore = row.time_archived ?? null
    const updatedBefore = row.time_updated ?? null
    // Always clear archived + resurface, even if already active (it may be buried).
    wdb.query("UPDATE session SET time_archived = NULL, time_updated = ? WHERE id = ?").run(now, sessionID)
    return { wasArchived: archivedBefore !== null, archivedBefore, updatedBefore, updatedAfter: now }
  } catch (e) {
    if (e instanceof SessionsError) throw e
    throw new SessionsError("WRITE_FAILED", `failed to unarchive session ${sessionID}: ${(e as Error).message}`)
  } finally {
    try {
      wdb.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Low-level: set/clear `session.time_archived` only (no `time_updated` change).
 * Kept for completeness/symmetry (e.g. archiving); the unarchive tool uses
 * `unarchiveSessionRow` which also resurfaces the session.
 *
 * @throws SessionsError("NOT_FOUND") if the session id does not exist
 * @throws SessionsError("WRITE_FAILED") on any underlying write failure
 */
export function setSessionArchived(sessionID: string, time: number | null): { changed: boolean; before: number | null } {
  const wdb = openWrite()
  try {
    const row = wdb
      .query("SELECT time_archived FROM session WHERE id = ?")
      .get(sessionID) as { time_archived: number | null } | null
    if (!row) throw new SessionsError("NOT_FOUND", `session not found: ${sessionID}`)
    const before = row.time_archived ?? null
    if (before === time) return { changed: false, before }
    wdb.query("UPDATE session SET time_archived = ? WHERE id = ?").run(time, sessionID)
    return { changed: true, before }
  } catch (e) {
    if (e instanceof SessionsError) throw e
    throw new SessionsError("WRITE_FAILED", `failed to update session ${sessionID}: ${(e as Error).message}`)
  } finally {
    try {
      wdb.close()
    } catch {
      /* ignore */
    }
  }
}
