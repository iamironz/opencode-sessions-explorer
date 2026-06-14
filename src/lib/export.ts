/**
 * Filesystem export of searchable session content, for `ck` indexing.
 *
 * Layout:
 *   <root>/by-session/<ses_id>/
 *     meta.json
 *     <NNNN>-<prt_id>.txt   (one per searchable part)
 *   <root>/by-channel/<channel>/by-session/<ses_id>/
 *     <NNNN>-<prt_id>.txt   (derived curated search views)
 *   <root>/.last_sync       (v3 JSON sync state)
 *
 * `ck` is point-and-shoot — it walks the tree, indexes text files,
 * ignores the meta.json (per its default .ckignore which excludes JSON).
 *
 * Per-part body cap: 256 KB. Truncated with a marker pointing back at
 * get_part(prt_id).
 *
 * Atomic writes: temp file + rename. Dotfile-prefix marks in-flight.
 */
import { stmt } from "./db.js"
import { decodePart, decodeModel, type DecodedPart } from "./decode.js"
import { mkdirSync, existsSync, renameSync, writeFileSync, unlinkSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { SearchChannel } from "./channel.js"
import { CHANNELS, compactPath, normalizeError } from "./channel.js"
import { SEARCHABLE_TYPES } from "./export-constants.js"
import { acquireExportLock } from "./export-lock.js"
import { reconcileTombstones, type TombstoneProgress } from "./export-tombstones.js"
import { scheduleBackgroundReconcile } from "./export-background.js"
import {
  getLastSync as readLastSync,
  getSyncState as readSyncState,
  setLastSync as writeLastSync,
  setSyncState as writeSyncState,
  type DirtySessionHint,
  type ExportCursor,
  type FailedPartState,
  type SyncState,
} from "./export-state.js"

export { SEARCHABLE_TYPES } from "./export-constants.js"
export type { ExportCursor, SyncState } from "./export-state.js"

export const DEFAULT_EXPORT_ROOT = join(homedir(), ".local/share/opencode-sessions-explorer")
const BODY_CAP_BYTES = 256 * 1024
const SAFETY_PART_CAP_BYTES = 50 * 1024 * 1024 // skip parts larger than 50 MB raw
const CHANNEL_COMPLETE_MARKER = ".channels_v1_complete"
const INSERT_REWIND_MS = 3 * 60 * 1000
const INSERT_REWIND_MAX_ROWS = 512
const MAX_FAILED_ATTEMPTS = 5
const PART_CHANNELS: SearchChannel[] = CHANNELS.filter((c) => c !== "session-summary" && c !== "raw")

export function exportRoot(): string {
  return process.env.OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT || DEFAULT_EXPORT_ROOT
}

export function getSyncState(root = exportRoot()): SyncState {
  return readSyncState(root)
}

export function setSyncState(state: SyncState, root = exportRoot()): void {
  writeSyncState(state, root)
}

export function getLastSync(root = exportRoot()): ExportCursor | null {
  return readLastSync(root)
}

export function setLastSync(cursor: ExportCursor, root = exportRoot()): void {
  writeLastSync(cursor, root)
}

export function ensureRoot(root = exportRoot()): string {
  mkdirSync(join(root, "by-session"), { recursive: true })
  return root
}

export function channelExportComplete(root = exportRoot()): boolean {
  return existsSync(join(root, CHANNEL_COMPLETE_MARKER))
}

export function markChannelExportComplete(root = exportRoot()): void {
  const p = join(root, CHANNEL_COMPLETE_MARKER)
  const tmp = p + ".tmp"
  writeFileSync(tmp, String(Date.now()))
  renameSync(tmp, p)
}

type SessionInfo = {
  id: string
  title: string
  project_id: string
  directory: string
  agent: string | null
  model: string | null
  cost: number
  time_created: number
  time_updated: number
  time_archived: number | null
  parent_id: string | null
}

/** Cached session info lookup. */
const sessionCache = new Map<string, SessionInfo>()

function getSession(id: string): SessionInfo | null {
  const cached = sessionCache.get(id)
  if (cached) return cached
  const row = stmt(`
    SELECT id, title, project_id, directory, agent, model, cost,
           time_created, time_updated, time_archived, parent_id
      FROM session WHERE id = ?`).get(id) as any
  if (!row) return null
  sessionCache.set(id, row)
  return row
}

/** Build the structured-header + body string for one part. */
export function buildPartFile(
  partId: string,
  sessionId: string,
  messageId: string,
  data: string,
  archived: boolean,
): { content: string; type: string } | null {
  let decoded: DecodedPart
  try { decoded = decodePart(data) } catch { return null }
  if (!(SEARCHABLE_TYPES as readonly string[]).includes(decoded.type)) return null

  const lines: string[] = []
  lines.push(`PART_ID: ${partId}`)
  lines.push(`SESSION_ID: ${sessionId}`)
  lines.push(`MESSAGE_ID: ${messageId}`)
  lines.push(`TYPE: ${decoded.type}`)
  lines.push(`ARCHIVED: ${archived}`)

  let body = ""
  switch (decoded.type) {
    case "text":
      body = decoded.text
      break
    case "reasoning":
      body = decoded.text
      break
    case "tool": {
      lines.push(`TOOL: ${decoded.tool}`)
      lines.push(`STATUS: ${decoded.status}`)
      if (decoded.start != null && decoded.end != null) lines.push(`TIME: ${decoded.start} - ${decoded.end}`)
      const parts: string[] = []
      try { parts.push("INPUT: " + JSON.stringify(decoded.input)) } catch { parts.push("INPUT: <unserializable>") }
      if (decoded.output) parts.push("OUTPUT:\n" + decoded.output)
      if (decoded.error) parts.push("ERROR:\n" + decoded.error)
      body = parts.join("\n")
      break
    }
    case "file":
      lines.push(`MIME: ${decoded.mime ?? "?"}`)
      body = `FILENAME: ${decoded.filename ?? "?"}\nURL: ${decoded.url ?? "?"}\nSOURCE_PATH: ${decoded.sourcePath ?? "?"}`
      break
    case "patch":
      lines.push(`HASH: ${decoded.hash ?? "?"}`)
      lines.push(`FILES_COUNT: ${decoded.files.length}`)
      body = "FILES:\n" + decoded.files.join("\n")
      break
    case "subtask":
      lines.push(`AGENT: ${decoded.agent ?? "?"}`)
      if (decoded.description) body += `DESCRIPTION: ${decoded.description}\n`
      body += `PROMPT:\n${decoded.prompt}`
      break
    default:
      return null
  }

  lines.push("---BODY---")
  const enc = new TextEncoder()
  let bodyBytes = enc.encode(body).length
  if (bodyBytes > BODY_CAP_BYTES) {
    // truncate body to cap
    const truncMarker = `\n…[truncated; ${bodyBytes} bytes original; call get_part('${partId}') for full content]`
    const markerBytes = enc.encode(truncMarker).length
    const sliced = enc.encode(body).slice(0, Math.max(0, BODY_CAP_BYTES - markerBytes))
    body = new TextDecoder("utf-8", { fatal: false }).decode(sliced).replace(/\uFFFD+$/, "") + truncMarker
    bodyBytes = enc.encode(body).length
  }
  lines.push(body)
  return { content: lines.join("\n"), type: decoded.type }
}

export type ChannelDocument = { channel: SearchChannel; content: string }

/** Build derived channel documents for one raw part. */
export function buildChannelDocuments(
  partId: string,
  sessionId: string,
  messageId: string,
  data: string,
  archived: boolean,
  role: string | null,
  sessionDirectory?: string | null,
): ChannelDocument[] {
  let decoded: DecodedPart
  try { decoded = decodePart(data) } catch { return [] }
  const docs: ChannelDocument[] = []
  const baseHeaders = [
    `PART_ID: ${partId}`,
    `SESSION_ID: ${sessionId}`,
    `MESSAGE_ID: ${messageId}`,
    `ROLE: ${role ?? "unknown"}`,
    `TYPE: ${decoded.type}`,
    `ARCHIVED: ${archived}`,
  ]
  const emit = (channel: SearchChannel, body: string, extra: string[] = []) => {
    const trimmed = body.trim()
    if (!trimmed) return
    docs.push({ channel, content: [...baseHeaders, `CHANNEL: ${channel}`, ...extra, "---BODY---", capBody(trimmed, partId)].join("\n") })
  }

  switch (decoded.type) {
    case "text":
      emit("conversation", decoded.text)
      break
    case "reasoning":
      emit("reasoning", decoded.text)
      break
    case "subtask":
      emit("conversation", `${decoded.description ? `DESCRIPTION: ${decoded.description}\n` : ""}PROMPT:\n${decoded.prompt}`, [`AGENT: ${decoded.agent ?? "?"}`])
      break
    case "tool": {
      const extra = [`TOOL: ${decoded.tool}`, `STATUS: ${decoded.status}`]
      const inputSummary = summarizeToolInput(decoded.tool, decoded.input, sessionDirectory)
      emit("tool-input-summary", inputSummary || `${decoded.tool} ${decoded.status}`, extra)
      if (decoded.status === "error" && decoded.error) emit("tool-error", normalizeError(decoded.error), extra)
      if (decoded.output) emit("tool-output", decoded.output, extra)
      const codeTouch = summarizeCodeTouch(decoded.tool, decoded.input, sessionDirectory)
      if (codeTouch) emit("code-touch", codeTouch, extra)
      break
    }
    case "patch": {
      const body = decoded.files.map((f) => compactPath(f, sessionDirectory).rel_path ?? f).join("\n")
      emit("patch-summary", body, [`HASH: ${decoded.hash ?? "?"}`, `FILES_COUNT: ${decoded.files.length}`])
      emit("code-touch", body, [`SOURCE: patch`, `FILES_COUNT: ${decoded.files.length}`])
      break
    }
    case "file":
      emit("file", `FILENAME: ${decoded.filename ?? "?"}\nURL: ${decoded.url ?? "?"}\nSOURCE_PATH: ${decoded.sourcePath ?? "?"}`)
      break
  }
  return docs
}

function capBody(body: string, partId: string): string {
  const enc = new TextEncoder()
  const bytes = enc.encode(body).length
  if (bytes <= BODY_CAP_BYTES) return body
  const marker = `\n...[truncated; ${bytes} bytes original; call get_part('${partId}') for full content]`
  const markerBytes = enc.encode(marker).length
  const sliced = enc.encode(body).slice(0, Math.max(0, BODY_CAP_BYTES - markerBytes))
  return new TextDecoder("utf-8", { fatal: false }).decode(sliced).replace(/\uFFFD+$/, "") + marker
}

function summarizeToolInput(tool: string, input: unknown, sessionDirectory?: string | null): string {
  if (!input || typeof input !== "object") return stringifySafe(input)
  const obj = input as Record<string, unknown>
  const lines: string[] = []
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) lines.push(`${label}: ${compactPath(value, sessionDirectory).rel_path ?? value}`)
    else if (typeof value === "number" || typeof value === "boolean") lines.push(`${label}: ${value}`)
  }
  lines.push(`TOOL: ${tool}`)
  for (const key of ["command", "description", "filePath", "path", "url", "query", "pattern", "session_id", "message_id", "part_id", "issue_key", "pullNumber"]) {
    add(key, obj[key])
  }
  if (Array.isArray(obj.paths)) for (const p of obj.paths.slice(0, 20)) add("path", p)
  if (Array.isArray(obj.files)) for (const p of obj.files.slice(0, 20)) add("file", p)
  return lines.length > 1 ? lines.join("\n") : stringifySafe(input)
}

