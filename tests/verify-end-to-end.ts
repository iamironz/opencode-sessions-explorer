/**
 * End-to-end verification — runs 17 of the 18 tools (current-session needs a
 * live OpenCode ctx) and compares results against ground-truth SQL where
 * applicable. Prints a results table with PASS/FAIL, wall-clock, and bytes_returned.
 *
 * NOTE: unarchive_session is the only WRITE tool, and it always writes when the
 * session exists. Here it is probed via the zero-mutation NOT_FOUND path (a bogus
 * id) so the live DB is never mutated; its write paths are covered by
 * tests/unarchive.test.ts on a throwaway copy.
 */
// Establish hermetic env + synthetic fixture BEFORE importing any src module or
// opening a DB. setup.ts (the same Bun preload used by `bun test`) points every
// OPENCODE_SESSIONS_EXPLORER_* path at a temp dir and materializes the fixture.
// In LIVE mode (OPENCODE_SESSIONS_EXPLORER_LIVE set) setup.ts no-ops, preserving
// the original live-DB behavior. Import order matters: this side-effecting import
// runs first so DB_PATH/fixtures below resolve against the active mode.
import "./setup.ts"
import { z } from "zod"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { loadFixtures } from "./helpers.ts"
import { decodeTable, isTable } from "../src/lib/table.ts"

// Mode-aware: hermetic uses the synthetic fixture DB built by setup.ts; LIVE uses
// the author's real corpus. Ground-truth SQL and the tools read the SAME DB, so
// the comparisons stay self-consistent in either mode.
const DB_PATH = process.env.OPENCODE_SESSIONS_EXPLORER_DB ?? `${process.env.HOME}/.local/share/opencode/opencode.db`
const fixtures = loadFixtures()

async function runTool(toolPath: string, args: Record<string, any>) {
  const mod = await import(toolPath)
  // Each module exports exactly ONE tool definition (named const). Pick it.
  const def = mod.default ?? Object.values(mod).find((v: any) => v && typeof v === "object" && "args" in v && "execute" in v)
  if (!def) throw new Error(`No tool export found in ${toolPath}`)
  const schema = z.object((def as any).args)
  const parsed = schema.parse(args)
  const ctx = {
    sessionID: "verify",
    messageID: "verify",
    agent: "verify",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
  const start = performance.now()
  const result = await (def as any).execute(parsed, ctx)
  const ms = performance.now() - start
  const json = typeof result === "string" ? result : result.output
  const env = JSON.parse(json)
  // Auto-decode columnar table fields so ground-truth comparisons read the logical shape.
  if (env?.data && typeof env.data === "object" && !Array.isArray(env.data)) {
    for (const k of Object.keys(env.data)) {
      if (isTable(env.data[k])) env.data[k] = decodeTable(env.data[k])
    }
  }
  return { env, ms, bytes: new TextEncoder().encode(json).length }
}

// Resolve relative to this file's directory so the verifier runs from any checkout.
const TOOL_DIR = join(import.meta.dir, "../src/tools")
type Row = { tool: string; passed: boolean; notes: string; ms: number; bytes: number }
const rows: Row[] = []

function rec(tool: string, passed: boolean, notes: string, ms = 0, bytes = 0) {
  rows.push({ tool, passed, notes, ms, bytes })
}

const dbRO = new Database(DB_PATH, { readonly: true })
dbRO.exec("PRAGMA busy_timeout=5000")

// ---------- 1. db_stats ----------
{
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/db-stats.ts`, {})
  // Threshold derived from the active fixtures' expected minima (hermetic: small
  // synthetic min; LIVE: real-corpus min) instead of a hardcoded live-only count.
  const ok = env.ok && env.data.json1_ok && env.data.hard_drift.length === 0 && env.data.table_counts.session > fixtures.expected_counts.session_min
  // ground truth: count sessions
  const gtSessions = (dbRO.query("SELECT COUNT(*) AS n FROM session").get() as any).n
  const correct = env.data.table_counts.session === gtSessions
  rec("db_stats", ok && correct, `migrations_head=${env.data.migrations_head}; sessions ${env.data.table_counts.session} vs gt ${gtSessions}`, ms, bytes)
}

// ---------- 2. list_sessions ----------
{
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/list-sessions.ts`, { limit: 5 })
  const ok = env.ok && env.data.sessions.length === 5 && env.data.has_more === true
  const tsDesc = env.data.sessions.every((s: any, i: number, arr: any[]) => i === 0 || arr[i - 1].time_updated >= s.time_updated)
  rec("list_sessions", ok && tsDesc, `got ${env.data.sessions.length} sessions, newest-first=${tsDesc}, next_cursor=${env.meta.next_cursor ? "yes" : "no"}`, ms, bytes)
}

