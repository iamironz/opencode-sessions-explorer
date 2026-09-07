import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCk } from "../src/lib/ck.ts"
import { _resetExportCacheForTest, exportRoot, setSyncState } from "../src/lib/export.ts"
import { _resetBackgroundReconcileForTest } from "../src/lib/export-background.ts"
import { acquireExportLock } from "../src/lib/export-lock.ts"
import { searchText } from "../src/tools/search-text.ts"
import { grepSession } from "../src/tools/grep-session.ts"
import { runTool, loadFixtures, mockCtx } from "./helpers.ts"

const originalCkBin = process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN
const F = loadFixtures()

afterEach(() => {
  if (originalCkBin === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN
  else process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = originalCkBin
})

describe("ck regex scan and coverage", () => {
  test("search-text exposes regex search without a mode argument", () => {
    expect("mode" in searchText.args).toBe(false)
  })

  test("grep-session exposes regex search without a mode argument", () => {
    expect("mode" in grepSession.args).toBe(false)
  })

  test("search-text rejects any mode before launching ck when schema parsing is bypassed", async () => {
    const root = tempRoot()
    const argsLog = join(root, "ck-args.log")
    process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = writeFakeCk(root, { argsLog })

    const env = await runToolWithoutSchema(searchText, { q: "needle", mode: "sem" })

    expect(env.ok).toBe(false)
    expect(env.error?.code).toBe("BAD_ARGS")
    expect(existsSync(argsLog)).toBe(false)
  })

  test("grep-session rejects any mode before launching ck when schema parsing is bypassed", async () => {
    const root = tempRoot()
    const argsLog = join(root, "ck-args.log")
    process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = writeFakeCk(root, { argsLog })

    const env = await runToolWithoutSchema(grepSession, {
      session_id: F.sessions.active,
      pattern: "needle",
      mode: "sem",
    })

    expect(env.ok).toBe(false)
    expect(env.error?.code).toBe("BAD_ARGS")
    expect(existsSync(argsLog)).toBe(false)
  })

  test("multi-scope fanout reports truncated coverage on timeout", async () => {
    const root = tempRoot()
    const scopeA = join(root, "a")
    const scopeB = join(root, "b")
    mkdirSync(scopeA, { recursive: true })
    mkdirSync(scopeB, { recursive: true })
    process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = writeFakeCk(root, { sleepSeconds: "0.2" })

    const result = await runCk({ query: "needle", scopes: [scopeA, scopeB], timeoutMs: 50 })

    expect(result.scopeCoverage.strategy).toBe("fanout")
    expect(result.scopeCoverage.total_scopes).toBe(2)
    expect(result.scopeCoverage.searched_scopes).toBe(1)
    expect(result.scopeCoverage.truncated).toBe(true)
    expect(result.scopeCoverage.omitted_scopes).toBe(1)
    expect(result.timedOut).toBe(true)
  })

  test("search-text surfaces partial ck scope coverage", async () => {
    await withFakeBackgroundWorker(async () => {
      const root = exportRoot()
      mkdirSync(join(root, "by-session", F.sessions.active), { recursive: true })
      mkdirSync(join(root, "by-session", F.sessions.archived), { recursive: true })
      process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = writeFakeCk(tempRoot(), { sleepSeconds: "1.2" })

      const env = await runTool(searchText, {
        q: "review",
        surface: "forensics",
        session_ids: [F.sessions.active, F.sessions.archived],
        limit: 3,
        timeout_ms: 1000,
      })

      expect(env.ok).toBe(true)
      expect(env.data.ck_scope_coverage.truncated).toBe(true)
      expect(env.data.ck_scope_coverage.total_scopes).toBe(2)
      expect((env.warnings ?? []).join(" ")).toContain("results are partial")
    })
  })

  test("search-text syncs scoped DB sessions before resolving export dirs", async () => {
    await withTempExportRoot(async (root) => withFakeBackgroundWorker(async () => {
      const sessionId = F.sessions.big_part
      process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = writeFakeCk(tempRoot(), {})

      const env = await runTool(searchText, {
        q: "big patch",
        surface: "forensics",
        session_ids: [sessionId],
        limit: 3,
        timeout_ms: 1000,
      })

      expect(env.ok).toBe(true)
      expect(existsSync(join(root, "by-session", sessionId))).toBe(true)
      expect(env.data.scope_session_count).toBe(1)
      expect(env.data.ck_scope_coverage.total_scopes).toBe(1)
      expect((env.warnings ?? []).join(" ")).not.toContain("export scope missing after delta sync")
    }))
  })

  test("search-text constructs regex ck arguments", async () => {
    await withTempExportRoot(async () => withFakeBackgroundWorker(async () => {
      const fakeRoot = tempRoot()
      const argsLog = join(fakeRoot, "ck-args.log")
      process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = writeFakeCk(fakeRoot, { argsLog })

      const env = await runTool(searchText, {
        q: "needle",
        surface: "forensics",
        channels: ["raw"],
        session_ids: [F.sessions.active],
        limit: 3,
        timeout_ms: 1000,
      })

      const ckInvocations = readFileSync(argsLog, "utf8").trim().split("\n")
      const searchInvocation = ckInvocations.find((invocation) => invocation.includes("needle"))
      const searchArgs = searchInvocation?.split(/\s+/) ?? []
      expect(env.ok).toBe(true)
      expect(env.data.mode).toBe("regex")
      expect(env.meta.mode).toBe("regex")
      expect(searchInvocation).toBeDefined()
      expect(searchArgs).toContain("--regex")
      expect(searchArgs).not.toContain("--sem")
      expect(searchArgs).not.toContain("--hybrid")
    }))
  })

  test("grep-session constructs regex ck arguments", async () => {
    await withTempExportRoot(async () => withFakeBackgroundWorker(async () => {
      const fakeRoot = tempRoot()
      const argsLog = join(fakeRoot, "ck-args.log")
      process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = writeFakeCk(fakeRoot, { argsLog })

      const env = await runTool(grepSession, {
        session_id: F.sessions.active,
        pattern: "needle",
        surface: "forensics",
        channels: ["raw"],
        limit: 3,
      })

      const invocation = readFileSync(argsLog, "utf8").trim()
      const ckArgs = invocation.split(/\s+/)
      expect(env.ok).toBe(true)
      expect(env.data.mode).toBe("regex")
      expect(ckArgs).toContain("--regex")
      expect(ckArgs).not.toContain("--sem")
      expect(ckArgs).not.toContain("--hybrid")
    }))
  })

  test("search-text returns an explicit warning when scoped export remains missing", async () => {
    await withTempExportRoot(async (root) => withFakeBackgroundWorker(async () => {
      setSyncState({
        schema: "v3",
        insert_cursor: { id: "zzzzzz" },
        session_cursor: { ts: Number.MAX_SAFE_INTEGER, id: "zzzzzz" },
        session_dirty_hints: {},
        reconcile_watermark: null,
        failed_parts: {},
        dead_letters: {},
        last_reconcile_at: Date.now(),
        legacy_cursor: { ts: Number.MAX_SAFE_INTEGER, id: "zzzzzz" },
      }, root)

      const env = await runTool(searchText, {
        q: "big patch",
        surface: "forensics",
        session_ids: [F.sessions.big_part],
        limit: 3,
        timeout_ms: 1000,
      })

      expect(env.ok).toBe(true)
      expect(env.data.scope_session_count).toBe(1)
      expect(env.data.hits).toEqual([])
      expect((env.warnings ?? []).join(" ")).toContain("export scope missing after delta sync")
    }))
  })

  test("search-text marks lock-skipped export sync as stale", async () => {
    await withFakeBackgroundWorker(async () => {
      const root = exportRoot()
      mkdirSync(join(root, "by-session", F.sessions.active), { recursive: true })
      process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = writeFakeCk(tempRoot(), {})
      const lock = acquireExportLock(root)
      expect(lock).not.toBeNull()

      try {
        const env = await runTool(searchText, {
          q: "review",
          surface: "forensics",
          session_ids: [F.sessions.active],
          limit: 3,
          timeout_ms: 1000,
        })

        expect(env.ok).toBe(true)
        expect(env.meta.index_status).toBe("stale")
        expect((env.warnings ?? []).join(" ")).toContain("stale/partial export data")
      } finally {
        lock!.release()
      }
    })
  })

  test("grep-session marks lock-skipped export sync as stale", async () => {
    await withFakeBackgroundWorker(async () => {
      const root = exportRoot()
      mkdirSync(join(root, "by-session", F.sessions.active), { recursive: true })
      process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN = writeFakeCk(tempRoot(), {})
      const lock = acquireExportLock(root)
      expect(lock).not.toBeNull()

      try {
        const env = await runTool(grepSession, {
          session_id: F.sessions.active,
          pattern: "review",
          surface: "forensics",
          limit: 3,
        })

        expect(env.ok).toBe(true)
        expect(env.meta.index_status).toBe("stale")
        expect((env.warnings ?? []).join(" ")).toContain("stale/partial export data")
      } finally {
        lock!.release()
      }
    })
  })
})

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ose-ck-"))
}