function summarizeCodeTouch(tool: string, input: unknown, sessionDirectory?: string | null): string | null {
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  const paths: string[] = []
  for (const key of ["filePath", "path"]) {
    if (typeof obj[key] === "string") paths.push(obj[key] as string)
  }
  for (const key of ["paths", "files"]) {
    if (Array.isArray(obj[key])) for (const p of (obj[key] as unknown[])) if (typeof p === "string") paths.push(p)
  }
  if (paths.length === 0) return null
  return [`TOOL: ${tool}`, ...paths.slice(0, 50).map((p) => compactPath(p, sessionDirectory).rel_path ?? p)].join("\n")
}

function stringifySafe(value: unknown): string {
  try { return JSON.stringify(value) } catch { return "<unserializable>" }
}

function safePartFilename(seq: number, partId: string): string {
  const safe = partId.replace(/[^A-Za-z0-9_-]/g, "_")
  return `${String(seq).padStart(5, "0")}-${safe}.txt`
}

/** Write the per-session meta.json. */
function writeMeta(s: SessionInfo, dir: string): void {
  const meta = {
    id: s.id,
    title: s.title,
    project_id: s.project_id,
    directory: s.directory,
    agent: s.agent,
    model: decodeModel(s.model),
    cost: Number(s.cost ?? 0),
    parent_id: s.parent_id,
    time_created: s.time_created,
    time_updated: s.time_updated,
    archived: s.time_archived != null,
  }
  const p = join(dir, "meta.json")
  const tmp = p + ".tmp"
  writeFileSync(tmp, JSON.stringify(meta, null, 2))
  renameSync(tmp, p)
}

