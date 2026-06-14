import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { CHANNELS, type SearchChannel } from "./channel.js"
import { stmt } from "./db.js"
import { SEARCHABLE_TYPES } from "./export-constants.js"

export type TombstoneProgress = {
  scanned_sessions: number
  removed_sessions: number
  removed_parts: number
  removed_channel_sessions: number
}

const PART_FILE_RE = /^(?:\d{5}-)?(prt_[A-Za-z0-9_-]+)\.txt$/

export function reconcileTombstones(root: string, heartbeat: () => void = () => {}): TombstoneProgress {
  const progress: TombstoneProgress = {
    scanned_sessions: 0,
    removed_sessions: 0,
    removed_parts: 0,
    removed_channel_sessions: 0,
  }
  const bySession = join(root, "by-session")
  const sessions = loadSessionIds()
  if (existsSync(bySession)) {
    for (const entry of safeReadDir(bySession)) {
      const dir = join(bySession, entry)
      if (!isDirectory(dir)) continue
      if (!sessions.has(entry)) {
        rmSync(dir, { recursive: true, force: true })
        removeChannelSessionDirs(root, entry)
        progress.removed_sessions++
        heartbeat()
        continue
      }
      progress.scanned_sessions++
      progress.removed_parts += removeOrphanPartFiles(root, entry, dir, heartbeat)
      heartbeat()
    }
  }
  progress.removed_channel_sessions += removeOrphanChannelSessions(root, sessions, heartbeat)
  return progress
}

function removeOrphanPartFiles(root: string, sessionId: string, dir: string, heartbeat: () => void): number {
  const livePartIds = loadSearchablePartIds(sessionId)
  let removed = 0
  for (const file of safeReadDir(dir)) {
    heartbeat()
    const partId = partIdFromFile(file)
    if (!partId || livePartIds.has(partId)) continue
    try {
      unlinkSync(join(dir, file))
      removeChannelPartFiles(root, sessionId, partId)
      removed++
    } catch { /* best effort tombstone cleanup */ }
  }
  return removed
}

function removeOrphanChannelSessions(root: string, sessions: Set<string>, heartbeat: () => void): number {
  let removed = 0
  for (const channel of CHANNELS) {
    const base = join(root, "by-channel", channel, "by-session")
    if (!existsSync(base)) continue
    for (const sessionId of safeReadDir(base)) {
      heartbeat()
      const dir = join(base, sessionId)
      if (!isDirectory(dir) || sessions.has(sessionId)) continue
      rmSync(dir, { recursive: true, force: true })
      removed++
    }
  }
  return removed
}

function removeChannelSessionDirs(root: string, sessionId: string): void {
  for (const channel of CHANNELS) {
    rmSync(channelDir(root, channel, sessionId), { recursive: true, force: true })
  }
}

function removeChannelPartFiles(root: string, sessionId: string, partId: string): void {
  for (const channel of CHANNELS) {
    const dir = channelDir(root, channel, sessionId)
    if (!existsSync(dir)) continue
    for (const file of safeReadDir(dir)) {
      if (file === `${partId}.txt` || file.endsWith(`-${partId}.txt`)) {
        try { unlinkSync(join(dir, file)) } catch { /* ignore */ }
      }
    }
  }
}

function channelDir(root: string, channel: SearchChannel, sessionId: string): string {
  return join(root, "by-channel", channel, "by-session", sessionId)
}

function loadSessionIds(): Set<string> {
  const rows = stmt(`SELECT id FROM session`).all() as { id: string }[]
  return new Set(rows.map((row) => row.id))
}

function loadSearchablePartIds(sessionId: string): Set<string> {
  const placeholders = SEARCHABLE_TYPES.map(() => "?").join(",")
  const rows = stmt(`
    SELECT id
      FROM part
     WHERE session_id = ?
       AND json_extract(data,'$.type') IN (${placeholders})
  ORDER BY id ASC`).all(sessionId, ...SEARCHABLE_TYPES) as { id: string }[]
  return new Set(rows.map((row) => row.id))
}

function safeReadDir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

function partIdFromFile(file: string): string | null {
  const match = PART_FILE_RE.exec(file)
  return match ? match[1] : null
}
