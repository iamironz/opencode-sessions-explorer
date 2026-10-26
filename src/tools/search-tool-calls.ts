/**
 * opencode-sessions-explorer-search-tool-calls
 *
 * Filter tool invocations by tool name, status, input/output/error substring,
 * project, session, time. Newest-first. Cap: 160 KB.
 *
 * V2: tool invocations are assistant `data.content[]` items of type 'tool'
 * (`$.name`, `$.state.status`, `$.state.input`, `$.state.content[]` output,
 * `$.state.error{type,message}`). Part ids are synthesized
 * `<messageId>#<contentIndex>` via `json_each().key`.
 */
import { stmt } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { decodeCursor, encodeCursor } from "../lib/pagination.js"
import { snippet } from "../lib/truncate.js"
import { table } from "../lib/table.js"
import { defineTool } from "../lib/tool-v2.js"
import { TOOL_FILTER_ALIAS_NOTE, toolNameFilter } from "../lib/tool-aliases.js"

/** V2 tool outputs: state.content[] text items, else legacy metadata.output. */
const OUTPUT_EXPR = `COALESCE((SELECT group_concat(json_extract(oc.value,'$.text'), char(10)) FROM json_each(je.value,'$.state.content') oc), json_extract(je.value,'$.state.metadata.output'))`
/** V2 tool errors are {type,message} objects; legacy parts used plain strings. */
const ERROR_EXPR = `COALESCE(json_extract(je.value,'$.state.error.message'), json_extract(je.value,'$.state.error'))`

export const searchToolCalls = defineTool<{
  tool?: string
  status: "pending" | "running" | "completed" | "error" | "any"
  input_like?: string
  output_like?: string
  error_like?: string
  include_snippets?: readonly ("input" | "output" | "error")[]
  session_id?: string
  project_id?: string
  since_ms?: number
  until_ms?: number
  archived: "no" | "only" | "any"
  limit: number
  cursor?: string
}>({
  name: "opencode-sessions-explorer-search-tool-calls",
  description:
    "opencode-sessions-explorer: find OpenCode tool invocations across all sessions, filtered by tool name, status, or substring on input/output/error. " +
    "Answers: \"find every time I ran git push\", \"all bash commands I ran touching file X\", \"every read tool that errored\", \"all my Jira MCP calls\" (with `tool:'mcp-atlassian_jira_%'` LIKE wildcard), \"every webfetch call to github.com\", \"when did apply_patch fail recently\", \"all tool calls in session ses_X\", \"any currently-running tool calls\". " +
    "Filters: tool (exact match OR LIKE wildcard if it contains % or _), status ('completed'/'error'/'running'/'pending'/'any'), input_like (substring on JSON-stringified $.state.input), output_like (substring on $.state.output), error_like (substring on $.state.error), session_id, project_id, since_ms/until_ms, archived. " +
    "Returns: tool calls with part_id, session_id, tool name, status, duration_ms, and capped snippets (240 chars) of input/output/error. Cursor pagination, newest-first.",
  args: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Exact tool name (e.g. 'read', 'shell'). Supports SQL LIKE wildcards if it contains % or _. " + TOOL_FILTER_ALIAS_NOTE },
      status: { type: "string", enum: ["pending", "running", "completed", "error", "any"], default: "any" },
      input_like: { type: "string", description: "Substring in JSON-stringified tool input" },
      output_like: { type: "string" },
      error_like: { type: "string" },
      include_snippets: { type: "array", items: { type: "string", enum: ["input", "output", "error"] }, description: "Which snippet fields to include. Defaults to the matched dimension, or error for status=error." },
      session_id: { type: "string" },
      project_id: { type: "string" },
      since_ms: { type: "integer", minimum: 0 },
      until_ms: { type: "integer", minimum: 0 },
      archived: { type: "string", enum: ["no", "only", "any"], default: "no" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      cursor: { type: "string" },
    },
    required: [],
  },
  async execute(args) {
    return runWithEnvelope("search_tool_calls", 160, async (ctx) => {
      const where: string[] = ["sm.type = 'assistant'", "json_extract(je.value,'$.type') = 'tool'"]
      const params: any[] = []
      if (args.tool) {
        // Exact names expand over the V1→V2 alias group (bash/shell, task/subagent);
        // LIKE patterns match the raw name. Rows keep the raw recorded name.
        const f = toolNameFilter("json_extract(je.value,'$.name')", args.tool)
        where.push(f.sql); params.push(...f.params)
      }
      if (args.status !== "any") { where.push("json_extract(je.value,'$.state.status') = ?"); params.push(args.status) }
      if (args.input_like) { where.push("json_extract(je.value,'$.state.input') LIKE ?"); params.push(`%${args.input_like.replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.output_like) { where.push(`${OUTPUT_EXPR} LIKE ?`); params.push(`%${args.output_like.replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.error_like) { where.push(`${ERROR_EXPR} LIKE ?`); params.push(`%${args.error_like.replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.session_id) { where.push("sm.session_id = ?"); params.push(args.session_id) }
      if (args.project_id) { where.push("sm.session_id IN (SELECT id FROM session_v2 WHERE project_id = ?)"); params.push(args.project_id) }
      if (args.since_ms !== undefined) { where.push("sm.time_created >= ?"); params.push(args.since_ms) }
      if (args.until_ms !== undefined) { where.push("sm.time_created <= ?"); params.push(args.until_ms) }
      if (args.archived === "no") where.push("sm.session_id IN (SELECT id FROM session_v2 WHERE time_archived IS NULL)")
      else if (args.archived === "only") where.push("sm.session_id IN (SELECT id FROM session_v2 WHERE time_archived IS NOT NULL)")
      const cursor = decodeCursor(args.cursor)
      if (cursor) {
        where.push("(sm.time_created < ? OR (sm.time_created = ? AND (sm.id || '#' || je.key) < ?))")
        params.push(cursor.ts, cursor.ts, cursor.id)
      }
      const sql = `
        SELECT sm.id || '#' || je.key AS part_id, sm.session_id, sm.id AS message_id, sm.time_created,
               json_extract(je.value,'$.name') AS tool,
               json_extract(je.value,'$.state.status') AS status,
               substr(COALESCE(${ERROR_EXPR},''), 1, 240) AS error_snippet,
               substr(COALESCE(${OUTPUT_EXPR},''), 1, 240) AS output_snippet,
               substr(COALESCE(json_extract(je.value,'$.state.input'),''), 1, 240) AS input_snippet,
               json_extract(je.value,'$.time.created') AS t_start,
               json_extract(je.value,'$.time.completed') AS t_end
          FROM session_message sm, json_each(sm.data,'$.content') je
         WHERE ${where.join(" AND ")}
      ORDER BY sm.time_created DESC, part_id DESC
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