/** Write one part file atomically. Also defensively cleans up any older
 *  seq-variant of the same part_id that may have been left behind by an
 *  earlier writer (defense-in-depth against the v2-migration duplicate bug). */
function writePartFile(dir: string, filename: string, content: string): void {
  const p = join(dir, filename)
  const tmp = join(dir, "." + filename + ".tmp")
  writeFileSync(tmp, content)
  renameSync(tmp, p)

  // Best-effort cleanup of any same-part_id sibling with a different seq prefix.
  const m = /^(\d{5})-(prt_[A-Za-z0-9_-]+)\.txt$/.exec(filename)
  if (!m) return
  const myPartId = m[2]
  try {
    for (const f of readdirSync(dir)) {
      if (f === filename || !f.endsWith(".txt") || f.startsWith(".")) continue
      const fm = /^(\d{5})-(prt_[A-Za-z0-9_-]+)\.txt$/.exec(f)
      if (fm && fm[2] === myPartId) {
        try { unlinkSync(join(dir, f)) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function channelDir(root: string, channel: SearchChannel, sessionId: string): string {
  return join(root, "by-channel", channel, "by-session", sessionId)
}

function deleteChannelPartFiles(root: string, sessionId: string, partId: string): void {
  for (const ch of PART_CHANNELS) {
    const dir = channelDir(root, ch, sessionId)
    if (!existsSync(dir)) continue
    try {
      for (const f of readdirSync(dir)) {
        if (f === `${partId}.txt` || f.endsWith(`-${partId}.txt`)) {
          try { unlinkSync(join(dir, f)) } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}

function writeChannelFiles(root: string, sessionId: string, filename: string, partId: string, docs: ChannelDocument[]): void {
  deleteChannelPartFiles(root, sessionId, partId)
  for (const doc of docs) {
    const dir = channelDir(root, doc.channel, sessionId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writePartFile(dir, filename, doc.content)
  }
}

function writeSessionSummaryChannel(s: SessionInfo, dirRoot = exportRoot()): void {
  const dir = channelDir(dirRoot, "session-summary", s.id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = join(dir, "summary.txt")
  const tmp = p + ".tmp"
  writeFileSync(tmp, buildSessionSummaryDocument(s))
  renameSync(tmp, p)
}

function buildSessionSummaryDocument(s: SessionInfo): string {
  const firstPrompt = firstUserPrompt(s.id, "ASC")
  const lastPrompt = firstUserPrompt(s.id, "DESC")
  const model = decodeModel(s.model)
  const lines = [
    `SESSION_ID: ${s.id}`,
    `CHANNEL: session-summary`,
    `TITLE: ${s.title}`,
    `PROJECT_ID: ${s.project_id}`,
    `DIRECTORY: ${s.directory}`,
    `AGENT: ${s.agent ?? "unknown"}`,
    `MODEL: ${model.id ?? "unknown"}`,
    `ARCHIVED: ${s.time_archived != null}`,
    `PARENT_ID: ${s.parent_id ?? ""}`,
    "---BODY---",
    `TITLE: ${s.title}`,
    `DIRECTORY: ${s.directory}`,
    firstPrompt ? `FIRST_USER_PROMPT:\n${firstPrompt}` : "FIRST_USER_PROMPT:",
    lastPrompt && lastPrompt !== firstPrompt ? `LAST_USER_PROMPT:\n${lastPrompt}` : "",
  ].filter(Boolean)
  return lines.join("\n")
}

function firstUserPrompt(sessionId: string, direction: "ASC" | "DESC"): string | null {
  const msg = stmt(`
    SELECT id
      FROM message
     WHERE session_id = ? AND json_extract(data,'$.role') = 'user'
  ORDER BY time_created ${direction}, id ${direction}
     LIMIT 1`).get(sessionId) as { id: string } | null
  if (!msg) return null
  const rows = stmt(`
    SELECT json_extract(data,'$.text') AS text
      FROM part
     WHERE message_id = ? AND json_extract(data,'$.type') = 'text'
  ORDER BY time_created ASC, id ASC`).all(msg.id) as { text: string | null }[]
  const joined = rows.map((r) => r.text ?? "").join("\n").trim()
  if (!joined) return null
  return capBody(joined, "summary")
}

/** Export progress for both inline fast sync and full reconcile. */
export type ExportProgress = {
  exported: number              // total parts written (inserts + updates)
  inserts: number               // new part files
  updates: number               // re-exported (mutated) part files
  skipped_nontext: number       // step-start / step-finish / compaction
  skipped_oversize: number      // > 50 MB safety cap
  failed: number                // decode / write errors
  retried: number                // failed part ids retried from v3 state
  dead_lettered: number          // failed ids moved out of the hot retry set
  tombstones_removed_parts: number
  tombstones_removed_sessions: number
  lock_skipped: boolean
  last_cursor: ExportCursor | null
}

/** Per-session: next-free seq + existing part_id → filename map.
 *  Built lazily by readdir on first encounter of a session in this process.
 *  Lets us OVERWRITE the existing file when a part is updated, instead of
 *  writing a duplicate.
 */
type SessionFileIndex = { nextSeq: number; byPartId: Map<string, string> }
const fileIndexBySession = new Map<string, SessionFileIndex>()

function getFileIndex(sessionId: string, dir: string): SessionFileIndex {
  let idx = fileIndexBySession.get(sessionId)
  if (idx) return idx
  idx = { nextSeq: 1, byPartId: new Map() }
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".txt") && !f.startsWith("."))
    let max = 0
    for (const f of files) {
      const m = /^(\d{5})-(prt_[A-Za-z0-9_-]+)\.txt$/.exec(f)
      if (m) {
        const seq = Number(m[1])
        const partId = m[2]
        idx.byPartId.set(partId, f)
        if (seq > max) max = seq
      } else if (/^prt_[A-Za-z0-9_-]+\.txt$/.test(f)) {
        idx.byPartId.set(f.replace(/\.txt$/, ""), f)
      }
    }
    idx.nextSeq = max + 1
  } catch { /* dir didn't exist — fresh */ }
  fileIndexBySession.set(sessionId, idx)
  return idx
}

type PartExportRow = {
  id: string
  session_id: string
  message_id: string
  time_created: number
  time_updated: number
  data: string
  data_bytes: number
  role: string | null
}

type DirtySessionRow = { id: string; time_updated: number }

/**
 * Run export sync. Budgeted calls use id-keyset insert detection plus small
 * session-dirty scans; unbudgeted calls also reconcile tombstones.
 */
export async function runExport(opts: {
  root?: string
  fromCursor?: ExportCursor | null
  budgetMs?: number
  batchSize?: number
  onProgress?: (p: ExportProgress) => void
  skipBackgroundReconcile?: boolean
} = {}): Promise<ExportProgress> {
  const root = ensureRoot(opts.root ?? exportRoot())
  const batchSize = opts.batchSize ?? 1000
  const progress = emptyProgress(getLastSync(root))
  const lock = acquireExportLock(root)
  if (!lock) {
    progress.lock_skipped = true
    return progress
  }

  try {
    const state = getSyncState(root)
    applyCursorOverride(state, opts.fromCursor)
    const start = Date.now()
    const touchedSessions = new Set<string>()

    retryFailedParts(root, state, progress, touchedSessions, start, opts.budgetMs, batchSize, opts.onProgress, lock.heartbeat)
    runInsertFastPath(root, state, progress, touchedSessions, start, opts.budgetMs, batchSize, opts.onProgress, lock.heartbeat)
    runSessionDirtyFastPath(root, state, progress, touchedSessions, start, opts.budgetMs, batchSize, opts.onProgress, lock.heartbeat)
    refreshTouchedSessions(root, touchedSessions)

    if (!opts.budgetMs) {
      lock.heartbeat()
      const tombstones = reconcileTombstones(root, lock.heartbeat)
      applyTombstoneProgress(progress, tombstones)
      state.last_reconcile_at = Date.now()
      state.reconcile_watermark = {
        part_id: state.insert_cursor.id || null,
        session_id: state.session_cursor?.id ?? null,
        at: state.last_reconcile_at,
      }
    }

    progress.last_cursor = state.legacy_cursor
    setSyncState(state, root)
  } finally {
    lock.release()
  }

  if (opts.budgetMs && !opts.skipBackgroundReconcile) {
    scheduleBackgroundReconcile({ root })
  }
  return progress
}

function emptyProgress(cursor: ExportCursor | null): ExportProgress {
  return {
    exported: 0,
    inserts: 0,
    updates: 0,
    skipped_nontext: 0,
    skipped_oversize: 0,
    failed: 0,
    retried: 0,
    dead_lettered: 0,
    tombstones_removed_parts: 0,
    tombstones_removed_sessions: 0,
    lock_skipped: false,
    last_cursor: cursor,
  }
}

function applyCursorOverride(state: SyncState, cursor: ExportCursor | null | undefined): void {
  if (cursor === undefined) return
  state.legacy_cursor = cursor
  state.insert_cursor.id = cursor?.id ?? ""
  state.session_cursor = cursor && cursor.ts > 0 ? cursor : null
  state.session_dirty_hints = {}
}

function retryFailedParts(
  root: string,
  state: SyncState,
  progress: ExportProgress,
  touchedSessions: Set<string>,
  start: number,
  budgetMs: number | undefined,
  batchSize: number,
  onProgress: ((p: ExportProgress) => void) | undefined,
  heartbeat: () => void,
): void {
  const ids = Object.keys(state.failed_parts).sort().slice(0, batchSize)
  for (const id of ids) {
    if (timeExceeded(start, budgetMs)) break
    progress.retried++
    const row = loadPartById(id)
    if (!row) {
      clearPartFailure(state, id)
      continue
    }
    exportPartRow(root, state, row, progress, touchedSessions)
    reportProgress(progress, onProgress, heartbeat)
  }
}

function runInsertFastPath(
  root: string,
  state: SyncState,
  progress: ExportProgress,
  touchedSessions: Set<string>,
  start: number,
  budgetMs: number | undefined,
  batchSize: number,
  onProgress: ((p: ExportProgress) => void) | undefined,
  heartbeat: () => void,
): void {
  const recentSafeRows: PartExportRow[] = []
  let scanCursor = state.insert_cursor.id
  while (!timeExceeded(start, budgetMs)) {
    const rows = loadPartRowsAfterId(scanCursor, batchSize)
    if (rows.length === 0) break
    for (const row of rows) {
      if (timeExceeded(start, budgetMs)) break
      scanCursor = row.id
      const safe = exportPartRow(root, state, row, progress, touchedSessions)
      if (safe) rememberSafeRow(recentSafeRows, row)
      reportProgress(progress, onProgress, heartbeat)
    }
    if (rows.length < batchSize) break
  }
  if (recentSafeRows.length > 0) {
    state.insert_cursor.id = chooseInsertCursor(state.insert_cursor.id, recentSafeRows, budgetMs !== undefined)
  }
}

function runSessionDirtyFastPath(
  root: string,
  state: SyncState,
  progress: ExportProgress,
  touchedSessions: Set<string>,
  start: number,
  budgetMs: number | undefined,
  batchSize: number,
  onProgress: ((p: ExportProgress) => void) | undefined,
  heartbeat: () => void,
): void {
  scanDirtySessionHints(state, start, budgetMs, Math.min(batchSize, 500))
  for (const [sessionId, hint] of sortedDirtyHints(state.session_dirty_hints)) {
    while (!timeExceeded(start, budgetMs)) {
      const rows = loadSessionPartRows(sessionId, hint.part_cursor, batchSize)
      if (rows.length === 0) {
        delete state.session_dirty_hints[sessionId]
        break
      }
      for (const row of rows) {
        if (timeExceeded(start, budgetMs)) break
        hint.part_cursor = row.id
        exportPartRow(root, state, row, progress, touchedSessions)
        reportProgress(progress, onProgress, heartbeat)
      }
      if (rows.length < batchSize) {
        delete state.session_dirty_hints[sessionId]
        break
      }
    }
    if (timeExceeded(start, budgetMs)) break
  }
}

function scanDirtySessionHints(state: SyncState, start: number, budgetMs: number | undefined, limit: number): void {
  while (!timeExceeded(start, budgetMs)) {
    const rows = loadDirtySessionsAfter(state.session_cursor, limit)
    if (rows.length === 0) break
    for (const row of rows) {
      state.session_dirty_hints[row.id] = { time_updated: row.time_updated, part_cursor: null }
      state.session_cursor = { ts: row.time_updated, id: row.id }
    }
    if (rows.length < limit) break
  }
}

function exportPartRow(
  root: string,
  state: SyncState,
  row: PartExportRow,
  progress: ExportProgress,
  touchedSessions: Set<string>,
): boolean {
  if (row.data_bytes > SAFETY_PART_CAP_BYTES) {
    removeExistingPartExport(root, row.session_id, row.id)
    progress.skipped_oversize++
    markSafeCursor(state, progress, row)
    clearPartFailure(state, row.id)
    return true
  }

  try {
    const session = getSession(row.session_id)
    if (!session) throw new Error(`missing session ${row.session_id}`)
    const archived = session.time_archived != null
    const built = buildPartFile(row.id, row.session_id, row.message_id, row.data, archived)
    if (!built) {
      removeExistingPartExport(root, row.session_id, row.id)
      progress.skipped_nontext++
      markSafeCursor(state, progress, row)
      clearPartFailure(state, row.id)
      return true
    }
    const channelDocs = buildChannelDocuments(row.id, row.session_id, row.message_id, row.data, archived, row.role, session.directory)
    const dir = join(root, "by-session", row.session_id)
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); writeMeta(session, dir) }
    const idx = getFileIndex(row.session_id, dir)
    const existing = idx.byPartId.get(row.id)
    if (existing) {
      writePartFile(dir, existing, built.content)
      progress.updates++
    } else {
      const filename = safePartFilename(idx.nextSeq++, row.id)
      writePartFile(dir, filename, built.content)
      idx.byPartId.set(row.id, filename)
      progress.inserts++
    }
    const filename = idx.byPartId.get(row.id)
    if (filename) writeChannelFiles(root, row.session_id, filename, row.id, channelDocs)
    touchedSessions.add(row.session_id)
    progress.exported++
    markSafeCursor(state, progress, row)
    clearPartFailure(state, row.id)
    return true
  } catch (error) {
    progress.failed++
    markPartFailure(state, row.id, errorMessage(error), progress)
    return false
  }
}

function removeExistingPartExport(root: string, sessionId: string, partId: string): void {
  const dir = join(root, "by-session", sessionId)
  try {
    if (existsSync(dir)) {
      const idx = getFileIndex(sessionId, dir)
      const existing = idx.byPartId.get(partId)
      if (existing) unlinkSync(join(dir, existing))
      idx.byPartId.delete(partId)
    }
    deleteChannelPartFiles(root, sessionId, partId)
  } catch { /* best effort stale-export cleanup */ }
}

function markSafeCursor(state: SyncState, progress: ExportProgress, row: PartExportRow): void {
  const cursor = { ts: row.time_updated, id: row.id }
  state.legacy_cursor = cursor
  progress.last_cursor = cursor
}

function markPartFailure(state: SyncState, partId: string, message: string, progress: ExportProgress): void {
  if (state.dead_letters[partId]) return
  const now = Date.now()
  const existing = state.failed_parts[partId]
  const failure: FailedPartState = {
    id: partId,
    attempts: (existing?.attempts ?? 0) + 1,
    first_failed_at: existing?.first_failed_at ?? now,
    last_failed_at: now,
    last_error: message,
  }
  if (failure.attempts >= MAX_FAILED_ATTEMPTS) {
    state.dead_letters[partId] = failure
    delete state.failed_parts[partId]
    progress.dead_lettered++
  } else {
    state.failed_parts[partId] = failure
  }
}

function clearPartFailure(state: SyncState, partId: string): void {
  delete state.failed_parts[partId]
}

function rememberSafeRow(rows: PartExportRow[], row: PartExportRow): void {
  rows.push(row)
  const maxRows = INSERT_REWIND_MAX_ROWS * 4
  if (rows.length > maxRows) rows.splice(0, rows.length - maxRows)
}

function chooseInsertCursor(previousId: string, rows: PartExportRow[], useRewind: boolean): string {
  const last = rows[rows.length - 1]
  if (!last || !useRewind || rows.length <= INSERT_REWIND_MAX_ROWS) return last?.id ?? previousId
  const maxCreated = rows.reduce((max, row) => Math.max(max, row.time_created), 0)
  const cutoff = maxCreated - INSERT_REWIND_MS
  const timeIndex = rows.findIndex((row) => row.time_created >= cutoff)
  const rewindIndex = Math.max(timeIndex <= 0 ? rows.length - INSERT_REWIND_MAX_ROWS : timeIndex - 1, rows.length - INSERT_REWIND_MAX_ROWS)
  return rows[Math.max(0, rewindIndex)]?.id ?? last.id
}

function sortedDirtyHints(hints: Record<string, DirtySessionHint>): [string, DirtySessionHint][] {
  return Object.entries(hints).sort((a, b) => a[1].time_updated - b[1].time_updated || a[0].localeCompare(b[0]))
}

function refreshTouchedSessions(root: string, touchedSessions: Set<string>): void {
  for (const sid of touchedSessions) {
    const dir = join(root, "by-session", sid)
    const fresh = stmt(`
      SELECT id, title, project_id, directory, agent, model, cost,
             time_created, time_updated, time_archived, parent_id
        FROM session WHERE id = ?`).get(sid) as SessionInfo | null
    if (fresh) {
      writeMeta(fresh, dir)
      writeSessionSummaryChannel(fresh, root)
    }
  }
}

function applyTombstoneProgress(progress: ExportProgress, tombstones: TombstoneProgress): void {
  progress.tombstones_removed_parts = tombstones.removed_parts
  progress.tombstones_removed_sessions = tombstones.removed_sessions
}

function loadPartById(partId: string): PartExportRow | null {
  return stmt(partSelectSql("WHERE p.id = ?")).get(partId) as PartExportRow | null
}

function loadPartRowsAfterId(afterId: string, limit: number): PartExportRow[] {
  if (!afterId) return stmt(`${partSelectSql("")} ORDER BY p.id ASC LIMIT ?`).all(limit) as PartExportRow[]
  return stmt(`${partSelectSql("WHERE p.id > ?")} ORDER BY p.id ASC LIMIT ?`).all(afterId, limit) as PartExportRow[]
}

function loadSessionPartRows(sessionId: string, afterId: string | null, limit: number): PartExportRow[] {
  if (!afterId) {
    return stmt(`${partSelectSql("WHERE p.session_id = ?")} ORDER BY p.id ASC LIMIT ?`).all(sessionId, limit) as PartExportRow[]
  }
  return stmt(`${partSelectSql("WHERE p.session_id = ? AND p.id > ?")} ORDER BY p.id ASC LIMIT ?`).all(sessionId, afterId, limit) as PartExportRow[]
}

function loadDirtySessionsAfter(cursor: ExportCursor | null, limit: number): DirtySessionRow[] {
  if (!cursor) {
    return stmt(`SELECT id, time_updated FROM session ORDER BY time_updated ASC, id ASC LIMIT ?`).all(limit) as DirtySessionRow[]
  }
  return stmt(`
    SELECT id, time_updated
      FROM session
     WHERE (time_updated > ? OR (time_updated = ? AND id > ?))
  ORDER BY time_updated ASC, id ASC
     LIMIT ?`).all(cursor.ts, cursor.ts, cursor.id, limit) as DirtySessionRow[]
}

function partSelectSql(where: string): string {
  return `
    SELECT p.id, p.session_id, p.message_id, p.time_created, p.time_updated,
           p.data, LENGTH(p.data) AS data_bytes,
           json_extract(m.data,'$.role') AS role
      FROM part p
      LEFT JOIN message m ON m.id = p.message_id
      ${where}`
}

function timeExceeded(start: number, budgetMs: number | undefined): boolean {
  return budgetMs !== undefined && Date.now() - start > budgetMs
}

function reportProgress(progress: ExportProgress, onProgress: ((p: ExportProgress) => void) | undefined, heartbeat: () => void): void {
  heartbeat()
  if (!onProgress) return
  const processed = progress.exported + progress.skipped_nontext + progress.skipped_oversize + progress.failed
  if (processed > 0 && processed % 5000 === 0) onProgress(progress)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** For tests. */
export function _resetExportCacheForTest(): void {
  sessionCache.clear()
  fileIndexBySession.clear()
}
