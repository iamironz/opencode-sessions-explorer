/**
 * Tool-name aliases across the OpenCode V1 → V2 rename (bash→shell,
 * task→subagent): exact filters match both spellings, aggregations merge into
 * the canonical V2 bucket, LIKE patterns stay raw, rows keep the raw name.
 *
 * Exact-count probes are hermetic-only (the fixture's `tool_alias` session
 * spans both eras); membership probes also hold against the LIVE corpus.
 */
import { test, describe, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { runTool } from "./helpers.ts"
import { FIXTURES } from "./fixtures/build-fixture.ts"
import {
  TOOL_ALIAS_GROUPS,
  canonicalToolName,
  canonicalToolNameSql,
  expandToolName,
  toolNameFilter,
} from "../src/lib/tool-aliases.ts"
import { searchToolCalls } from "../src/tools/search-tool-calls.ts"
import { listToolFailures } from "../src/tools/list-tool-failures.ts"
import { sessionSummary } from "../src/tools/session-summary.ts"
import { currentSession } from "../src/tools/current-session.ts"

const LIVE = !!process.env.OPENCODE_SESSIONS_EXPLORER_LIVE
const ALIAS_SESSION = FIXTURES.sessions.tool_alias
/** Full-corpus json_each scans take ~20 s on the multi-GB live DB. */
const LIVE_SCAN_TIMEOUT_MS = 120_000

describe("tool-aliases helpers", () => {
  test("expandToolName returns the whole group, or the name alone", () => {
    expect(expandToolName("bash")).toEqual(["bash", "shell"])
    expect(expandToolName("shell")).toEqual(["bash", "shell"])
    expect(expandToolName("task")).toEqual(["task", "subagent"])
    expect(expandToolName("subagent")).toEqual(["task", "subagent"])
    expect(expandToolName("read")).toEqual(["read"])
    expect(expandToolName("execute")).toEqual(["execute"])
  })

  test("canonicalToolName maps to the V2 name", () => {
    expect(canonicalToolName("bash")).toBe("shell")
    expect(canonicalToolName("shell")).toBe("shell")
    expect(canonicalToolName("task")).toBe("subagent")
    expect(canonicalToolName("subagent")).toBe("subagent")
    expect(canonicalToolName("read")).toBe("read")
  })

  test("canonicalToolNameSql agrees with canonicalToolName for every alias + passthrough", () => {
    const db = new Database(":memory:")
    try {
      const q = db.query(`SELECT ${canonicalToolNameSql("$n")} AS c`)
      const names = [...TOOL_ALIAS_GROUPS.flat(), "read", "execute", "github_search_code", "o'brien"]
      for (const n of names) {
        expect((q.get({ $n: n }) as { c: string }).c).toBe(canonicalToolName(n))
      }
      expect((q.get({ $n: null }) as { c: string | null }).c).toBeNull()
    } finally {
      db.close()
    }
  })

  test("toolNameFilter: exact → IN over the group; LIKE pattern untouched", () => {
    expect(toolNameFilter("x", "bash")).toEqual({ sql: "x IN (?, ?)", params: ["bash", "shell"] })
    expect(toolNameFilter("x", "read")).toEqual({ sql: "x = ?", params: ["read"] })
    expect(toolNameFilter("x", "sh%")).toEqual({ sql: "x LIKE ?", params: ["sh%"] })
    expect(toolNameFilter("x", "ba_h")).toEqual({ sql: "x LIKE ?", params: ["ba_h"] })
  })
})

describe("search_tool_calls aliases", () => {
  test("TA-1 filter 'bash' only ever returns bash/shell rows (raw names kept)", async () => {
    const r = await runTool(searchToolCalls, { tool: "bash", limit: 100 })
    expect(r.ok).toBe(true)
    for (const c of r.data.calls) expect(["bash", "shell"]).toContain(c.tool)
  }, LIVE_SCAN_TIMEOUT_MS)

  test.skipIf(LIVE)("TA-2 filter 'bash' returns BOTH shell and bash rows", async () => {
    const r = await runTool(searchToolCalls, { tool: "bash", session_id: ALIAS_SESSION, limit: 100 })
    expect(r.ok).toBe(true)
    const tools = r.data.calls.map((c: any) => c.tool).sort()
    expect(tools).toEqual(["bash", "bash", "shell", "shell"])
  })

  test.skipIf(LIVE)("TA-3 filter 'shell' returns both eras too (identical set)", async () => {
    const a = await runTool(searchToolCalls, { tool: "shell", limit: 100 })
    const b = await runTool(searchToolCalls, { tool: "bash", limit: 100 })
    expect(a.ok && b.ok).toBe(true)
    const ids = (r: any) => r.data.calls.map((c: any) => c.part_id).sort()
    expect(ids(a)).toEqual(ids(b))
    expect(new Set(a.data.calls.map((c: any) => c.tool))).toEqual(new Set(["bash", "shell"]))
  })

  test.skipIf(LIVE)("TA-4 filter 'task' / 'subagent' return both eras", async () => {
    for (const tool of ["task", "subagent"]) {
      const r = await runTool(searchToolCalls, { tool, session_id: ALIAS_SESSION, limit: 100 })
      expect(r.ok).toBe(true)
      expect(r.data.calls.map((c: any) => c.tool).sort()).toEqual(["subagent", "task"])
    }
  })

  test.skipIf(LIVE)("TA-5 status filter composes with the alias group", async () => {
    const r = await runTool(searchToolCalls, { tool: "shell", status: "error", session_id: ALIAS_SESSION, limit: 100 })
    expect(r.ok).toBe(true)
    expect(r.data.calls.map((c: any) => c.tool).sort()).toEqual(["bash", "shell"])
    for (const c of r.data.calls) expect(c.status).toBe("error")
  })

  test.skipIf(LIVE)("TA-6 LIKE patterns are NOT expanded (raw-name match only)", async () => {
    const sh = await runTool(searchToolCalls, { tool: "sh%", session_id: ALIAS_SESSION, limit: 100 })
    expect(sh.ok).toBe(true)
    expect(sh.data.calls.map((c: any) => c.tool)).toEqual(["shell", "shell"])
    const ba = await runTool(searchToolCalls, { tool: "ba_h", session_id: ALIAS_SESSION, limit: 100 })
    expect(ba.ok).toBe(true)
    expect(ba.data.calls.map((c: any) => c.tool)).toEqual(["bash", "bash"])
  })
})

describe("list_tool_failures aliases", () => {
  test("TA-7 group_by tool never reports a legacy-name bucket", async () => {
    const r = await runTool(listToolFailures, { group_by: "tool", limit: 100, archived: "any" })
    expect(r.ok).toBe(true)
    const keys = r.data.failures.map((f: any) => f.key)
    expect(keys).not.toContain("bash")
    expect(keys).not.toContain("task")
    expect(new Set(keys).size).toBe(keys.length)
  }, LIVE_SCAN_TIMEOUT_MS)

  test.skipIf(LIVE)("TA-8 bash + shell failures merge into ONE 'shell' bucket", async () => {
    const r = await runTool(listToolFailures, { group_by: "tool", limit: 100 })
    expect(r.ok).toBe(true)
    const shell = r.data.failures.filter((f: any) => f.key === "shell")
    expect(shell.length).toBe(1)
    expect(shell[0].count).toBe(2)
    // merged bucket is the top failing tool in the fixture (read=1, edit=1)
    expect(r.data.failures[0].key).toBe("shell")
  })

  test.skipIf(LIVE)("TA-9 tool:'bash' filter counts both eras' failures", async () => {
    const r = await runTool(listToolFailures, { tool: "bash", group_by: "tool", limit: 10 })
    expect(r.ok).toBe(true)
    expect(r.data.failures).toHaveLength(1)
    expect(r.data.failures[0]).toMatchObject({ key: "shell", count: 2 })
  })
})

describe.skipIf(LIVE)("per-session tool counts merge eras", () => {
  test("TA-10 session-summary tools_top uses canonical names", async () => {
    const r = await runTool(sessionSummary, { session_id: ALIAS_SESSION })
    expect(r.ok).toBe(true)
    const byName = Object.fromEntries(r.data.tools_top.map((t: any) => [t.name, t]))
    expect(Object.keys(byName).sort()).toEqual(["shell", "subagent"])
    expect(byName.shell).toMatchObject({ total: 4, completed: 2, error: 2 })
    expect(byName.subagent).toMatchObject({ total: 2, completed: 2, error: 0 })
    expect(r.data.errors_count).toBe(2)
  })

  test("TA-11 current-session tools_by_name uses canonical names", async () => {
    const r = await runTool(currentSession, { detail: "full" }, { sessionID: ALIAS_SESSION })
    expect(r.ok).toBe(true)
    const t = r.data.counters.tools_by_name
    expect(Object.keys(t).sort()).toEqual(["shell", "subagent"])
    expect(t.shell).toMatchObject({ total: 4, completed: 2, error: 2 })
    expect(t.subagent).toMatchObject({ total: 2, completed: 2 })
  })
})
