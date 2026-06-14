import { describe, expect, test, beforeEach } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FIXTURES as F } from "./fixtures/build-fixture.ts"
import { _resetExportCacheForTest, getSyncState, runExport } from "../src/lib/export.ts"
import { _resetBackgroundReconcileForTest } from "../src/lib/export-background.ts"
import {
  acquireExportLock,
  _removeStaleLockForTest,
  _staleCandidateForTest,
} from "../src/lib/export-lock.ts"

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ose-export-sync-"))
  mkdirSync(join(root, "by-session"), { recursive: true })
  return root
}

beforeEach(() => {
  _resetExportCacheForTest()
})

describe("export sync state", () => {
  test("migrates v2 timestamp cursors conservatively into v3 state", () => {
    const root = tempRoot()
    writeFileSync(join(root, ".last_sync"), "v2 1775000000011:prt_old_cursor")

    const state = getSyncState(root)

    expect(state.schema).toBe("v3")
    expect(state.migrated_from).toBe("v2")
    expect(state.insert_cursor.id).toBe("")
    expect(state.legacy_cursor).toEqual({ ts: 1775000000011, id: "prt_old_cursor" })
    expect(state.last_reconcile_at).toBeNull()
  })

  test("budgeted fast path uses v3 id cursor, not global part time_updated ordering", async () => {
    const root = tempRoot()

    const result = await runExport({ root, budgetMs: 10_000, batchSize: 20, skipBackgroundReconcile: true })
    const state = getSyncState(root)
    const raw = readFileSync(join(root, ".last_sync"), "utf8")
    const source = readFileSync(fileURLToPath(new URL("../src/lib/export.ts", import.meta.url)), "utf8")

    expect(result.exported).toBeGreaterThan(0)
    expect(raw.startsWith("v3 ")).toBe(true)
    expect(state.insert_cursor.id.startsWith("prt_")).toBe(true)
    expect(source).not.toContain("ORDER BY p.time_updated")
    expect(source).not.toContain("p.time_updated > ?")
  })

  test("budgeted fast path schedules background reconcile", async () => {
    const root = tempRoot()
    const originalWorker = globalThis.Worker
    const posted: unknown[] = []
    class FakeWorker {
      constructor(_url: URL, _options?: WorkerOptions) {}
      addEventListener(_type: string, _listener: EventListener, _options?: AddEventListenerOptions): void {}
      postMessage(message: unknown): void { posted.push(message) }
      terminate(): void {}
      unref(): void {}
    }

    ;(globalThis as any).Worker = FakeWorker
    try {
      _resetBackgroundReconcileForTest()
      const result = await runExport({ root, budgetMs: 1, batchSize: 1 })

      expect(result.lock_skipped).toBe(false)
      expect(posted).toEqual([{ root, batchSize: 2000 }])
    } finally {
      ;(globalThis as any).Worker = originalWorker
      _resetBackgroundReconcileForTest()
    }
  })

  test("lock release does not delete a replaced owner token", () => {
    const root = tempRoot()
    const lock = acquireExportLock(root)
    expect(lock).not.toBeNull()
    const lockPath = join(root, ".export.lock")
    writeFileSync(lockPath, JSON.stringify({
      token: "other-owner",
      pid: process.pid,
      hostname: "test-host",
      created_at: Date.now(),
      updated_at: Date.now(),
    }))

    lock!.release()

    expect(existsSync(lockPath)).toBe(true)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("other-owner")
  })

  test("heartbeat prevents a stale candidate from being stolen", () => {
    const root = tempRoot()
    const lockPath = join(root, ".export.lock")
    const staleMs = 1_000
    const old = Date.now() - 10_000
    const staleRecord = {
      token: "remote-owner",
      pid: 999_999,
      hostname: "remote-host",
      created_at: old,
      updated_at: old,
    }
    writeFileSync(lockPath, JSON.stringify(staleRecord))
    utimesSync(lockPath, new Date(old), new Date(old))
    const stale = _staleCandidateForTest(root, staleMs)
    expect(stale).not.toBeNull()

    writeFileSync(lockPath, JSON.stringify({ ...staleRecord, updated_at: Date.now() }))

    expect(_removeStaleLockForTest(root, stale!, staleMs)).toBe(false)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("remote-owner")
    expect(acquireExportLock(root, staleMs)).toBeNull()
  })

  test("live owner prevents a stale candidate from being stolen", () => {
    const root = tempRoot()
    const lockPath = join(root, ".export.lock")
    const staleMs = 1_000
    const old = Date.now() - 10_000
    const staleRecord = {
      token: "same-owner",
      pid: 999_999,
      hostname: "remote-host",
      created_at: old,
      updated_at: old,
    }
    writeFileSync(lockPath, JSON.stringify(staleRecord))
    utimesSync(lockPath, new Date(old), new Date(old))
    const stale = _staleCandidateForTest(root, staleMs)
    expect(stale).not.toBeNull()

    writeFileSync(lockPath, JSON.stringify({
      ...staleRecord,
      pid: process.pid,
      hostname: hostname(),
    }))
    utimesSync(lockPath, new Date(old), new Date(old))

    expect(_removeStaleLockForTest(root, stale!, staleMs)).toBe(false)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("same-owner")
    expect(acquireExportLock(root, staleMs)).toBeNull()
  })
})

describe("export retry and reconcile", () => {
  test("failed part exports stay in retry state and are retried next run", async () => {
    const root = tempRoot()
    const blockedSessionPath = join(root, "by-session", F.sessions.active)
    writeFileSync(blockedSessionPath, "not a directory")

    const first = await runExport({ root, budgetMs: 10_000, batchSize: 20, skipBackgroundReconcile: true })
    const failedIds = Object.keys(getSyncState(root).failed_parts)
    expect(first.failed).toBeGreaterThan(0)
    expect(failedIds.length).toBeGreaterThan(0)

    rmSync(blockedSessionPath, { force: true })
    mkdirSync(blockedSessionPath, { recursive: true })
    _resetExportCacheForTest()

    const second = await runExport({ root, budgetMs: 10_000, batchSize: 20, skipBackgroundReconcile: true })
    const after = getSyncState(root)
    const retriedId = failedIds[0]!
    const files = readdirSync(blockedSessionPath).filter((file) => file.includes(retriedId))

    expect(second.retried).toBeGreaterThan(0)
    expect(after.failed_parts[retriedId]).toBeUndefined()
    expect(files.length).toBe(1)
  })

  test("full reconcile removes orphan part files and channel mirrors", async () => {
    const root = tempRoot()
    await runExport({ root, batchSize: 100, skipBackgroundReconcile: true })

    const sessionDir = join(root, "by-session", F.sessions.active)
    const channelDir = join(root, "by-channel", "conversation", "by-session", F.sessions.active)
    const orphan = "00099-prt_orphan_deadbeef.txt"
    mkdirSync(sessionDir, { recursive: true })
    mkdirSync(channelDir, { recursive: true })
    writeFileSync(join(sessionDir, orphan), "PART_ID: prt_orphan_deadbeef")
    writeFileSync(join(channelDir, orphan), "PART_ID: prt_orphan_deadbeef")

    const result = await runExport({ root, batchSize: 100, skipBackgroundReconcile: true })

    expect(result.tombstones_removed_parts).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(sessionDir, orphan))).toBe(false)
    expect(existsSync(join(channelDir, orphan))).toBe(false)
  })
})
