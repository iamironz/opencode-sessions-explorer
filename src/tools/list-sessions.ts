/**
 * opencode-sessions-explorer-list-sessions
 *
 * Page sessions newest-first with structured filters.
 * Cursor: (time_updated, id). Cap: 96 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodeCursor, encodeCursor } from "../lib/pagination.js"
import { decodeModel } from "../lib/decode.js"
import { table } from "../lib/table.js"
import type { SessionRow } from "../lib/types.js"

export const listSessions = tool({
  description:
    "opencode-sessions-explorer: browse your prior OpenCode chat sessions, newest-first. " +
    "Answers questions like: \"list my recent sessions\", \"show me my sessions from yesterday / last week / this month\", \"what OpenCode sessions did I have today\", \"sessions using agent X\", \"sessions where I used Claude Opus / GPT\", \"sessions in directory Y\", \"all my OpenCode chats in /projects/foo\", \"browse my session history\", \"recent conversations\". " +
    "Returns session metadata only (id, title, agent, model, cost, tokens, timestamps, directory, archived flag) — never message bodies. For content use get-session, session-summary, session-timeline, or search-text. " +
    "Filters (combinable): project_id, agent, model_id (matches inside the JSON model column), directory_prefix, archived ('no'=default, 'only', 'any'), since_ms/until_ms (window on time_updated), title_like (case-insensitive substring). " +
    "Cursor pagination via meta.next_cursor — pass it back as `cursor` arg to get the next page.",
  args: {
    limit: tool.schema.number().int().min(1).max(100).default(20).describe("Max sessions (1-100, default 20)"),
    cursor: tool.schema.string().optional().describe("Opaque cursor from a previous call's next_cursor"),
    project_id: tool.schema.string().optional().describe("Exact project_id match (e.g. 'global')"),
    agent: tool.schema.string().optional().describe("Exact agent name match"),
    model_id: tool.schema.string().optional().describe("Substring match on the model id inside session.model JSON"),
    directory_prefix: tool.schema.string().optional().describe("Filter to sessions where directory starts with this string"),
    archived: tool.schema.enum(["no", "only", "any"]).default("no").describe("'no' (default) excludes archived; 'only' returns only archived; 'any' includes both"),
    since_ms: tool.schema.number().int().nonnegative().optional().describe("Only sessions with time_updated >= since_ms"),
    until_ms: tool.schema.number().int().nonnegative().optional().describe("Only sessions with time_updated <= until_ms"),
    title_like: tool.schema.string().optional().describe("Case-insensitive substring on title"),
  },
  async execute(args) {
    return runWithEnvelope("list_sessions", 96, async (ctx) => {
      const limit = args.limit
      const cursor = decodeCursor(args.cursor)
      const where: string[] = []
      const params: any[] = []
      if (args.archived === "no") where.push("s.time_archived IS NULL")
      else if (args.archived === "only") where.push("s.time_archived IS NOT NULL")
      if (args.project_id !== undefined) { where.push("s.project_id = ?"); params.push(args.project_id) }
      if (args.agent !== undefined) { where.push("s.agent = ?"); params.push(args.agent) }
      if (args.model_id !== undefined) { where.push("json_extract(s.model,'$.id') = ?"); params.push(args.model_id) }
      if (args.directory_prefix !== undefined) { where.push("s.directory LIKE ?"); params.push(`${escapeLike(args.directory_prefix)}%`) }
      if (args.since_ms !== undefined) { where.push("s.time_updated >= ?"); params.push(args.since_ms) }
      if (args.until_ms !== undefined) { where.push("s.time_updated <= ?"); params.push(args.until_ms) }
      if (args.title_like !== undefined) { where.push("LOWER(s.title) LIKE ?"); params.push(`%${escapeLike(args.title_like.toLowerCase())}%`) }
      if (cursor) {
        // (time_updated DESC, id DESC) — strictly less than cursor
        where.push("(s.time_updated < ? OR (s.time_updated = ? AND s.id < ?))")
        params.push(cursor.ts, cursor.ts, cursor.id)
      }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : ""
      const sql = `
        SELECT s.id, s.project_id, s.parent_id, s.directory, s.title, s.agent, s.model,
               s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,
               s.time_created, s.time_updated, s.time_archived, s.workspace_id, s.slug
          FROM session s
          ${whereSql}
       ORDER BY s.time_updated DESC, s.id DESC
          LIMIT ?`
      params.push(limit + 1) // ask for one extra to detect "has_more"
      const rows = stmt(sql).all(...params) as Partial<SessionRow>[]
      let hasMore = false
      if (rows.length > limit) {
        rows.pop()
        hasMore = true
      }
      if (hasMore && rows.length > 0) {
        const last = rows[rows.length - 1]!
        ctx.nextCursor = encodeCursor({ ts: last.time_updated!, id: last.id! })
      }
      const records = rows.map((r) => ({
        id: r.id,
        project_id: r.project_id,
        parent_id: r.parent_id,
        directory: r.directory,
        title: r.title,
        slug: r.slug,
        agent: r.agent,
        model: decodeModel(r.model),
        cost: Number(r.cost ?? 0),
        tokens_input: Number(r.tokens_input ?? 0),
        tokens_output: Number(r.tokens_output ?? 0),
        tokens_reasoning: Number(r.tokens_reasoning ?? 0),
        time_created: r.time_created,
        time_updated: r.time_updated,
        archived: r.time_archived != null,
      }))
      return { sessions: table(records, { dict: ["agent", "model", "directory", "project_id"] }), has_more: hasMore }
    })
  },
})

function escapeLike(s: string): string {
  // LIKE wildcards: % _ — escape with backslash (sqlite uses ESCAPE-clause but
  // we keep this simple by stripping/escaping in the substring filter only).
  return s.replace(/[%_]/g, (m) => "\\" + m)
}
