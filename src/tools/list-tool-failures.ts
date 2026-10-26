/**
 * opencode-sessions-explorer-list-tool-failures
 *
 * Aggregation of tool errors. Group by tool / error-prefix / session.
 * Cap: 48 KB.
 *
 * V2: error tool invocations are assistant `data.content[]` items of type
 * 'tool' with `$.state.status = 'error'`; the message is `$.state.error.message`.
 */
import { stmt } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { truncateString } from "../lib/truncate.js"
import { normalizeError } from "../lib/channel.js"
import { table } from "../lib/table.js"
import { defineTool } from "../lib/tool-v2.js"
import { TOOL_FILTER_ALIAS_NOTE, TOOL_GROUP_ALIAS_NOTE, canonicalToolNameSql, toolNameFilter } from "../lib/tool-aliases.js"

const ERROR_EXPR = `COALESCE(json_extract(je.value,'$.state.error.message'), json_extract(je.value,'$.state.error'))`

export const listToolFailures = defineTool<{
  tool?: string
  error_like?: string
  since_ms?: number
  until_ms?: number
  archived: "no" | "only" | "any"
  group_by: "tool" | "error" | "session"
  limit: number
  error_prefix_chars: number
}>({
  name: "opencode-sessions-explorer-list-tool-failures",
  description:
    "opencode-sessions-explorer: aggregate OpenCode tool failures (errors) — grouped by tool name, error message prefix, or session id. " +
    "Answers: \"which tool fails most often\", \"what errors keep recurring in my OpenCode usage\", \"which sessions have the most failures\", \"most common error messages\", \"top failure patterns by tool\", \"failure frequency analysis\", \"recurring errors across sessions\". " +
    "Pre-filters to status='error' tool parts. Groups by: 'tool' (default — top failing tool names), 'error' (top recurring error message prefixes, length configurable via error_prefix_chars), or 'session' (sessions with the most failures). " +
    "Returns: failures array (each: key, count, first_ts, last_ts, sample_error) sorted by count desc. Optional time window via since_ms/until_ms and tool/error_like sub-filters. " +
    "For individual error tool calls (not aggregated) use search-tool-calls with status='error'.",
  args: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Restrict to one tool name (supports LIKE wildcards). " + TOOL_FILTER_ALIAS_NOTE + " " + TOOL_GROUP_ALIAS_NOTE },
      error_like: { type: "string" },
      since_ms: { type: "integer", minimum: 0 },
      until_ms: { type: "integer", minimum: 0 },
      archived: { type: "string", enum: ["no", "only", "any"], default: "no" },
      group_by: { type: "string", enum: ["tool", "error", "session"], default: "tool" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      error_prefix_chars: { type: "integer", minimum: 20, maximum: 200, default: 80, description: "When group_by='error', length of the error prefix that defines a group" },
    },
    required: [],
  },
  async execute(args) {
    return runWithEnvelope("list_tool_failures", 48, async () => {
      const where: string[] = [
        "sm.type = 'assistant'",
        "json_extract(je.value,'$.type') = 'tool'",
        "json_extract(je.value,'$.state.status') = 'error'",
      ]
      const params: any[] = []
      if (args.tool) {
        // Exact names expand over the V1→V2 alias group; LIKE matches the raw name.
        const f = toolNameFilter("json_extract(je.value,'$.name')", args.tool)
        where.push(f.sql); params.push(...f.params)
      }
      if (args.error_like) { where.push(`${ERROR_EXPR} LIKE ?`); params.push(`%${args.error_like.replace(/[%_]/g, m => "\\" + m)}%`) }
      if (args.since_ms !== undefined) { where.push("sm.time_created >= ?"); params.push(args.since_ms) }
      if (args.until_ms !== undefined) { where.push("sm.time_created <= ?"); params.push(args.until_ms) }
      if (args.archived === "no") where.push("sm.session_id IN (SELECT id FROM session_v2 WHERE time_archived IS NULL)")
      else if (args.archived === "only") where.push("sm.session_id IN (SELECT id FROM session_v2 WHERE time_archived IS NOT NULL)")
      const whereSql = where.join(" AND ")

      if (args.group_by === "error") {
        const rows = stmt(`
          SELECT ${ERROR_EXPR} AS error,
                 sm.time_created AS ts
            FROM session_message sm, json_each(sm.data,'$.content') je
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
      // NOTE: alias must not be `key` — SQLite 3.53 mis-groups json_extract
      // expressions aliased as `key` (keyword collision); `grp` is safe.
      if (args.group_by === "tool") {
        // Bucket by the canonical V2 name so V1-era (bash/task) and V2-live
        // (shell/subagent) failures of the same tool merge into one group.
        sql = `
          SELECT ${canonicalToolNameSql("json_extract(je.value,'$.name')")} AS grp,
                 COUNT(*) AS count,
                 MIN(sm.time_created) AS first_ts,
                 MAX(sm.time_created) AS last_ts,
                 substr(MAX(${ERROR_EXPR}), 1, 240) AS sample_error
            FROM session_message sm, json_each(sm.data,'$.content') je
           WHERE ${whereSql}
       GROUP BY grp
       ORDER BY count DESC
          LIMIT ?`
      } else {
        sql = `
          SELECT sm.session_id AS grp,
                 COUNT(*) AS count,
                 MIN(sm.time_created) AS first_ts,
                 MAX(sm.time_created) AS last_ts,
                 substr(MAX(${ERROR_EXPR}), 1, 240) AS sample_error
            FROM session_message sm, json_each(sm.data,'$.content') je
           WHERE ${whereSql}
       GROUP BY grp
       ORDER BY count DESC
          LIMIT ?`
      }
      params.push(args.limit)
      const rows = stmt(sql).all(...params) as any[]
      return {
        group_by: args.group_by,
        failures: table(rows.map((r) => ({
          key: r.grp,
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
