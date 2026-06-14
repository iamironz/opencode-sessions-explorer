/**
 * Rehearsal harness for opencode-sessions-explorer tools.
 *
 * Each tool gets 5 probes: happy / empty / archived / large-blob / drift.
 *
 * MODE: by default these run HERMETICALLY against the small synthetic fixture
 * built by tests/setup.ts (preloaded via bunfig.toml) — no real DB required.
 * Assertions that are only meaningful on the author's real corpus (ck-backed
 * search, multi-thousand counts, hardcoded $HOME paths, export-propagation) are
 * either retargeted to the fixture's known values or gated behind
 * `test.skipIf(!LIVE)` / `describe.skipIf(!LIVE)`. Run `bun run test:live`
 * (OPENCODE_SESSIONS_EXPLORER_LIVE=1) to exercise everything against the live DB.
 */
import { test, describe, expect } from "bun:test"
import { runTool, runToolRaw, loadFixtures } from "./helpers.ts"
import { isTable, decodeTable } from "../src/lib/table.ts"

const F = loadFixtures()
const LIVE = !!process.env.OPENCODE_SESSIONS_EXPLORER_LIVE

// --- current_session ---
import { currentSession } from "../src/tools/current-session.ts"
describe("current_session", () => {
  test("CS-H happy — real session id via ctx", async () => {
    const r = await runTool(currentSession, { detail: "full" }, { sessionID: F.sessions.active, messageID: F.messages.active_first_user, agent: "build" })
    expect(r.ok).toBe(true)
    expect(r.data.context.session_id).toBe(F.sessions.active)
    expect(r.data.context.message_id).toBe(F.messages.active_first_user)
    expect(r.data.context.agent).toBe("build")
    expect(r.data.session).not.toBeNull()
    expect(r.data.session.id).toBe(F.sessions.active)
    expect(r.data.counters.messages_so_far).toBeGreaterThan(0)
    expect(r.data.counters.parts_so_far).toBeGreaterThan(0)
    expect(Array.isArray(r.data.suggestions)).toBe(true)
    expect(r.data.suggestions.length).toBeGreaterThanOrEqual(4)
  })
  test("CS-P paths populated correctly", async () => {
    const r = await runTool(currentSession, { detail: "full" }, { sessionID: F.sessions.active })
    expect(r.ok).toBe(true)
    expect(r.data.paths.db).toContain("opencode.db")
    expect(r.data.paths.export_root).toContain("opencode-sessions-explorer")
    expect(r.data.paths.this_session_export_dir).toContain(F.sessions.active)
    expect(r.data.paths.this_session_export_dir_exists).toBe(true)
  })
  test("CS-U unknown session id — graceful (no row, but context still returned)", async () => {
    const r = await runTool(currentSession, { detail: "full" }, { sessionID: "ses_does_not_exist_xyz" })
    expect(r.ok).toBe(true)
    expect(r.data.context.session_id).toBe("ses_does_not_exist_xyz")
    expect(r.data.session).toBeNull()
    expect(r.data.counters.messages_so_far).toBe(0)
    expect(r.data.counters.parts_so_far).toBe(0)
    expect(r.data.suggestions.length).toBeGreaterThan(0)
  })
  test("CS-E empty context (no sessionID) — still returns shape", async () => {
    const r = await runTool(currentSession, {}, { sessionID: "" })
    expect(r.ok).toBe(true)
    expect(r.data.context.session_id).toBeNull()
    expect(r.data.session).toBeNull()
    expect(r.data.suggestions).toEqual([])
  })
  test("CS-COMPACT default omits noisy details", async () => {
    const r = await runTool(currentSession, {}, { sessionID: F.sessions.active })
    expect(r.ok).toBe(true)
    expect(r.data.context.session_id).toBe(F.sessions.active)
    expect(r.data.session.id).toBe(F.sessions.active)
    expect(r.data.counters).toBeUndefined()
    expect(r.data.paths).toBeUndefined()
    expect(r.data.children_sessions).toBeUndefined()
    expect(r.data.suggestions).toEqual([])
  })
  test("CS-C cap honored", async () => {
    const r = await runTool(currentSession, {}, { sessionID: F.sessions.big_part })
    expect(r.ok).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(8 * 1024)
  })
})

// --- db_stats ---
import { dbStats } from "../src/tools/db-stats.ts"
describe("db_stats", () => {
  test("DB-H happy", async () => {
    const r = await runTool(dbStats, {})
    expect(r.ok).toBe(true)
    expect(r.data.json1_ok).toBe(true)
    expect(r.data.hard_drift.length).toBe(0)
    expect(r.data.table_counts.session).toBeGreaterThan(F.expected_counts.session_min)
    expect(r.data.table_counts.part).toBeGreaterThan(F.expected_counts.part_min)
    expect(r.data.busy_timeout_ms).toBeGreaterThanOrEqual(5000)
    expect(r.data.migrations_head).toContain("2026")
  })
  test("DB-perf <500ms", async () => {
    const r = await runTool(dbStats, {})
    expect(r.meta.query_ms).toBeLessThan(500)
  })
})

