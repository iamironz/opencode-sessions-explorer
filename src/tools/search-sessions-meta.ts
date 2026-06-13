/**
 * opencode-sessions-explorer-search-sessions-meta
 *
 * Filter sessions by structured fields (title, directory, project, agent,
 * model, cost/token thresholds, time window, archived). Complements
 * list_sessions by adding cost/token thresholds. Cap: 96 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { decodeCursor, encodeCursor } from "../lib/pagination.js"
import { decodeModel } from "../lib/decode.js"
import { table } from "../lib/table.js"

export const searchSessionsMeta = tool({
  description:
    "opencode-sessions-explorer: find OpenCode sessions by STRUCTURED METADATA filters (title, directory, project, agent, model, cost, tokens, time). For CONTENT search (body of conversations) use search-text instead. " +
    "Answers: \"find sessions whose title matches X\", \"sessions costing more than $5\", \"sessions where I used Claude Opus this week\", \"sessions in directory Y from last month\", \"sessions with more than 100K input tokens\", \"expensive sessions\", \"most expensive single session\", \"sessions matching multiple criteria at once\". " +
    "Filters (all combinable): title_like (case-insensitive substring on session title), directory_like (LIKE substring), project_id, agent, model_id (substring on session.model JSON), min_cost (USD threshold), min_tokens_input, since_ms / until_ms (window on time_updated), archived ('no'=default, 'only', 'any'). " +
    "Same envelope as list-sessions but with cost/token thresholds added. Cursor pagination. Returns metadata only.",
  args: {
    title_like: tool.schema.string().optional().describe("Case-insensitive substring on title"),
    directory_like: tool.schema.string().optional().describe("LIKE substring on directory"),
    project_id: tool.schema.string().optional(),
    agent: tool.schema.string().optional(),
    model_id: tool.schema.string().optional(),
    min_cost: tool.schema.number().nonnegative().optional().describe("Sessions with cost >= this (USD)"),
    min_tokens_input: tool.schema.number().int().nonnegative().optional(),
    since_ms: tool.schema.number().int().nonnegative().optional(),
    until_ms: tool.schema.number().int().nonnegative().optional(),
    archived: tool.schema.enum(["no", "only", "any"]).default("no"),
    limit: tool.schema.number().int().min(1).max(100).default(20),
    cursor: tool.schema.string().optional(),
  },
  async execute(args) {
    return runWithEnvelope("search_sessions_meta", 96, async (ctx) => {
      const where: string[] = []
      const params: any[] = []
      if (args.archived === "no") where.push("s.time_archived IS NULL")
      else if (args.archived === "only") where.push("s.time_archived IS NOT NULL")
      if (args.title_like) { where.push("LOWER(s.title) LIKE ?"); params.push(`%${args.title_like.toLowerCase().replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.directory_like) { where.push("s.directory LIKE ?"); params.push(`%${args.directory_like.replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.project_id) { where.push("s.project_id = ?"); params.push(args.project_id) }
      if (args.agent) { where.push("s.agent = ?"); params.push(args.agent) }
      if (args.model_id) { where.push("json_extract(s.model,'$.id') = ?"); params.push(args.model_id) }
      if (args.min_cost !== undefined) { where.push("s.cost >= ?"); params.push(args.min_cost) }
      if (args.min_tokens_input !== undefined) { where.push("s.tokens_input >= ?"); params.push(args.min_tokens_input) }
      if (args.since_ms !== undefined) { where.push("s.time_updated >= ?"); params.push(args.since_ms) }
      if (args.until_ms !== undefined) { where.push("s.time_updated <= ?"); params.push(args.until_ms) }
      const cursor = decodeCursor(args.cursor)
      if (cursor) {
        where.push("(s.time_updated < ? OR (s.time_updated = ? AND s.id < ?))")
        params.push(cursor.ts, cursor.ts, cursor.id)
      }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : ""
      const sql = `
        SELECT s.id, s.project_id, s.parent_id, s.directory, s.title, s.agent, s.model,
               s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,
               s.time_created, s.time_updated, s.time_archived
          FROM session s
          ${whereSql}
      ORDER BY s.time_updated DESC, s.id DESC
         LIMIT ?`
      params.push(args.limit + 1)
      const rows = stmt(sql).all(...params) as any[]
      let hasMore = false
      if (rows.length > args.limit) { rows.pop(); hasMore = true }
      if (hasMore && rows.length > 0) {
        const last = rows[rows.length - 1]
        ctx.nextCursor = encodeCursor({ ts: last.time_updated, id: last.id })
      }
      const records = rows.map((r) => ({
        id: r.id,
        project_id: r.project_id,
        parent_id: r.parent_id,
        directory: r.directory,
        title: r.title,
        agent: r.agent,
        model: decodeModel(r.model),
        cost: Number(r.cost ?? 0),
        tokens_input: Number(r.tokens_input),
        tokens_output: Number(r.tokens_output),
        tokens_reasoning: Number(r.tokens_reasoning),
        time_created: r.time_created,
        time_updated: r.time_updated,
        archived: r.time_archived != null,
      }))
      return {
        sessions: table(records, { dict: ["agent", "model", "directory", "project_id"] }),
        has_more: hasMore,
      }
    })
  },
})
