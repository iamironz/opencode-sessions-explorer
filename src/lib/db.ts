/**
 * Shared read-only bun:sqlite handle for `~/.local/share/opencode/opencode.db`.
 *
 * - Opens ONCE per process, readonly + PRAGMA query_only=1 belt-and-braces.
 * - Locates the DB via $OPENCODE_SESSIONS_EXPLORER_DB env override, else platform default.
 * - Caches prepared statements keyed by SQL string.
 *
 * Concurrency: the source DB is in WAL mode and being written by the live
 * OpenCode process. Multiple readers + a writer is safe; busy_timeout=5000
 * gives us 5 s of retry on the rare lock collision.
 */
import { Database, type Statement } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { SessionsError } from "./errors.js"

const ENV_VAR = "OPENCODE_SESSIONS_EXPLORER_DB"

function platformDefault(): string | null {
  const home = homedir()
  switch (platform()) {
    case "darwin":
    case "linux": {
      const dataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share")
      return join(dataHome, "opencode", "opencode.db")
    }
    case "win32": {
      const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local")
      return join(local, "opencode", "opencode.db")
    }
    default:
      return null
  }
}

let cachedPath: string | null = null

export function locateDb(): string {
  if (cachedPath) return cachedPath
  const env = process.env[ENV_VAR]
  if (env) {
    if (!existsSync(env))
      throw new SessionsError("DB_NOT_FOUND", `opencode-sessions-explorer: $${ENV_VAR} points to missing file: ${env}`)
    cachedPath = env
    return env
  }
  const def = platformDefault()
  if (!def || !existsSync(def)) {
    throw new SessionsError(
      "DB_NOT_FOUND",
      `opencode-sessions-explorer: DB not found. Set $${ENV_VAR} or install OpenCode. Tried: ${def ?? `(no default for ${platform()})`}`,
    )
  }
  cachedPath = def
  return def
}

let _db: Database | null = null
const _stmts = new Map<string, Statement>()
const STMT_CACHE_LIMIT = 256

export function db(): Database {
  if (_db) return _db
  const path = locateDb()
  _db = new Database(path, { readonly: true, create: false, safeIntegers: false })
  // belt-and-braces — any accidental write will throw
  _db.exec("PRAGMA query_only = 1;")
  _db.exec("PRAGMA busy_timeout = 5000;")
  _db.exec("PRAGMA temp_store = MEMORY;")
  _db.exec("PRAGMA cache_size = -32000;") // 32 MB page cache
  return _db
}

export function stmt(sql: string): Statement {
  let s = _stmts.get(sql)
  if (!s) {
    if (_stmts.size >= STMT_CACHE_LIMIT) {
      // simple eviction — drop the oldest entry
      const oldest = _stmts.keys().next().value
      if (oldest) _stmts.delete(oldest)
    }
    s = db().query(sql)
    _stmts.set(sql, s)
  }
  return s
}

export function closeDb(): void {
  for (const s of _stmts.values()) {
    try { s.finalize() } catch { /* ignore */ }
  }
  _stmts.clear()
  if (_db) {
    try { _db.close() } catch { /* ignore */ }
    _db = null
  }
}

/** For probes/tests: reset internal caches so a re-locate happens. */
export function _resetForTest(): void {
  closeDb()
  cachedPath = null
}
