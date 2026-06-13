/**
 * opencode-sessions-explorer-list-tool-failures
 *
 * Aggregation of tool errors. Group by tool / error-prefix / session.
 * Cap: 48 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { truncateString } from "../lib/truncate.js"
import { normalizeError } from "../lib/channel.js"
import { table } from "../lib/table.js"

export const listToolFailures = tool({
  description:
    "opencode-sessions-explorer: aggregate OpenCode tool failures (errors) — grouped by tool name, error message prefix, or session id. " +
    "Answers: \"which tool fails most often\", \"what errors keep recurring in my OpenCode usage\", \"which sessions have the most failures\", \"most common error messages\", \"top failure patterns by tool\", \"failure frequency analysis\", \"recurring errors across sessions\". " +
    "Pre-filters to status='error' tool parts. Groups by: 'tool' (default — top failing tool names), 'error' (top recurring error message prefixes, length configurable via error_prefix_chars), or 'session' (sessions with the most failures). " +
    "Returns: failures array (each: key, count, first_ts, last_ts, sample_error) sorted by count desc. Optional time window via since_ms/until_ms and tool/error_like sub-filters. " +
    "For individual error tool calls (not aggregated) use search-tool-calls with status='error'.",
  args: {
    tool: tool.schema.string().optional().describe("Restrict to one tool name (supports LIKE wildcards)"),
    error_like: tool.schema.string().optional(),
    since_ms: tool.schema.number().int().nonnegative().optional(),
    until_ms: tool.schema.number().int().nonnegative().optional(),
    archived: tool.schema.enum(["no", "only", "any"]).default("no"),
    group_by: tool.schema.enum(["tool", "error", "session"]).default("tool"),
    limit: tool.schema.number().int().min(1).max(100).default(20),
    error_prefix_chars: tool.schema.number().int().min(20).max(200).default(80).describe("When group_by='error', length of the error prefix that defines a group"),
  },
  async execute(args) {
    return runWithEnvelope("list_tool_failures", 48, async () => {
      const where: string[] = ["json_extract(p.data,'$.type') = 'tool'", "json_extract(p.data,'$.state.status') = 'error'"]
      const params: any[] = []
      if (args.tool) {
        if (/[%_]/.test(args.tool)) { where.push("json_extract(p.data,'$.tool') LIKE ?"); params.push(args.tool) }
        else { where.push("json_extract(p.data,'$.tool') = ?"); params.push(args.tool) }
      }
      if (args.error_like) { where.push("json_extract(p.data,'$.state.error') LIKE ?"); params.push(`%${args.error_like.replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.since_ms !== undefined) { where.push("p.time_created >= ?"); params.push(args.since_ms) }
      if (args.until_ms !== undefined) { where.push("p.time_created <= ?"); params.push(args.until_ms) }
      if (args.archived === "no") where.push("p.session_id IN (SELECT id FROM session WHERE time_archived IS NULL)")
      else if (args.archived === "only") where.push("p.session_id IN (SELECT id FROM session WHERE time_archived IS NOT NULL)")
      const whereSql = where.join(" AND ")

      if (args.group_by === "error") {
        const rows = stmt(`
          SELECT json_extract(p.data,'$.state.error') AS error,
                 p.time_created AS ts
            FROM part p
           WHERE ${whereSql}`).all(...params) as any[]
        const groups = new Map<string, { key: string; count: number; first_ts: number; last_ts: number; sample_error: string }>()
        for (const r of rows) {
          const sample = String(r.error ?? "")
          const key = truncateString(normalizeError(sample), args.error_prefix_chars).value
          const cur = groups.get(key) ?? { key, count: 0, first_ts: Number(r.ts), last_ts: Number(r.ts), sample_error: truncateString(sample, 160).value }
          cur.count++
          cur.first_ts = Math.min(cur.first_ts, Number(r.ts))
          cur.last_ts = Math.max(cur.last_ts, Number(r.ts))
          groups.set(key, cur)
        }
        return {
          group_by: args.group_by,
          failures: table(Array.from(groups.values()).sort((a, b) => b.count - a.count).slice(0, args.limit)),
          total_groups: groups.size,
        }
      }

      let sql: string
      if (args.group_by === "tool") {
        sql = `
          SELECT json_extract(p.data,'$.tool') AS key,
                 COUNT(*) AS count,
                 MIN(p.time_created) AS first_ts,
                 MAX(p.time_created) AS last_ts,
                 substr(MAX(json_extract(p.data,'$.state.error')), 1, 240) AS sample_error
            FROM part p
           WHERE ${whereSql}
        GROUP BY key
        ORDER BY count DESC
           LIMIT ?`
      } else {
        sql = `
          SELECT p.session_id AS key,
                 COUNT(*) AS count,
                 MIN(p.time_created) AS first_ts,
                 MAX(p.time_created) AS last_ts,
                 substr(MAX(json_extract(p.data,'$.state.error')), 1, 240) AS sample_error
            FROM part p
           WHERE ${whereSql}
        GROUP BY key
        ORDER BY count DESC
           LIMIT ?`
      }
      params.push(args.limit)
      const rows = stmt(sql).all(...params) as any[]
      return {
        group_by: args.group_by,
        failures: table(rows.map((r) => ({
          key: r.key,
          count: Number(r.count),
          first_ts: Number(r.first_ts),
          last_ts: Number(r.last_ts),
          sample_error: r.sample_error ?? "",
        }))),
        total_groups: rows.length,
      }
    })
  },
})