// ---------- 3. get_session ----------
{
  const sesId = fixtures.sessions.active
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/get-session.ts`, { session_id: sesId })
  // ground truth from SQL
  const gt = dbRO.query(`SELECT cost, tokens_input, tokens_output FROM session WHERE id=?`).get(sesId) as any
  const gtMsg = (dbRO.query(`SELECT COUNT(*) AS n FROM message WHERE session_id=?`).get(sesId) as any).n
  const gtPart = (dbRO.query(`SELECT COUNT(*) AS n FROM part WHERE session_id=?`).get(sesId) as any).n
  const ok = env.ok && env.data.session.id === sesId
  const correct = Math.abs(env.data.cost - Number(gt.cost)) < 1e-6
              && env.data.message_count === gtMsg
              && env.data.part_count === gtPart
  rec("get_session", ok && correct, `cost ${env.data.cost} (gt ${gt.cost}); msg ${env.data.message_count}/${gtMsg}; part ${env.data.part_count}/${gtPart}`, ms, bytes)
}

// ---------- 4. session_summary ----------
{
  const sesId = fixtures.sessions.active
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/session-summary.ts`, { session_id: sesId })
  const ok = env.ok && env.data.first_user_prompt && env.data.first_user_prompt.text.length > 0
  const correct = env.data.session.id === sesId && Array.isArray(env.data.tools_top) && Array.isArray(env.data.files_touched_top)
  rec("session_summary", ok && correct, `prompt ${env.data.first_user_prompt?.text.length ?? 0}b; tools_top ${env.data.tools_top.length}; files_top ${env.data.files_touched_top.length}; errors ${env.data.errors_count}`, ms, bytes)
}

// ---------- 5. session_timeline ----------
{
  const sesId = fixtures.sessions.active
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/session-timeline.ts`, { session_id: sesId, limit: 50 })
  const ok = env.ok && env.data.events.length > 0
  // events sorted ascending
  const asc = env.data.events.every((e: any, i: number, arr: any[]) => i === 0 || arr[i - 1].ts <= e.ts)
  rec("session_timeline", ok && asc, `${env.data.events.length} events; ascending=${asc}; has_more=${env.data.has_more}`, ms, bytes)
}

// ---------- 6. get_message ----------
{
  const msgId = fixtures.messages.active_first_user
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/get-message.ts`, { message_id: msgId })
  const gtParts = (dbRO.query(`SELECT COUNT(*) AS n FROM part WHERE message_id=?`).get(msgId) as any).n
  const ok = env.ok && env.data.message.id === msgId && env.data.message.role === "user"
  const correct = env.data.parts.length === gtParts
  rec("get_message", ok && correct, `parts ${env.data.parts.length}/${gtParts}; role=${env.data.message.role}`, ms, bytes)
}

// ---------- 7. get_part ----------
{
  // pick the big 5 MB patch part and verify truncation
  const partId = fixtures.parts.big_5mb_patch
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/get-part.ts`, { part_id: partId, max_bytes: 4096 })
  const gt = dbRO.query(`SELECT LENGTH(data) AS len FROM part WHERE id=?`).get(partId) as any
  const ok = env.ok && env.data.truncated === true
  const correct = env.data.original_bytes === Number(gt.len)
  rec("get_part", ok && correct, `original ${env.data.original_bytes}/${gt.len}; truncated=${env.data.truncated}; bytes_returned ${bytes}`, ms, bytes)
}

// ---------- 8. session_genealogy ----------
{
  const sesId = fixtures.sessions.deep_parent
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/session-genealogy.ts`, { session_id: sesId, direction: "ancestors", max_depth: 5 })
  const ok = env.ok && env.data.ancestors.length >= 1
  rec("session_genealogy", ok, `ancestors ${env.data.ancestors.length}; root ${env.data.root.id}`, ms, bytes)
}

