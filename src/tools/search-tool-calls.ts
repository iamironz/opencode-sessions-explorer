/**
 * opencode-sessions-explorer-search-tool-calls
 *
 * Filter tool invocations by tool name, status, input/output/error substring,
 * project, session, time. Newest-first. Cap: 160 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { decodeCursor, encodeCursor } from "../lib/pagination.js"
import { snippet } from "../lib/truncate.js"
import { table } from "../lib/table.js"

export const searchToolCalls = tool({
  description:
    "opencode-sessions-explorer: find OpenCode tool invocations across all sessions, filtered by tool name, status, or substring on input/output/error. " +
    "Answers: \"find every time I ran git push\", \"all bash commands I ran touching file X\", \"every read tool that errored\", \"all my Jira MCP calls\" (with `tool:'mcp-atlassian_jira_%'` LIKE wildcard), \"every webfetch call to github.com\", \"when did apply_patch fail recently\", \"all tool calls in session ses_X\", \"any currently-running tool calls\". " +
    "Filters: tool (exact match OR LIKE wildcard if it contains % or _), status ('completed'/'error'/'running'/'pending'/'any'), input_like (substring on JSON-stringified $.state.input), output_like (substring on $.state.output), error_like (substring on $.state.error), session_id, project_id, since_ms/until_ms, archived. " +
    "Returns: tool calls with part_id, session_id, tool name, status, duration_ms, and capped snippets (240 chars) of input/output/error. Cursor pagination, newest-first.",
  args: {
    tool: tool.schema.string().optional().describe("Exact tool name (e.g. 'read', 'bash'). Supports SQL LIKE wildcards if it contains % or _"),
    status: tool.schema.enum(["pending", "running", "completed", "error", "any"]).default("any"),
    input_like: tool.schema.string().optional().describe("Substring in JSON-stringified tool input"),
    output_like: tool.schema.string().optional(),
    error_like: tool.schema.string().optional(),
    include_snippets: tool.schema.array(tool.schema.enum(["input", "output", "error"])).optional().describe("Which snippet fields to include. Defaults to the matched dimension, or error for status=error."),
    session_id: tool.schema.string().optional(),
    project_id: tool.schema.string().optional(),
    since_ms: tool.schema.number().int().nonnegative().optional(),
    until_ms: tool.schema.number().int().nonnegative().optional(),
    archived: tool.schema.enum(["no", "only", "any"]).default("no"),
    limit: tool.schema.number().int().min(1).max(100).default(10),
    cursor: tool.schema.string().optional(),
  },
  async execute(args) {
    return runWithEnvelope("search_tool_calls", 160, async (ctx) => {
      const where: string[] = ["json_extract(p.data,'$.type') = 'tool'"]
      const params: any[] = []
      if (args.tool) {
        if (/[%_]/.test(args.tool)) { where.push("json_extract(p.data,'$.tool') LIKE ?"); params.push(args.tool) }
        else { where.push("json_extract(p.data,'$.tool') = ?"); params.push(args.tool) }
      }
      if (args.status !== "any") { where.push("json_extract(p.data,'$.state.status') = ?"); params.push(args.status) }
      if (args.input_like) { where.push("json_extract(p.data,'$.state.input') LIKE ?"); params.push(`%${args.input_like.replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.output_like) { where.push("json_extract(p.data,'$.state.output') LIKE ?"); params.push(`%${args.output_like.replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.error_like) { where.push("json_extract(p.data,'$.state.error') LIKE ?"); params.push(`%${args.error_like.replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.session_id) { where.push("p.session_id = ?"); params.push(args.session_id) }
      if (args.project_id) { where.push("p.session_id IN (SELECT id FROM session WHERE project_id = ?)"); params.push(args.project_id) }
      if (args.since_ms !== undefined) { where.push("p.time_created >= ?"); params.push(args.since_ms) }
      if (args.until_ms !== undefined) { where.push("p.time_created <= ?"); params.push(args.until_ms) }
      if (args.archived === "no") where.push("p.session_id IN (SELECT id FROM session WHERE time_archived IS NULL)")
      else if (args.archived === "only") where.push("p.session_id IN (SELECT id FROM session WHERE time_archived IS NOT NULL)")
      const cursor = decodeCursor(args.cursor)
      if (cursor) {
        where.push("(p.time_created < ? OR (p.time_created = ? AND p.id < ?))")
        params.push(cursor.ts, cursor.ts, cursor.id)
      }
      const sql = `
        SELECT p.id AS part_id, p.session_id, p.message_id, p.time_created,
               json_extract(p.data,'$.tool') AS tool,
               json_extract(p.data,'$.state.status') AS status,
               substr(COALESCE(json_extract(p.data,'$.state.error'),''), 1, 240) AS error_snippet,
               substr(COALESCE(json_extract(p.data,'$.state.output'),''), 1, 240) AS output_snippet,
               substr(COALESCE(json_extract(p.data,'$.state.input'),''), 1, 240) AS input_snippet,
               json_extract(p.data,'$.state.time.start') AS t_start,
               json_extract(p.data,'$.state.time.end') AS t_end
          FROM part p
         WHERE ${where.join(" AND ")}
      ORDER BY p.time_created DESC, p.id DESC
         LIMIT ?`
      params.push(args.limit + 1)
      const rows = stmt(sql).all(...params) as any[]
      let hasMore = false
      if (rows.length > args.limit) { rows.pop(); hasMore = true }
      if (hasMore && rows.length > 0) {
        const last = rows[rows.length - 1]
        ctx.nextCursor = encodeCursor({ ts: last.time_created, id: last.part_id })
      }
      const include = defaultSnippetFields(args)
      const records = rows.map((r) => ({
        part_id: r.part_id,
        session_id: r.session_id,
        message_id: r.message_id,
        ts: r.time_created,
        tool: r.tool,
        status: r.status,
        duration_ms: (r.t_start != null && r.t_end != null) ? r.t_end - r.t_start : null,
        ...(include.includes("input") ? { input_snippet: centered(r.input_snippet, args.input_like) } : {}),
        ...(include.includes("output") ? { output_snippet: centered(r.output_snippet, args.output_like) } : {}),
        ...(include.includes("error") ? { error_snippet: centered(r.error_snippet, args.error_like) } : {}),
      }))
      return {
        calls: table(records, { dict: ["tool", "status", "session_id"] }),
        has_more: hasMore,
      }
    })
  },
})

function defaultSnippetFields(args: any): ("input" | "output" | "error")[] {
  if (args.include_snippets?.length) return Array.from(new Set(args.include_snippets))
  if (args.input_like) return ["input"]
  if (args.output_like) return ["output"]
  if (args.error_like || args.status === "error") return ["error"]
  return []
}

function centered(value: string | null, needle?: string): string | null {
  if (!value) return null
  return needle ? snippet(value, needle, 240).value : value
}
