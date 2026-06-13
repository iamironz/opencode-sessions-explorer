/**
 * Schema-drift detection. Runs RQ-02..06 + RQ-10 once per process and caches.
 *
 * Hard-required tables/columns: drift here causes SCHEMA_DRIFT errors.
 * Defensively-read fields: drift here is logged in `drift_warnings` but does
 * not block a function.
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
  session: ["id", "project_id", "parent_id", "directory", "title", "time_created", "time_updated", "time_archived", "agent", "model", "cost", "tokens_input", "tokens_output", "tokens_reasoning"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
}

let _state: SchemaState | null = null
const SCHEMA_TTL_MS = 5 * 60_000

export function getSchemaState(): SchemaState {
  if (_state && Date.now() - _state.cached_at < SCHEMA_TTL_MS) return _state

  const warnings: string[] = []
  const hard: string[] = []

  // RQ-02 — schema head
  let migrations_head: string | null = null
  try {
    const row = db().query("SELECT name FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get() as { name?: string } | null
    migrations_head = row?.name ?? null
    if (!migrations_head) warnings.push("__drizzle_migrations empty")
  } catch (e) {
    warnings.push(`__drizzle_migrations unreadable: ${(e as Error).message}`)
  }

  // RQ-03 — required tables
  const tables = db().query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  const tableSet = new Set(tables.map((t) => t.name))
  for (const t of ["session", "message", "part"]) {
    if (!tableSet.has(t)) hard.push(`missing table: ${t}`)
  }

  // RQ-04..06 — required columns
  for (const [tbl, cols] of Object.entries(REQUIRED)) {
    if (!tableSet.has(tbl)) continue
    const rows = db().query(`PRAGMA table_info(${tbl})`).all() as { name: string }[]
    const colSet = new Set(rows.map((r) => r.name))
    for (const c of cols) {
      if (!colSet.has(c)) hard.push(`${tbl}.${c} missing`)
    }
  }

  // RQ-07 — json1
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

  // table counts (cheap with sqlite_stat1; but we just count for clarity)
  const counts: Record<string, number> = {}
  for (const t of ["session", "message", "part"]) {
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
      "OpenCode may have been upgraded; the tool's hard-required schema is broken. Run db_stats for details.",
    )
  }
}

/** Reset for tests. */
export function _resetSchemaForTest(): void {
  _state = null
}