// ---------- 9. search_sessions_meta ----------
{
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/search-sessions-meta.ts`, { title_like: "review", limit: 10 })
  // ground truth: count
  const gtCount = (dbRO.query(`SELECT COUNT(*) AS n FROM session WHERE LOWER(title) LIKE '%review%' AND time_archived IS NULL`).get() as any).n
  const ok = env.ok && env.data.sessions.length > 0
  const allMatch = env.data.sessions.every((s: any) => s.title.toLowerCase().includes("review"))
  rec("search_sessions_meta", ok && allMatch, `${env.data.sessions.length} hits (gt total: ${gtCount}); all_match=${allMatch}`, ms, bytes)
}

// ---------- 10. search_tool_calls ----------
{
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/search-tool-calls.ts`, { tool: "read", status: "error", limit: 10 })
  const gt = (dbRO.query(`SELECT COUNT(*) AS n FROM part WHERE json_extract(data,'$.tool')='read' AND json_extract(data,'$.state.status')='error' AND session_id IN (SELECT id FROM session WHERE time_archived IS NULL)`).get() as any).n
  const ok = env.ok && env.data.calls.length > 0
  const allRead = env.data.calls.every((c: any) => c.tool === "read" && c.status === "error")
  rec("search_tool_calls", ok && allRead, `${env.data.calls.length} hits (gt total: ${gt}); all read/error=${allRead}`, ms, bytes)
}

// ---------- 11. list_tool_failures ----------
{
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/list-tool-failures.ts`, { group_by: "tool", limit: 5 })
  // ground truth: top error tool
  const gt = dbRO.query(`SELECT json_extract(data,'$.tool') AS t, COUNT(*) AS n FROM part WHERE json_extract(data,'$.type')='tool' AND json_extract(data,'$.state.status')='error' AND session_id IN (SELECT id FROM session WHERE time_archived IS NULL) GROUP BY t ORDER BY n DESC LIMIT 1`).get() as any
  const ok = env.ok && env.data.failures.length > 0
  const top = env.data.failures[0]
  const correct = top.key === gt.t && top.count === Number(gt.n)
  rec("list_tool_failures", ok && correct, `top: ${top?.key}=${top?.count} (gt: ${gt?.t}=${gt?.n})`, ms, bytes)
}

// ---------- 12. list_repeated_prompts ----------
{
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/list-repeated-prompts.ts`, { prefix_chars: 80, min_count: 3, limit: 10 })
  const ok = env.ok && Array.isArray(env.data.clusters)
  rec("list_repeated_prompts", ok, `${env.data.clusters.length} clusters; scanned ${env.data.scanned}`, ms, bytes)
}

// ---------- 13. cost_by_project ----------
{
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/cost-by-project.ts`, { top: 5 })
  // ground truth: total cost
  const gtTotal = (dbRO.query(`SELECT ROUND(SUM(cost), 6) AS total FROM session`).get() as any).total
  const ok = env.ok && env.data.groups.length > 0
  // groups may not cover ALL sessions if top<total groups; check first group is top
  const top = env.data.groups[0]
  const gtTop = dbRO.query(`SELECT project_id AS k, ROUND(SUM(cost), 6) AS c FROM session GROUP BY project_id ORDER BY c DESC LIMIT 1`).get() as any
  const correct = top.key === gtTop.k && Math.abs(top.cost - Number(gtTop.c)) < 0.01
  rec("cost_by_project", ok && correct, `top: ${top.key}=$${top.cost.toFixed(2)} (gt: ${gtTop.k}=$${Number(gtTop.c).toFixed(2)}); db total $${gtTotal}`, ms, bytes)
}

// ---------- 14. cost_by_period ----------
{
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/cost-by-period.ts`, { bucket: "day", max_buckets: 14 })
  const ok = env.ok && env.data.buckets.length > 0
  // sanity: total over buckets <= total over all sessions
  const gtTotal = (dbRO.query(`SELECT ROUND(SUM(cost), 6) AS total FROM session`).get() as any).total
  const bucketTotal = env.data.total.cost
  const correct = bucketTotal <= Number(gtTotal) + 0.01
  rec("cost_by_period", ok && correct, `${env.data.buckets.length} buckets; sum $${bucketTotal} <= db $${gtTotal}`, ms, bytes)
}

