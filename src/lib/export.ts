/**
 * Filesystem export of searchable session content, for `ck` indexing.
 *
 * Layout:
 *   <root>/by-session/<ses_id>/
 *     meta.json
 *     <NNNN>-<prt_id>.txt   (one per searchable part)
 *   <root>/by-channel/<channel>/by-session/<ses_id>/
 *     <NNNN>-<prt_id>.txt   (derived curated search views)
 *   <root>/.last_sync       (cursor: `${ts}:${id}`)
 *
 * `ck` is point-and-shoot — it walks the tree, indexes text files,
 * ignores the meta.json (per its default .ckignore which excludes JSON).
 *
 * Per-part body cap: 256 KB. Truncated with a marker pointing back at
 * get_part(prt_id).
 *
 * Atomic writes: temp file + rename. Dotfile-prefix marks in-flight.
 */
import { db, stmt, locateDb } from "./db.js"
import { decodePart, decodeModel, type DecodedPart } from "./decode.js"
import { mkdirSync, existsSync, renameSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { SearchChannel } from "./channel.js"
import { CHANNELS, compactPath, normalizeError } from "./channel.js"

export const DEFAULT_EXPORT_ROOT = join(homedir(), ".local/share/opencode-sessions-explorer")
const BODY_CAP_BYTES = 256 * 1024
const SAFETY_PART_CAP_BYTES = 50 * 1024 * 1024 // skip parts larger than 50 MB raw
const CHANNEL_COMPLETE_MARKER = ".channels_v1_complete"

export const SEARCHABLE_TYPES = ["text", "reasoning", "tool", "file", "patch", "subtask"] as const
const PART_CHANNELS: SearchChannel[] = CHANNELS.filter((c) => c !== "session-summary" && c !== "raw")

export function exportRoot(): string {
  return process.env.OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT || DEFAULT_EXPORT_ROOT
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

export type ExportCursor = { ts: number; id: string }

/**
 * Cursor schema versions:
 *   v1 — `${ts}:${id}` where ts = time_created (pre-2026-05-25T15h)
 *   v2 — `v2 ${ts}:${id}` where ts = time_updated (current)
 *
 * Reading a v1 cursor returns null so the next sync starts from 0 and re-exports
 * the whole corpus once. The exporter is idempotent: existing files are simply
 * overwritten by the byPartId map.
 */
const CURSOR_SCHEMA = "v2"

export function getLastSync(root = exportRoot()): ExportCursor | null {
  const p = join(root, ".last_sync")
  if (!existsSync(p)) return null
  try {
    const raw = readFileSync(p, "utf8").trim()
    if (!raw) return null
    if (raw.startsWith(`${CURSOR_SCHEMA} `)) {
      const [tsStr, id] = raw.slice(CURSOR_SCHEMA.length + 1).split(":")
      const ts = Number(tsStr)
      if (!Number.isFinite(ts) || !id) return null
      return { ts, id }
    }
    // v1 cursor (time_created) — discard so the next sync re-exports from zero
    return null
  } catch { return null }
}

export function setLastSync(c: ExportCursor, root = exportRoot()): void {
  const p = join(root, ".last_sync")
  const tmp = p + ".tmp"
  writeFileSync(tmp, `${CURSOR_SCHEMA} ${c.ts}:${c.id}`)
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

/**
 * Iterate parts in (time_created, id) order from after `cursor`, in
 * batches of `batch_size`. Yields per-part results so the caller can
 * decide what to do.
 */
export type ExportProgress = {
  exported: number              // total parts written (inserts + updates)
  inserts: number               // new part files
  updates: number               // re-exported (mutated) part files
  skipped_nontext: number       // step-start / step-finish / compaction
  skipped_oversize: number      // > 50 MB safety cap
  failed: number                // decode / write errors
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

/**
 * Run export in batches starting from `from` cursor (or last_sync if not given).
 * If `budgetMs` is set, stops once that many ms have elapsed (for delta sync
 * inside search calls). On bulk export, leave budgetMs undefined.
 */
export async function runExport(opts: {
  root?: string
  fromCursor?: ExportCursor | null
  budgetMs?: number
  batchSize?: number
  onProgress?: (p: ExportProgress) => void
} = {}): Promise<ExportProgress> {
  const root = ensureRoot(opts.root ?? exportRoot())
  const cursor = opts.fromCursor !== undefined ? opts.fromCursor : getLastSync(root)
  const batchSize = opts.batchSize ?? 1000
  const start = Date.now()
  const progress: ExportProgress = { exported: 0, inserts: 0, updates: 0, skipped_nontext: 0, skipped_oversize: 0, failed: 0, last_cursor: cursor }

  // Cursor is on (time_updated, id) — catches BOTH new parts AND parts whose
  // status mutated since the last sync (tool pending → completed, etc.).
  let where = ""
  const params: any[] = []
  if (cursor) {
    where = "WHERE (p.time_updated > ? OR (p.time_updated = ? AND p.id > ?))"
    params.push(cursor.ts, cursor.ts, cursor.id)
  }

  let updates = 0
  let inserts = 0
  const touchedSessions = new Set<string>()

  // Stream
  while (true) {
    if (opts.budgetMs && Date.now() - start > opts.budgetMs) break
    const rows = stmt(`
      SELECT p.id, p.session_id, p.message_id, p.time_created, p.time_updated, p.data, LENGTH(p.data) AS data_bytes,
             json_extract(m.data,'$.role') AS role
        FROM part p
        LEFT JOIN message m ON m.id = p.message_id
        ${where}
    ORDER BY p.time_updated ASC, p.id ASC
       LIMIT ?`).all(...params, batchSize) as any[]
    if (rows.length === 0) break
    for (const r of rows) {
      if (opts.budgetMs && Date.now() - start > opts.budgetMs) break
      if (r.data_bytes > SAFETY_PART_CAP_BYTES) {
        progress.skipped_oversize++
      } else {
        try {
          const s = getSession(r.session_id)
          if (!s) { progress.failed++; continue }
          const built = buildPartFile(r.id, r.session_id, r.message_id, r.data, s.time_archived != null)
          if (!built) { progress.skipped_nontext++; continue }
          const channelDocs = buildChannelDocuments(r.id, r.session_id, r.message_id, r.data, s.time_archived != null, r.role ?? null, s.directory)
          const dir = join(root, "by-session", r.session_id)
          if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); writeMeta(s, dir) }
          const idx = getFileIndex(r.session_id, dir)
          const existing = idx.byPartId.get(r.id)
          if (existing) {
            // Re-export: overwrite the same file (preserves seq order)
            writePartFile(dir, existing, built.content)
            updates++
          } else {
            // New part: allocate a fresh seq and write
            const seq = idx.nextSeq++
            const filename = safePartFilename(seq, r.id)
            writePartFile(dir, filename, built.content)
            idx.byPartId.set(r.id, filename)
            inserts++
          }
          const filename = idx.byPartId.get(r.id)
          if (filename) writeChannelFiles(root, r.session_id, filename, r.id, channelDocs)
          touchedSessions.add(r.session_id)
          progress.exported++
        } catch {
          progress.failed++
        }
      }
      progress.last_cursor = { ts: r.time_updated, id: r.id }
    }
    // Advance cursor for next iteration
    const last = rows[rows.length - 1]
    where = "WHERE (p.time_updated > ? OR (p.time_updated = ? AND p.id > ?))"
    params.length = 0
    params.push(last.time_updated, last.time_updated, last.id)
    if (opts.onProgress && progress.exported % 5000 === 0) opts.onProgress(progress)
    // Periodic flush of last_sync
    if (progress.last_cursor && progress.exported > 0 && progress.exported % 5000 === 0) {
      setLastSync(progress.last_cursor, root)
    }
  }

  // Refresh meta.json for each touched session (cheap; one write per session)
  for (const sid of touchedSessions) {
    const s = getSession(sid)
    if (s) {
      const dir = join(root, "by-session", sid)
      // session info changes over time (cost, time_updated) — re-fetch fresh
      const fresh = stmt(`
        SELECT id, title, project_id, directory, agent, model, cost,
               time_created, time_updated, time_archived, parent_id
          FROM session WHERE id = ?`).get(sid) as any
      if (fresh) writeMeta(fresh, dir)
      if (fresh) writeSessionSummaryChannel(fresh, root)
    }
  }

  if (progress.last_cursor) setLastSync(progress.last_cursor, root)
  progress.updates = updates
  progress.inserts = inserts
  return progress
}

/** For tests. */
export function _resetExportCacheForTest(): void {
  sessionCache.clear()
  fileIndexBySession.clear()
}
