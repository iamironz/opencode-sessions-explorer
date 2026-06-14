import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const LOCK_FILE = ".export.lock"
const DEFAULT_STALE_MS = 2 * 60 * 1000
const HEARTBEAT_MS = 15_000

type LockRecord = {
  token: string
  pid: number
  hostname: string
  created_at: number
  updated_at: number
}

type StaleCandidate = {
  token: string | null
  updatedAt: number | null
  mtimeMs: number
}

export type ExportLock = {
  token: string
  release: () => void
  heartbeat: () => void
}

export function acquireExportLock(root: string, staleMs = DEFAULT_STALE_MS): ExportLock | null {
  const path = join(root, LOCK_FILE)
  const first = tryCreateLock(path)
  if (first) return first
  const stale = staleCandidate(path, staleMs)
  if (!stale) return null
  if (!removeStaleLock(path, stale, staleMs)) return tryCreateLock(path)
  return tryCreateLock(path)
}

function tryCreateLock(path: string): ExportLock | null {
  let fd: number | null = null
  try {
    const token = randomUUID()
    const now = Date.now()
    const record: LockRecord = { token, pid: process.pid, hostname: hostname(), created_at: now, updated_at: now }
    fd = openSync(path, "wx")
    writeFileSync(fd, JSON.stringify(record))
    closeSync(fd)
    fd = null
    let lastHeartbeat = now
    return {
      token,
      release: () => releaseLock(path, token),
      heartbeat: () => {
        const current = Date.now()
        if (current - lastHeartbeat < HEARTBEAT_MS) return
        lastHeartbeat = current
        heartbeatLock(path, token, current)
      },
    }
  } catch {
    if (fd != null) try { closeSync(fd) } catch { /* ignore */ }
    return null
  }
}

function staleCandidate(path: string, staleMs: number): StaleCandidate | null {
  try {
    const stat = statSync(path)
    const now = Date.now()
    if (now - stat.mtimeMs <= staleMs) return null
    const parsed = readLockRecord(path)
    if (!parsed) return { token: null, updatedAt: null, mtimeMs: stat.mtimeMs }
    if (now - parsed.updated_at <= staleMs) return null
    if (isLiveLocalOwner(parsed)) return null
    return { token: parsed.token, updatedAt: parsed.updated_at, mtimeMs: stat.mtimeMs }
  } catch {
    return { token: null, updatedAt: null, mtimeMs: 0 }
  }
}

function removeStaleLock(path: string, stale: StaleCandidate, staleMs: number): boolean {
  try {
    const stat = statSync(path)
    if (stat.mtimeMs !== stale.mtimeMs) return false
    if (stale.token) {
      const current = readLockRecord(path)
      if (current?.token !== stale.token) return false
      if (current.updated_at !== stale.updatedAt) return false
      const now = Date.now()
      if (now - current.updated_at <= staleMs) return false
      if (now - stat.mtimeMs <= staleMs) return false
      if (isLiveLocalOwner(current)) return false
    } else {
      if (Date.now() - stat.mtimeMs <= staleMs) return false
    }
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function releaseLock(path: string, token: string): void {
  try {
    const current = readLockRecord(path)
    if (current?.token === token) unlinkSync(path)
  } catch { /* stale or already removed */ }
}

function heartbeatLock(path: string, token: string, now: number): void {
  try {
    const current = readLockRecord(path)
    if (current?.token !== token) return
    writeFileSync(path, JSON.stringify({ ...current, updated_at: now }))
  } catch { /* lock was removed or replaced */ }
}

function readLockRecord(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>
    if (typeof parsed.token !== "string") return null
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return null
    if (typeof parsed.hostname !== "string") return null
    if (typeof parsed.created_at !== "number" || !Number.isFinite(parsed.created_at)) return null
    const updated = typeof parsed.updated_at === "number" && Number.isFinite(parsed.updated_at) ? parsed.updated_at : parsed.created_at
    return { token: parsed.token, pid: parsed.pid, hostname: parsed.hostname, created_at: parsed.created_at, updated_at: updated }
  } catch {
    return null
  }
}

function isLiveLocalOwner(record: LockRecord): boolean {
  if (record.hostname !== hostname()) return false
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false
  try {
    process.kill(record.pid, 0)
    return true
  } catch (error: any) {
    return error?.code === "EPERM"
  }
}

/** For tests. */
export function _staleCandidateForTest(root: string, staleMs: number): StaleCandidate | null {
  return staleCandidate(join(root, LOCK_FILE), staleMs)
}

/** For tests. */
export function _removeStaleLockForTest(
  root: string,
  stale: StaleCandidate,
  staleMs: number,
): boolean {
  return removeStaleLock(join(root, LOCK_FILE), stale, staleMs)
}