// ---------- 15. grep_session (ck-backed → requires a populated export tree) ----------
// Only meaningful on the live corpus: hermetic mode points ck at a non-existent
// binary and leaves the export tree empty, so this is LIVE-gated exactly like
// rehearsal.test.ts's `describe.skipIf(!LIVE)`.
if (process.env.OPENCODE_SESSIONS_EXPLORER_LIVE) {
  const sesId = fixtures.sessions.active
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/grep-session.ts`, { session_id: sesId, pattern: fixtures.phrases.active_known, limit: 5 })
  const ok = env.ok && env.data.matches.length > 0
  rec("grep_session", ok, `${env.data.matches.length} matches in '${fixtures.phrases.active_known}'; ck_ms=${env.data.ck_duration_ms}`, ms, bytes)
} else {
  rec("grep_session", true, "SKIP (ck-backed; live-only)")
}

// ---------- 16. search_text (ck-backed → requires a populated export tree) ----------
if (process.env.OPENCODE_SESSIONS_EXPLORER_LIVE) {
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/search-text.ts`, { q: fixtures.phrases.active_known, session_ids: [fixtures.sessions.active], limit: 5 })
  const ok = env.ok && env.data.hits.length > 0
  rec("search_text", ok, `${env.data.hits.length} hits; mode=${env.data.mode}; ck_ms=${env.data.ck_duration_ms}`, ms, bytes)
} else {
  rec("search_text", true, "SKIP (ck-backed; live-only)")
}

// ---------- 17. unarchive_session (SAFE: NOT_FOUND path — zero mutation) ----------
{
  // The tool always WRITES when the session exists (clears archived + resurfaces),
  // so the only mutation-free probe against the live DB is a non-existent id, which
  // must short-circuit to NOT_FOUND before any write. The real write paths are
  // covered by tests/unarchive.test.ts against a throwaway DB copy.
  const bogus = "ses_verify_does_not_exist_xyz"
  const before = (dbRO.query("SELECT COUNT(*) AS n FROM session").get() as any).n
  const { env, ms, bytes } = await runTool(`${TOOL_DIR}/unarchive-session.ts`, { session_id: bogus })
  const after = (dbRO.query("SELECT COUNT(*) AS n FROM session").get() as any).n
  const ok = env.ok === false && env.error?.code === "NOT_FOUND" && before === after
  rec("unarchive_session", ok, `NOT_FOUND on bogus id (no write); session count ${before}==${after}`, ms, bytes)
}

// ---------- output ----------
console.log("\n=== TOOL VERIFICATION RESULTS ===\n")
const w1 = Math.max(...rows.map((r) => r.tool.length)) + 2
const header = `${"tool".padEnd(w1)}  ${"status".padEnd(6)}  ${"ms".padStart(8)}  ${"bytes".padStart(8)}  notes`
console.log(header)
console.log("-".repeat(header.length))
for (const r of rows) {
  console.log(`${r.tool.padEnd(w1)}  ${(r.passed ? "PASS" : "FAIL").padEnd(6)}  ${r.ms.toFixed(0).padStart(8)}  ${String(r.bytes).padStart(8)}  ${r.notes}`)
}
const passed = rows.filter((r) => r.passed).length
console.log(`\n${passed}/${rows.length} PASS`)
process.exit(passed === rows.length ? 0 : 1)