async function runToolWithoutSchema(def: any, args: Record<string, unknown>): Promise<any> {
  const result = await def.execute(args, mockCtx())
  const json = typeof result === "string" ? result : (result.output ?? JSON.stringify(result))
  return JSON.parse(json)
}

function writeFakeCk(root: string, opts: { sleepSeconds?: string; argsLog?: string }): string {
  const path = join(root, "fake-ck")
  const sleep = opts.sleepSeconds ?? "0"
  const argsLog = opts.argsLog ?? ""
  writeFileSync(path, `#!/usr/bin/env bash
args_log=${JSON.stringify(argsLog)}
if [[ -n "$args_log" ]]; then
  printf '%s\n' "$*" >> "$args_log"
fi
sleep ${sleep}
scope="\${@: -1}"
printf '{"path":"%s/00001-prt_fake.txt","span":{"byte_start":0,"byte_end":4,"line_start":1,"line_end":1},"language":"text","snippet":"fake needle","score":1}\n' "$scope"
`)
  chmodSync(path, 0o755)
  return path
}

async function withFakeBackgroundWorker<T>(fn: () => Promise<T>): Promise<T> {
  const originalWorker = globalThis.Worker
  class FakeWorker {
    constructor(_url: URL, _options?: WorkerOptions) {}
    addEventListener(_type: string, _listener: EventListener, _options?: AddEventListenerOptions): void {}
    postMessage(_message: unknown): void {}
    terminate(): void {}
    unref(): void {}
  }
  ;(globalThis as any).Worker = FakeWorker
  try {
    _resetBackgroundReconcileForTest()
    return await fn()
  } finally {
    ;(globalThis as any).Worker = originalWorker
    _resetBackgroundReconcileForTest()
  }
}

async function withTempExportRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const originalRoot = process.env.OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT
  const root = tempRoot()
  process.env.OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT = root
  _resetExportCacheForTest()
  try {
    return await fn(root)
  } finally {
    if (originalRoot === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT
    else process.env.OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT = originalRoot
    _resetExportCacheForTest()
  }
}
