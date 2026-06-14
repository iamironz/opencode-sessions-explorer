import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type ExportCursor = { ts: number; id: string }

export type DirtySessionHint = {
  time_updated: number
  part_cursor: string | null
}

export type FailedPartState = {
  id: string
  attempts: number
  first_failed_at: number
  last_failed_at: number
  last_error: string
}

export type ReconcileWatermark = {
  part_id: string | null
  session_id: string | null
  at: number
} | null

export type SyncState = {
  schema: "v3"
  insert_cursor: { id: string }
  session_cursor: ExportCursor | null
  session_dirty_hints: Record<string, DirtySessionHint>
  reconcile_watermark: ReconcileWatermark
  failed_parts: Record<string, FailedPartState>
  dead_letters: Record<string, FailedPartState>
  last_reconcile_at: number | null
  legacy_cursor: ExportCursor | null
  migrated_from?: string
}

const CURSOR_SCHEMA = "v3"
const LAST_SYNC_FILE = ".last_sync"

export function freshSyncState(migratedFrom?: string, legacyCursor: ExportCursor | null = null): SyncState {
  return {
    schema: CURSOR_SCHEMA,
    insert_cursor: { id: "" },
    session_cursor: null,
    session_dirty_hints: {},
    reconcile_watermark: null,
    failed_parts: {},
    dead_letters: {},
    last_reconcile_at: null,
    legacy_cursor: legacyCursor,
    migrated_from: migratedFrom,
  }
}

export function getSyncState(root: string): SyncState {
  const p = join(root, LAST_SYNC_FILE)
  if (!existsSync(p)) return freshSyncState()
  try {
    return parseSyncState(readFileSync(p, "utf8"))
  } catch {
    return freshSyncState("unreadable")
  }
}

export function setSyncState(state: SyncState, root: string): void {
  const p = join(root, LAST_SYNC_FILE)
  const tmp = p + ".tmp"
  writeFileSync(tmp, `${CURSOR_SCHEMA} ${JSON.stringify(normalizeSyncState(state))}`)
  renameSync(tmp, p)
}

export function getLastSync(root: string): ExportCursor | null {
  const p = join(root, LAST_SYNC_FILE)
  if (!existsSync(p)) return null
  const state = getSyncState(root)
  if (state.legacy_cursor) return state.legacy_cursor
  if (!state.insert_cursor.id) return null
  return { ts: 0, id: state.insert_cursor.id }
}

export function setLastSync(cursor: ExportCursor, root: string): void {
  const state = freshSyncState(undefined, cursor)
  state.insert_cursor.id = cursor.id
  setSyncState(state, root)
}

export function parseSyncState(rawInput: string): SyncState {
  const raw = rawInput.trim()
  if (!raw) return freshSyncState("empty")
  if (raw.startsWith(`${CURSOR_SCHEMA} `)) {
    const parsed = JSON.parse(raw.slice(CURSOR_SCHEMA.length + 1)) as unknown
    return normalizeSyncState(parsed)
  }
  if (raw.startsWith("{")) {
    return normalizeSyncState(JSON.parse(raw) as unknown)
  }
  if (raw.startsWith("v2 ")) {
    return freshSyncState("v2", parseLegacyCursor(raw.slice(3)))
  }
  const legacy = parseLegacyCursor(raw)
  return freshSyncState(legacy ? "v1" : "unknown", legacy)
}

function normalizeSyncState(input: unknown): SyncState {
  if (!isRecord(input)) return freshSyncState("invalid")
  const state = freshSyncState(asString(input.migrated_from) ?? undefined, cursorOrNull(input.legacy_cursor))
  const insert = isRecord(input.insert_cursor) ? input.insert_cursor : null
  state.insert_cursor.id = asString(insert?.id) ?? ""
  state.session_cursor = cursorOrNull(input.session_cursor)
  state.session_dirty_hints = dirtyHints(input.session_dirty_hints)
  state.reconcile_watermark = reconcileWatermark(input.reconcile_watermark)
  state.failed_parts = failedParts(input.failed_parts)
  state.dead_letters = failedParts(input.dead_letters)
  state.last_reconcile_at = finiteOrNull(input.last_reconcile_at)
  return state
}

function parseLegacyCursor(raw: string): ExportCursor | null {
  const idx = raw.indexOf(":")
  if (idx <= 0) return null
  const ts = Number(raw.slice(0, idx))
  const id = raw.slice(idx + 1)
  if (!Number.isFinite(ts) || !id) return null
  return { ts, id }
}

function cursorOrNull(value: unknown): ExportCursor | null {
  if (!isRecord(value)) return null
  const ts = finiteOrNull(value.ts)
  const id = asString(value.id)
  if (ts == null || !id) return null
  return { ts, id }
}

function dirtyHints(value: unknown): Record<string, DirtySessionHint> {
  if (!isRecord(value)) return {}
  const out: Record<string, DirtySessionHint> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!id) continue
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[id] = { time_updated: raw, part_cursor: null }
      continue
    }
    if (!isRecord(raw)) continue
    const timeUpdated = finiteOrNull(raw.time_updated)
    if (timeUpdated == null) continue
    out[id] = { time_updated: timeUpdated, part_cursor: asString(raw.part_cursor) }
  }
  return out
}

function reconcileWatermark(value: unknown): ReconcileWatermark {
  if (!isRecord(value)) return null
  const at = finiteOrNull(value.at)
  if (at == null) return null
  return {
    part_id: asString(value.part_id),
    session_id: asString(value.session_id),
    at,
  }
}

function failedParts(value: unknown): Record<string, FailedPartState> {
  if (!isRecord(value)) return {}
  const out: Record<string, FailedPartState> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!id || !isRecord(raw)) continue
    const attempts = finiteOrNull(raw.attempts)
    const firstFailedAt = finiteOrNull(raw.first_failed_at)
    const lastFailedAt = finiteOrNull(raw.last_failed_at)
    if (attempts == null || firstFailedAt == null || lastFailedAt == null) continue
    out[id] = {
      id,
      attempts,
      first_failed_at: firstFailedAt,
      last_failed_at: lastFailedAt,
      last_error: asString(raw.last_error) ?? "unknown export failure",
    }
  }
  return out
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
