/**
 * Schema-drift detection (V2 schema). Runs once per process and caches.
 *
 * Canonical tables (opencode ≥ v2.1): `session_v2` (all sessions) and
 * `session_message` (all messages, parts INLINE in `data.content[]`). The
 * legacy `session`/`message`/`part` tables are FROZEN post-migration and are
 * deliberately NOT probed — drift is judged against the live V2 tables only.
 *
 * Migration head: the V2 `migration` table (id + time_completed), falling
 * back to the legacy `__drizzle_migrations` journal when absent. Reported
 * through the same `migrations_head` envelope field as before.
 */
import { db } from "./db.js"
import { SessionsError } from "./errors.js"

export type SchemaState = {
  migrations_head: string | null
  table_counts: Record<string, number>
  json1_ok: boolean
  busy_timeout_ms: number
  drift_warnings: string[]
  hard_drift: string[] // non-empty → throw
  cached_at: number
}

const REQUIRED = {
  session_v2: [
    "id", "project_id", "workspace_id", "parent_id", "slug", "directory", "path", "title",
    "version", "share_url", "cost", "tokens_input", "tokens_output", "tokens_reasoning",
    "tokens_cache_read", "tokens_cache_write", "agent", "model",
    "time_created", "time_updated", "time_compacting", "time_archived", "time_suspended",
  ],
  session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
}

let _state: SchemaState | null = null
const SCHEMA_TTL_MS = 5 * 60_000

export function getSchemaState(): SchemaState {
  if (_state && Date.now() - _state.cached_at < SCHEMA_TTL_MS) return _state

  const warnings: string[] = []
  const hard: string[] = []

  // migration head — V2 `migration` table first, legacy drizzle journal fallback
  let migrations_head: string | null = null
  try {
    const row = db().query("SELECT id AS name FROM migration ORDER BY time_completed DESC LIMIT 1").get() as { name?: string } | null
    migrations_head = row?.name ?? null
    if (!migrations_head) warnings.push("migration table empty")
  } catch {
    try {
      const row = db().query("SELECT name FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get() as { name?: string } | null
      migrations_head = row?.name ?? null
      if (!migrations_head) warnings.push("__drizzle_migrations empty")
    } catch (e) {
      warnings.push(`migration tables unreadable: ${(e as Error).message}`)
    }
  }

  // required tables
  const tables = db().query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  const tableSet = new Set(tables.map((t) => t.name))
  for (const t of Object.keys(REQUIRED)) {
    if (!tableSet.has(t)) hard.push(`missing table: ${t}`)
  }

  // required columns
  for (const [tbl, cols] of Object.entries(REQUIRED)) {
    if (!tableSet.has(tbl)) continue
    const rows = db().query(`PRAGMA table_info(${tbl})`).all() as { name: string }[]
    const colSet = new Set(rows.map((r) => r.name))
    for (const c of cols) {
      if (!colSet.has(c)) hard.push(`${tbl}.${c} missing`)
    }
  }

  // json1
  let json1_ok = false
  try {
    const r = db().query("SELECT json_extract('{\"a\":1}','$.a') AS v").get() as { v?: number } | null
    json1_ok = r?.v === 1
    if (!json1_ok) hard.push("json1 extension unavailable")
  } catch (e) {
    hard.push(`json1 unavailable: ${(e as Error).message}`)
  }

  // busy_timeout — SQLite returns the value in a column named `timeout` (not `busy_timeout`)
  const bt = db().query("PRAGMA busy_timeout").get() as { timeout?: number } | null
  const busy_timeout_ms = Number(bt?.timeout ?? 0)
  if (busy_timeout_ms < 5000) warnings.push(`busy_timeout=${busy_timeout_ms} <5000`)

  // table counts
  const counts: Record<string, number> = {}
  for (const t of Object.keys(REQUIRED)) {
    if (!tableSet.has(t)) continue
    const r = db().query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }
    counts[t] = Number(r.n)
  }

  _state = {
    migrations_head,
    table_counts: counts,
    json1_ok,
    busy_timeout_ms,
    drift_warnings: warnings,
    hard_drift: hard,
    cached_at: Date.now(),
  }
  return _state
}

/** Throw if hard drift detected. Soft drift is silent (callers may surface warnings via getSchemaState().drift_warnings). */
export function assertSchemaOk(): void {
  const s = getSchemaState()
  if (s.hard_drift.length > 0) {
    throw new SessionsError(
      "SCHEMA_DRIFT",
      `opencode-sessions-explorer: schema drift detected: ${s.hard_drift.join("; ")}`,
      "OpenCode may have been upgraded; the tool's hard-required V2 schema is broken. Run db_stats for details.",
    )
  }
}

/** Reset for tests. */
export function _resetSchemaForTest(): void {
  _state = null
}