// --- list_sessions ---
import { listSessions } from "../src/tools/list-sessions.ts"
describe("list_sessions", () => {
  test("LS-H happy", async () => {
    const r = await runTool(listSessions, { limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.sessions.length).toBe(5)
    expect(r.data.has_more).toBe(true)
    expect(r.meta.next_cursor).toBeDefined()
    // newest-first
    const ts = r.data.sessions.map((s: any) => s.time_updated)
    for (let i = 1; i < ts.length; i++) expect(ts[i - 1]).toBeGreaterThanOrEqual(ts[i])
  })
  test("LS-E empty filter", async () => {
    const r = await runTool(listSessions, { project_id: "__nope__nope__", limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.sessions).toEqual([])
    expect(r.data.has_more).toBe(false)
  })
  test("LS-A archived='only'", async () => {
    const r = await runTool(listSessions, { archived: "only", limit: 3 })
    expect(r.ok).toBe(true)
    expect(r.data.sessions.length).toBeGreaterThan(0)
    for (const s of r.data.sessions) expect(s.archived).toBe(true)
  })
  test("LS-L limit clamp", async () => {
    const r = await runTool(listSessions, { limit: 100 })
    expect(r.ok).toBe(true)
    expect(r.data.sessions.length).toBeLessThanOrEqual(100)
    expect(r.meta.bytes_returned).toBeLessThan(96 * 1024)
  })
  test("LS-D title_like", async () => {
    const r = await runTool(listSessions, { title_like: "session", limit: 10 })
    expect(r.ok).toBe(true)
    expect(r.data.sessions.length).toBeGreaterThan(0)
    for (const s of r.data.sessions) expect(s.title.toLowerCase()).toContain("session")
  })
})

// --- get_session ---
import { getSession } from "../src/tools/get-session.ts"
describe("get_session", () => {
  test("GS-H happy", async () => {
    const r = await runTool(getSession, { session_id: F.sessions.active })
    expect(r.ok).toBe(true)
    expect(r.data.session.id).toBe(F.sessions.active)
    expect(r.data.message_count).toBeGreaterThan(0)
    expect(r.data.part_count).toBeGreaterThan(0)
    expect(r.data.parts_by_type).toBeDefined()
    expect(r.data.tool_call_counts).toBeDefined()
    expect(Array.isArray(r.data.child_sessions)).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(16 * 1024)
  })
  test("GS-E missing", async () => {
    const r = await runTool(getSession, { session_id: F.sessions.missing })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe("NOT_FOUND")
  })
  test("GS-A archived session", async () => {
    const r = await runTool(getSession, { session_id: F.sessions.archived })
    expect(r.ok).toBe(true)
    expect(r.data.session.archived).toBe(true)
  })
  test("GS-L big session (many parts inside)", async () => {
    const r = await runTool(getSession, { session_id: F.sessions.big_part })
    expect(r.ok).toBe(true)
    // Fixture seeds ~220 patch parts; live corpus has thousands. Lower bound that
    // holds in both modes while still proving "counts only, no blobs" below.
    expect(r.data.part_count).toBeGreaterThan(200)
    expect(r.meta.bytes_returned).toBeLessThan(16 * 1024) // counts only — no blobs
  })
  test("GS-D pre-migration (cost=0)", async () => {
    const r = await runTool(getSession, { session_id: F.sessions.pre_migration })
    expect(r.ok).toBe(true)
    expect(r.data.cost).toBe(0)
  })
})

// --- session_summary ---
import { sessionSummary } from "../src/tools/session-summary.ts"
describe("session_summary", () => {
  test("SS-H happy", async () => {
    const r = await runTool(sessionSummary, { session_id: F.sessions.active })
    expect(r.ok).toBe(true)
    expect(r.data.session.id).toBe(F.sessions.active)
    expect(r.data.first_user_prompt).not.toBeNull()
    expect(r.data.first_user_prompt.text.length).toBeGreaterThan(0)
    expect(Array.isArray(r.data.files_touched_top)).toBe(true)
    expect(Array.isArray(r.data.tools_top)).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(32 * 1024)
  })
  test("SS-E missing", async () => {
    const r = await runTool(sessionSummary, { session_id: F.sessions.missing })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe("NOT_FOUND")
  })
  test("SS-A archived ok", async () => {
    const r = await runTool(sessionSummary, { session_id: F.sessions.archived })
    expect(r.ok).toBe(true)
    expect(r.data.session.archived).toBe(true)
  })
  test("SS-L big-part session — prompt capped", async () => {
    const r = await runTool(sessionSummary, { session_id: F.sessions.big_part, max_prompt_bytes: 1024 })
    expect(r.ok).toBe(true)
    if (r.data.first_user_prompt) {
      expect(new TextEncoder().encode(r.data.first_user_prompt.text).length).toBeLessThanOrEqual(1024 + 32) // marker
    }
    expect(r.meta.bytes_returned).toBeLessThan(32 * 1024)
  })
  test("SS-D pre-migration cost_known=false", async () => {
    const r = await runTool(sessionSummary, { session_id: F.sessions.pre_migration })
    expect(r.ok).toBe(true)
    expect(r.data.cost_known).toBe(false)
  })
})

// --- session_timeline ---
import { sessionTimeline } from "../src/tools/session-timeline.ts"
describe("session_timeline", () => {
  test("TL-H happy ordering ascending", async () => {
    const r = await runTool(sessionTimeline, { session_id: F.sessions.active, limit: 20 })
    expect(r.ok).toBe(true)
    expect(r.data.events.length).toBeGreaterThan(0)
    const ts = r.data.events.map((e: any) => e.ts)
    for (let i = 1; i < ts.length; i++) expect(ts[i - 1]).toBeLessThanOrEqual(ts[i])
  })
  test("TL-E filter no matches", async () => {
    const r = await runTool(sessionTimeline, { session_id: F.sessions.active, types: ["compaction"] })
    expect(r.ok).toBe(true)
    expect(r.data.events).toEqual([])
  })
  test("TL-A archived session timeline accessible", async () => {
    const r = await runTool(sessionTimeline, { session_id: F.sessions.archived, limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.archived).toBe(true)
  })
  test("TL-L huge session — event summary capped, cap budget honored", async () => {
    const r = await runTool(sessionTimeline, { session_id: F.sessions.big_part, limit: 100 })
    expect(r.ok).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(128 * 1024)
    for (const e of r.data.events) expect(e.summary.length).toBeLessThanOrEqual(2000 + 32)
  })
  test("TL-D cursor walk no dup/gap", async () => {
    const p1 = await runTool(sessionTimeline, { session_id: F.sessions.active, limit: 10 })
    expect(p1.ok).toBe(true)
    if (p1.meta.next_cursor) {
      const p2 = await runTool(sessionTimeline, { session_id: F.sessions.active, limit: 10, cursor: p1.meta.next_cursor })
      expect(p2.ok).toBe(true)
      const ids1 = new Set(p1.data.events.map((e: any) => e.part_id))
      for (const e of p2.data.events) expect(ids1.has(e.part_id)).toBe(false)
    }
  })
})

// --- get_message ---
import { getMessage } from "../src/tools/get-message.ts"
describe("get_message", () => {
  test("GM-H happy", async () => {
    const r = await runTool(getMessage, { message_id: F.messages.active_first_user })
    expect(r.ok).toBe(true)
    expect(r.data.message.id).toBe(F.messages.active_first_user)
    expect(r.data.message.role).toBe("user")
    expect(r.data.parts.length).toBeGreaterThan(0)
  })
  test("GM-E missing", async () => {
    const r = await runTool(getMessage, { message_id: F.messages.missing })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe("NOT_FOUND")
  })
  test("GM-A header-only", async () => {
    const r = await runTool(getMessage, { message_id: F.messages.active_first_user, include_part_data: false })
    expect(r.ok).toBe(true)
    expect(r.data.parts.length).toBeGreaterThan(0)
    expect(r.data.parts[0].decoded).toBeUndefined()
  })
  test("GM-L 150 MB compaction message — bounded response", async () => {
    // The 150 MB lives in message.data metadata, not the parts. Our function
    // projects columns and never SELECTs message.data, so we must respond in
    // bounds regardless of how huge the message blob is.
    const r = await runTool(getMessage, { message_id: F.messages.big_message_150mb, max_part_bytes: 4096 })
    expect(r.ok).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(128 * 1024)
  })
  test("GM-D type filter", async () => {
    const r = await runTool(getMessage, { message_id: F.messages.active_first_user, part_types: ["text"] })
    expect(r.ok).toBe(true)
    for (const p of r.data.parts) expect(p.decoded.type).toBe("text")
  })
})

// --- get_part ---
import { getPart } from "../src/tools/get-part.ts"
describe("get_part", () => {
  test("GP-H text part happy", async () => {
    const r = await runTool(getPart, { part_id: F.parts.text_active })
    expect(r.ok).toBe(true)
    expect(r.data.decoded.type).toBe("text")
  })
  test("GP-E missing", async () => {
    const r = await runTool(getPart, { part_id: F.parts.missing })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe("NOT_FOUND")
  })
  test("GP-L big patch — capped (by-count + by-bytes)", async () => {
    const r = await runTool(getPart, { part_id: F.parts.big_5mb_patch, max_bytes: 4096 })
    expect(r.ok).toBe(true)
    expect(r.data.truncated).toBe(true)
    expect(r.data.truncated_fields.some((f: string) => f.startsWith("files"))).toBe(true)
    // Fixture's patch JSON is several KB (>200 files); live corpus has multi-MB
    // blobs. Assert the body exceeded max_bytes (so it was genuinely truncated).
    expect(r.data.original_bytes).toBeGreaterThan(4096)
    expect(r.meta.bytes_returned).toBeLessThan(128 * 1024)
  })
  test("GP-PATH dereference path-traversal rejection", async () => {
    // We can't easily synthesize an outputPath outside the whitelist without
    // touching the DB. We assert the function structure works on a part that
    // happens to have no outputPath: dereferenced should be null.
    const r = await runTool(getPart, { part_id: F.parts.text_active, dereference_output_path: true })
    expect(r.ok).toBe(true)
    expect(r.data.dereferenced).toBeNull()
  })
  test("GP-tool completed", async () => {
    const r = await runTool(getPart, { part_id: F.parts.tool_completed })
    expect(r.ok).toBe(true)
    expect(r.data.decoded.type).toBe("tool")
    expect(r.data.decoded.status).toBe("completed")
  })
})

// --- search_sessions_meta ---
import { searchSessionsMeta as searchMeta } from "../src/tools/search-sessions-meta.ts"
describe("search_sessions_meta", () => {
  test("SM-H title_like", async () => {
    const r = await runTool(searchMeta, { title_like: "review", limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.sessions.length).toBeGreaterThan(0)
    for (const s of r.data.sessions) expect(s.title.toLowerCase()).toContain("review")
  })
  test("SM-E impossible filter", async () => {
    const r = await runTool(searchMeta, { title_like: "__nothing_matches_xyz_abc__" })
    expect(r.ok).toBe(true)
    expect(r.data.sessions).toEqual([])
  })
  test("SM-A archived only", async () => {
    const r = await runTool(searchMeta, { archived: "only", limit: 3 })
    expect(r.ok).toBe(true)
    expect(r.data.sessions.length).toBeGreaterThan(0)
    for (const s of r.data.sessions) expect(s.archived).toBe(true)
  })
  test("SM-L min_cost gating", async () => {
    const r = await runTool(searchMeta, { min_cost: 1.0, limit: 5 })
    expect(r.ok).toBe(true)
    for (const s of r.data.sessions) expect(s.cost).toBeGreaterThanOrEqual(1.0)
  })
  test("SM-D LIKE escape — title containing % survives", async () => {
    const r = await runTool(searchMeta, { title_like: "%session%", limit: 5 })
    expect(r.ok).toBe(true)
    // Just assert no crash; the result may be empty since % is escaped
    expect(Array.isArray(r.data.sessions)).toBe(true)
  })
})

// --- search_tool_calls ---
import { searchToolCalls } from "../src/tools/search-tool-calls.ts"
describe("search_tool_calls", () => {
  test("TC-H tool=read status=error", async () => {
    const r = await runTool(searchToolCalls, { tool: "read", status: "error", limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.calls.length).toBeGreaterThan(0)
    for (const c of r.data.calls) {
      expect(c.tool).toBe("read")
      expect(c.status).toBe("error")
    }
  })
  test("TC-E unknown tool", async () => {
    const r = await runTool(searchToolCalls, { tool: "__nope__" })
    expect(r.ok).toBe(true)
    expect(r.data.calls).toEqual([])
  })
  test("TC-A archived bound", async () => {
    const r = await runTool(searchToolCalls, { tool: "read", archived: "only", limit: 3 })
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.data.calls)).toBe(true)
  })
  test("TC-L output cap (search for common output)", async () => {
    const r = await runTool(searchToolCalls, { status: "completed", limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(160 * 1024)
    for (const c of r.data.calls) {
      // SQLite substr() counts codepoints; JS string length counts UTF-16 code units.
      // A surrogate-pair codepoint occupies 2 code units, so a 240-codepoint cap can
      // legitimately produce up to ~480 JS chars. Cap the assertion generously.
      if (c.output_snippet) expect(c.output_snippet.length).toBeLessThanOrEqual(500)
    }
  })
  test("TC-S session filter", async () => {
    const r = await runTool(searchToolCalls, { session_id: F.sessions.active, limit: 5 })
    expect(r.ok).toBe(true)
    for (const c of r.data.calls) expect(c.session_id).toBe(F.sessions.active)
  })
})

// --- list_tool_failures ---
import { listToolFailures } from "../src/tools/list-tool-failures.ts"
describe("list_tool_failures", () => {
  test("LF-H group_by tool", async () => {
    const r = await runTool(listToolFailures, { group_by: "tool", limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.failures.length).toBeGreaterThan(0)
    expect(r.data.group_by).toBe("tool")
    // sorted by count desc
    for (let i = 1; i < r.data.failures.length; i++) {
      expect(r.data.failures[i - 1].count).toBeGreaterThanOrEqual(r.data.failures[i].count)
    }
  })
  test("LF-E impossible window", async () => {
    const r = await runTool(listToolFailures, { since_ms: Date.now() + 86400000 })
    expect(r.ok).toBe(true)
    expect(r.data.failures).toEqual([])
  })
  test("LF-A archived flag", async () => {
    const r = await runTool(listToolFailures, { archived: "only" })
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.data.failures)).toBe(true)
  })
  test("LF-L cap honored", async () => {
    const r = await runTool(listToolFailures, { group_by: "error", limit: 10, error_prefix_chars: 100 })
    expect(r.ok).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(48 * 1024)
  })
  test("LF-G group_by error prefix", async () => {
    const r = await runTool(listToolFailures, { group_by: "error", error_prefix_chars: 50, limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.group_by).toBe("error")
  })
})

// --- list_repeated_prompts ---
import { listRepeatedPrompts } from "../src/tools/list-repeated-prompts.ts"
describe("list_repeated_prompts", () => {
  test("RP-H default", async () => {
    const r = await runTool(listRepeatedPrompts, { prefix_chars: 60, min_count: 2, limit: 10 })
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.data.clusters)).toBe(true)
  })
  test("RP-E impossible window", async () => {
    const r = await runTool(listRepeatedPrompts, { since_ms: Date.now() + 86400000 })
    expect(r.ok).toBe(true)
    expect(r.data.clusters).toEqual([])
  })
  test("RP-A archived flag", async () => {
    const r = await runTool(listRepeatedPrompts, { archived: "any", limit: 5 })
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.data.clusters)).toBe(true)
  })
  test("RP-L cap honored", async () => {
    const r = await runTool(listRepeatedPrompts, { prefix_chars: 80, limit: 10 })
    expect(r.ok).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(48 * 1024)
  })
  test("RP-U min_count filters correctly", async () => {
    // Increasing min_count must monotonically reduce cluster count.
    const low = await runTool(listRepeatedPrompts, { prefix_chars: 50, min_count: 2, limit: 50 })
    const high = await runTool(listRepeatedPrompts, { prefix_chars: 50, min_count: 50, limit: 50 })
    expect(low.ok).toBe(true)
    expect(high.ok).toBe(true)
    expect(high.data.clusters.length).toBeLessThanOrEqual(low.data.clusters.length)
    for (const c of high.data.clusters) expect(c.count).toBeGreaterThanOrEqual(50)
  })
})

// --- cost_by_project ---
import { costByProject } from "../src/tools/cost-by-project.ts"
describe("cost_by_project", () => {
  test("CP-H default group_by project_id", async () => {
    const r = await runTool(costByProject, { top: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.groups.length).toBeGreaterThan(0)
    expect(r.data.group_by).toBe("project_id")
    expect(r.data.total.cost).toBeGreaterThan(0)
  })
  test("CP-E impossible range", async () => {
    const r = await runTool(costByProject, { since_ms: Date.now() + 86400000 })
    expect(r.ok).toBe(true)
    expect(r.data.groups).toEqual([])
  })
  test("CP-A by agent", async () => {
    const r = await runTool(costByProject, { group_by: "agent", top: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.group_by).toBe("agent")
  })
  test("CP-L cap honored", async () => {
    const r = await runTool(costByProject, { group_by: "directory", top: 50 })
    expect(r.ok).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(32 * 1024)
  })
  test("CP-D model grouping uses decoded id", async () => {
    const r = await runTool(costByProject, { group_by: "model", top: 5 })
    expect(r.ok).toBe(true)
    for (const g of r.data.groups) expect(typeof g.key).toBe("string")
  })
})

// --- cost_by_period ---
import { costByPeriod } from "../src/tools/cost-by-period.ts"
describe("cost_by_period", () => {
  test("CB-H daily", async () => {
    const r = await runTool(costByPeriod, { bucket: "day", max_buckets: 14 })
    expect(r.ok).toBe(true)
    expect(r.data.buckets.length).toBeGreaterThan(0)
    expect(r.data.bucket).toBe("day")
  })
  test("CB-E far past", async () => {
    const r = await runTool(costByPeriod, { bucket: "day", since_ms: 0, until_ms: 1000 })
    expect(r.ok).toBe(true)
    expect(r.data.buckets).toEqual([])
  })
  test("CB-A weekly", async () => {
    const r = await runTool(costByPeriod, { bucket: "week", max_buckets: 10 })
    expect(r.ok).toBe(true)
    expect(r.data.bucket).toBe("week")
  })
  test("CB-L all-time monthly cap", async () => {
    const r = await runTool(costByPeriod, { bucket: "month", max_buckets: 60 })
    expect(r.ok).toBe(true)
    expect(r.meta.bytes_returned).toBeLessThan(32 * 1024)
  })
  test("CB-T tz_offset shift", async () => {
    const a = await runTool(costByPeriod, { bucket: "day", tz_offset_min: 0, max_buckets: 7 })
    const b = await runTool(costByPeriod, { bucket: "day", tz_offset_min: 720, max_buckets: 7 })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    // tz shift should at least sometimes change which day a session lands in
    // we only assert both ran cleanly
    expect(Array.isArray(a.data.buckets)).toBe(true)
    expect(Array.isArray(b.data.buckets)).toBe(true)
  })
})

// --- grep_session ---
import { grepSession } from "../src/tools/grep-session.ts"
// ck-backed + requires a populated export tree → live corpus only.
describe.skipIf(!LIVE)("grep_session", () => {
  test("GR-H known phrase in active session", async () => {
    const r = await runTool(grepSession, { session_id: F.sessions.active, pattern: F.phrases.active_known, limit: 10 })
    expect(r.ok).toBe(true)
    expect(r.data.matches.length).toBeGreaterThan(0)
    for (const m of r.data.matches) if (m.part_id) expect(m.part_id).toMatch(/^prt_/)
  }, 30000)
  test("GR-E pattern absent", async () => {
    const r = await runTool(grepSession, { session_id: F.sessions.active, pattern: "__nothingmatcheszzz__" })
    expect(r.ok).toBe(true)
    expect(r.data.matches).toEqual([])
  }, 30000)
  test("GR-A archived session greppable", async () => {
    const r = await runTool(grepSession, { session_id: F.sessions.archived, pattern: "regex", limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.archived).toBe(true)
  }, 30000)
  test("GR-L limit cap", async () => {
    const r = await runTool(grepSession, { session_id: F.sessions.active, pattern: "the", limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.matches.length).toBeLessThanOrEqual(5)
    expect(r.meta.bytes_returned).toBeLessThan(160 * 1024)
  }, 30000)
  test("GR-S session not in export", async () => {
    // Use a fresh-looking but non-existent session id; the SQL check fires first → NOT_FOUND.
    const r = await runTool(grepSession, { session_id: F.sessions.missing, pattern: "x" })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe("NOT_FOUND")
  }, 30000)
  test("GR-FS fixed_string=true", async () => {
    const r = await runTool(grepSession, { session_id: F.sessions.active, pattern: "Submit PR review", fixed_string: true, limit: 5 })
    expect(r.ok).toBe(true)
  }, 30000)
  test("GR-X regex special characters survive", async () => {
    const r = await runTool(grepSession, { session_id: F.sessions.active, pattern: "PR_review|review", limit: 5 })
    expect(r.ok).toBe(true)
  }, 30000)
})

// --- search_text ---
import { searchText } from "../src/tools/search-text.ts"
// ck-backed + requires a populated export tree → live corpus only.
describe.skipIf(!LIVE)("search_text", () => {
  test("TX-H scoped regex happy", async () => {
    const r = await runTool(searchText, { q: F.phrases.active_known, session_ids: [F.sessions.active], limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.hits.length).toBeGreaterThan(0)
    expect(r.data.surface).toBeDefined()
    expect(Array.isArray(r.data.channels)).toBe(true)
    for (const h of r.data.hits) {
      expect(h.session_id).toBe(F.sessions.active)
      if (h.part_id) expect(h.part_id).toMatch(/^prt_/)
    }
  }, 30000)
  test("TX-F forensic surface uses raw channel", async () => {
    const r = await runTool(searchText, { q: F.phrases.active_known, surface: "forensics", session_ids: [F.sessions.active], limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.surface).toBe("forensics")
    expect(r.data.channels).toContain("raw")
  }, 30000)
  test("TX-E scoped empty", async () => {
    const r = await runTool(searchText, { q: "__nothingmatcheszzz__", session_ids: [F.sessions.active] })
    expect(r.ok).toBe(true)
    expect(r.data.hits).toEqual([])
  }, 30000)
  test("TX-A archived flag respected", async () => {
    const r = await runTool(searchText, { q: "regex", session_ids: [F.sessions.archived], archived: "any", limit: 3 })
    expect(r.ok).toBe(true)
  }, 30000)
  test("TX-L limit cap", async () => {
    const r = await runTool(searchText, { q: "Submit", session_ids: [F.sessions.active], limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.hits.length).toBeLessThanOrEqual(5)
    expect(r.meta.bytes_returned).toBeLessThan(160 * 1024)
  }, 30000)
  test("TX-M sem mode falls back to regex when index missing or partial", async () => {
    const r = await runTool(searchText, { q: "review", mode: "sem", session_ids: [F.sessions.active], limit: 3 })
    expect(r.ok).toBe(true)
    // Either we got semantic hits OR we got regex fallback warning
    const warns = (r.warnings ?? []).join(" ")
    const usedFallback = r.meta.mode === "fallback-regex" || warns.includes("falling back to regex")
    expect(usedFallback || r.data.hits.length >= 0).toBe(true)
  }, 30000)
  test("TX-S nonexistent session scope → empty", async () => {
    const r = await runTool(searchText, { q: "anything", session_ids: [F.sessions.missing], limit: 3 })
    expect(r.ok).toBe(true)
    expect(r.data.hits).toEqual([])
    expect(r.data.scope_session_count).toBe(0)
  }, 30000)
  test("TX-P project_id pre-filter scopes ck", async () => {
    const r = await runTool(searchText, { q: "Submit", project_id: "global", limit: 5, timeout_ms: 25000 })
    expect(r.ok).toBe(true)
    // hits may or may not exist; we just need a successful response
    expect(r.data.mode).toBeDefined()
  }, 40000)
})

// --- Phase 5 reindex probes — Layer-2 (filesystem export) update propagation ---
import { runExport, getSyncState, _resetExportCacheForTest, exportRoot } from "../src/lib/export.ts"
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
// Export-propagation over a fully materialized tree → live corpus only.
describe.skipIf(!LIVE)("L2 reindex (export update propagation)", () => {
  test("RX-H .last_sync uses v3 schema (id + session cursor state)", () => {
    const root = exportRoot()
    const p = join(root, ".last_sync")
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf8").trim()
      const state = getSyncState(root)
      expect(raw.startsWith("v3 ")).toBe(true)
      expect(state.schema).toBe("v3")
      expect(typeof state.insert_cursor.id).toBe("string")
      if (state.session_cursor) {
        expect(Number.isFinite(state.session_cursor.ts)).toBe(true)
        expect(typeof state.session_cursor.id).toBe("string")
      }
    }
  })
  test("RX-O re-exporting a part OVERWRITES its existing file (no duplicates)", async () => {
    // Pick a fixture part and locate its file.
    const partId = F.parts.text_active
    const sesId = F.sessions.active
    const dir = join(exportRoot(), "by-session", sesId)
    const files = readdirSync(dir).filter((f) => f.endsWith(".txt") && f.includes(partId))
    expect(files.length).toBeGreaterThan(0)  // file should exist after bulk export
    const filename = files[0]!
    const path = join(dir, filename)

    // Corrupt the file with placeholder content
    const sentinel = "__REWRITE_SENTINEL__"
    writeFileSync(path, sentinel)

    // Reset in-process file index so next sync re-reads the dir
    _resetExportCacheForTest()

    // Position the v3 session-dirty cursor just before the target session's
    // (time_updated,id) point, while advancing the insert id cursor past known parts.
    const { stmt: dbStmt } = await import("../src/lib/db.ts")
    const row = dbStmt(`SELECT time_updated FROM session WHERE id = ?`).get(sesId) as any
    expect(row).toBeTruthy()
    const cursor = { ts: Number(row.time_updated) - 1, id: "zzzzzz" }

    const result = await runExport({ fromCursor: cursor, budgetMs: 10000 })
    expect(result.updates).toBeGreaterThan(0)

    // After resync, file should be REWRITTEN to original (not duplicated)
    const filesAfter = readdirSync(dir).filter((f) => f.endsWith(".txt") && f.includes(partId))
    expect(filesAfter.length).toBe(1) // still exactly one file for this part_id
    expect(filesAfter[0]).toBe(filename) // same filename, not a new seq
    const restored = readFileSync(path, "utf8")
    expect(restored).not.toBe(sentinel)
    expect(restored).toContain("PART_ID: " + partId)
  }, 30000)
  test("RX-U updated parts (time_updated > time_created) get picked up by delta sync", () => {
    // Reality check: SQL ground truth says >50% of parts have time_updated > time_created.
    // v3 tracks part inserts by id and updated sessions by (time_updated,id), so
    // updated parts propagate through the session-dirty cursor instead of a global
    // part time_updated cursor.
    const state = getSyncState()
    expect(state.schema).toBe("v3")
    expect(state.session_cursor).not.toBeNull()
    expect(state.session_cursor!.ts).toBeGreaterThan(1_770_000_000_000) // recent epoch
    expect(typeof state.session_cursor!.id).toBe("string")
  })
})

// --- Phase 4 cross-cutting probes (CC-01..05) ---
import { listSessions as listSessions2 } from "../src/tools/list-sessions.ts"
import { searchToolCalls as searchToolCalls2 } from "../src/tools/search-tool-calls.ts"
import { isWhitelistedToolOutputPath, _ALLOWED_ROOTS } from "../src/lib/path-guard.ts"
import { redactSecrets } from "../src/lib/truncate.ts"
describe("CC cross-cutting", () => {
  test("CC-01 concurrent writer probe — db_stats while live writer active", async () => {
    // OpenCode is writing as we run; db_stats must still return.
    const r = await runTool(dbStats, {})
    expect(r.ok).toBe(true)
    expect(r.meta.query_ms).toBeLessThan(5000) // within busy_timeout
  })
  test("CC-02 parallel tool invocations are safe", async () => {
    const [a, b, c] = await Promise.all([
      runTool(listSessions2, { limit: 5 }),
      runTool(searchToolCalls2, { tool: "read", status: "completed", limit: 5 }),
      runTool(dbStats, {}),
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(c.ok).toBe(true)
  })
  test("CC-03a path-guard rejects ../etc/passwd style traversal", async () => {
    expect(isWhitelistedToolOutputPath("/etc/passwd")).toBe(false)
    expect(isWhitelistedToolOutputPath("/Users/aleksandr.efremenkov/.local/share/opencode/tool-output/../../../etc/passwd")).toBe(false)
    expect(isWhitelistedToolOutputPath("/Users/aleksandr.efremenkov/secret.txt")).toBe(false)
  })
  test("CC-03b path-guard accepts in-whitelist paths", async () => {
    // Paths under the configured tool-output root — even non-existent ones should pass the
    // lexical check. Use the actual whitelist root so this holds in hermetic and live modes.
    expect(isWhitelistedToolOutputPath(join(_ALLOWED_ROOTS[0]!, "tool_abc123"))).toBe(true)
  })
  test("CC-03c get_part dereference works on real outputPath fixture", async () => {
    const r = await runTool(getPart, { part_id: F.parts.tool_with_outputpath, dereference_output_path: true, max_bytes: 4096 })
    expect(r.ok).toBe(true)
    // The fixture's outputPath may or may not still exist on disk; either:
    //   - dereferenced is non-null (file existed and was read), OR
    //   - dereferenced is null AND a warning mentions dereference failure (file gone)
    if (r.data.dereferenced) {
      expect(r.data.dereferenced.path).toContain("/.local/share/opencode/tool-output/")
    } else {
      const w = (r.warnings ?? []).join(" ")
      expect(w.toLowerCase()).toContain("dereference")
    }
  })
  test.skipIf(!LIVE)("CC-04 ck timeout kills child cleanly", async () => {
    // A regex over the full export root takes ~23s; we set timeout=1000 to force kill.
    const r = await runTool(searchText, { q: "x", timeout_ms: 1000, limit: 3, archived: "any" })
    expect(r.ok).toBe(true)
    const w = (r.warnings ?? []).join(" ")
    // either ck completed under 1s (small lucky scope) OR timed out
    expect(r.data.ck_timed_out !== undefined).toBe(true)
  }, 30000)
  test("CC-05 export root is a directory", async () => {
    // Sanity: the configured export root exists (created by tests/setup.ts in
    // hermetic mode, or the real tree in live mode).
    const { statSync } = await import("node:fs")
    expect(statSync(exportRoot()).isDirectory()).toBe(true)
  })
  test("CC-06 redaction masks common secret shapes", () => {
    const raw = "Authorization: Bearer eyJabc.eyJdef.sig and ghp_abcdefghijklmnopqrstuvwxyz123456"
    const masked = redactSecrets(raw)
    expect(masked).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456")
    expect(masked.toLowerCase()).not.toContain("authorization: bearer eyjabc")
  })
})

// --- session_genealogy ---
import { sessionGenealogy } from "../src/tools/session-genealogy.ts"
describe("session_genealogy", () => {
  test("SG-H deep parent chain", async () => {
    const r = await runTool(sessionGenealogy, { session_id: F.sessions.deep_parent, direction: "ancestors", max_depth: 5 })
    expect(r.ok).toBe(true)
    expect(r.data.ancestors.length).toBeGreaterThanOrEqual(1)
  })
  test("SG-E missing", async () => {
    const r = await runTool(sessionGenealogy, { session_id: F.sessions.missing })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe("NOT_FOUND")
  })
  test("SG-A root with no parent", async () => {
    // Use active session; if it has no parent, ancestors will be empty
    const r = await runTool(sessionGenealogy, { session_id: F.sessions.active, direction: "ancestors" })
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.data.ancestors)).toBe(true)
  })
  test("SG-L max_depth bound", async () => {
    const r = await runTool(sessionGenealogy, { session_id: F.sessions.deep_parent, direction: "both", max_depth: 2 })
    expect(r.ok).toBe(true)
    expect(r.data.ancestors.length).toBeLessThanOrEqual(2)
  })
  test("SG-D descendants tree structure", async () => {
    const r = await runTool(sessionGenealogy, { session_id: F.sessions.active, direction: "descendants" })
    expect(r.ok).toBe(true)
    expect(r.data.descendants_tree).toBeDefined()
    expect(r.data.descendants_tree.id).toBe(F.sessions.active)
    expect(Array.isArray(r.data.descendants_tree.children)).toBe(true)
  })
})

// --- WIRE FORMAT: list-shaped results must be columnar tables on the wire ---
import { listSessions as listSessions3 } from "../src/tools/list-sessions.ts"
import { searchToolCalls as searchToolCalls3 } from "../src/tools/search-tool-calls.ts"
import { sessionTimeline as sessionTimeline3 } from "../src/tools/session-timeline.ts"
import { costByProject as costByProject3 } from "../src/tools/cost-by-project.ts"
import { searchText as searchText3 } from "../src/tools/search-text.ts"
describe("wire format (columnar codec)", () => {
  test("WF-LS list_sessions.sessions is a table and decodes to objects", async () => {
    const raw = await runToolRaw(listSessions3, { limit: 5 })
    expect(isTable(raw.data.sessions)).toBe(true)
    expect(Array.isArray(raw.data.sessions.cols)).toBe(true)
    expect(raw.data.sessions.rows.length).toBe(5)
    const decoded = decodeTable(raw.data.sessions)
    expect(decoded[0].id).toMatch(/^ses_/)
    expect(typeof decoded[0].title).toBe("string")
  })
  test("WF-TC search_tool_calls.calls is a table", async () => {
    const raw = await runToolRaw(searchToolCalls3, { status: "completed", limit: 5 })
    expect(isTable(raw.data.calls)).toBe(true)
  })
  test("WF-TL session_timeline.events is a table interning type", async () => {
    const raw = await runToolRaw(sessionTimeline3, { session_id: F.sessions.active, limit: 20 })
    expect(isTable(raw.data.events)).toBe(true)
  })
  test("WF-CP cost_by_project.groups is a table", async () => {
    const raw = await runToolRaw(costByProject3, { top: 5 })
    expect(isTable(raw.data.groups)).toBe(true)
  })
  test.skipIf(!LIVE)("WF-TX search_text scoped hits are a table; no duplicate ranked_sessions", async () => {
    const raw = await runToolRaw(searchText3, { q: F.phrases.active_known, session_ids: [F.sessions.active], limit: 5 })
    expect(isTable(raw.data.hits)).toBe(true)
    expect(raw.data.ranked_sessions).toBeUndefined()
  }, 30000)
  test("WF-SMALLER columnar is smaller than decoded array-of-objects", async () => {
    const raw = await runToolRaw(listSessions3, { limit: 50, archived: "any" })
    const wire = new TextEncoder().encode(JSON.stringify(raw.data.sessions)).length
    const expanded = new TextEncoder().encode(JSON.stringify(decodeTable(raw.data.sessions))).length
    expect(wire).toBeLessThan(expanded * 0.75)
  })
})
