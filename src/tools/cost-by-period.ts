/**
 * opencode-sessions-explorer-cost-by-period
 *
 * Time-bucketed cost + tokens. Buckets in UTC; optional `tz_offset_min`
 * to shift bucket boundaries (e.g. for "my day"). Cap: 32 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { table } from "../lib/table.js"

export const costByPeriod = tool({
  description:
    "opencode-sessions-explorer: time-series OpenCode cost + tokens, bucketed by day, week, or month. " +
    "Answers: \"how much did I spend each day this week\", \"my OpenCode cost trend\", \"weekly token usage chart\", \"monthly spend over the last quarter\", \"daily activity by cost\", \"how has my OpenCode usage changed over time\", \"spend per period\", \"which day did I burn the most tokens\". " +
    "bucket: 'day' (default), 'week', or 'month'. UTC bucket boundaries by default; pass tz_offset_min (positive = ahead of UTC) to shift to your local day (e.g. 120 for UTC+2). " +
    "Returns: buckets array (each: period string, sessions count, cost, tokens) newest-first, plus a total summary. Optional project_id/agent filters for scoping. " +
    "For NON-TIME-SERIES grouping (by project/agent/model regardless of time) use cost-by-project instead.",
  args: {
    bucket: tool.schema.enum(["day", "week", "month"]).default("day"),
    since_ms: tool.schema.number().int().nonnegative().optional(),
    until_ms: tool.schema.number().int().nonnegative().optional(),
    project_id: tool.schema.string().optional(),
    agent: tool.schema.string().optional(),
    tz_offset_min: tool.schema.number().int().min(-720).max(840).default(0).describe("Bucket boundary offset in minutes (e.g. 60 for UTC+1)"),
    archived: tool.schema.enum(["no", "only", "any"]).default("any"),
    min_cost: tool.schema.number().nonnegative().default(0).describe("Hide buckets below this USD cost"),
    include_zero_buckets: tool.schema.boolean().default(false).describe("Include buckets where both cost and tokens are zero, usually pre-usage-migration data"),
    max_buckets: tool.schema.number().int().min(1).max(366).default(60),
  },
  async execute(args) {
    return runWithEnvelope("cost_by_period", 32, async () => {
      const where: string[] = []
      const params: any[] = []
      if (args.since_ms !== undefined) { where.push("time_created >= ?"); params.push(args.since_ms) }
      if (args.until_ms !== undefined) { where.push("time_created <= ?"); params.push(args.until_ms) }
      if (args.project_id) { where.push("project_id = ?"); params.push(args.project_id) }
      if (args.agent) { where.push("agent = ?"); params.push(args.agent) }
      if (args.archived === "no") where.push("time_archived IS NULL")
      else if (args.archived === "only") where.push("time_archived IS NOT NULL")
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : ""

      // SQLite: time_created is ms epoch. Apply tz offset, then strftime in seconds since epoch.
      // Resulting expression: '%Y-%m-%d' for day, '%Y-W%W' for week, '%Y-%m' for month.
      const offsetMs = args.tz_offset_min * 60_000
      const fmt =
        args.bucket === "day" ? "%Y-%m-%d" :
        args.bucket === "week" ? "%Y-W%W" :
        "%Y-%m"

      const having: string[] = []
      if (!args.include_zero_buckets) having.push("(SUM(tokens_input) > 0 OR SUM(cost) > 0)")
      if (args.min_cost > 0) having.push("SUM(cost) >= ?")
      const sql = `
        SELECT strftime('${fmt}', (time_created + ${offsetMs}) / 1000, 'unixepoch') AS period,
               COUNT(*) AS sessions,
               ROUND(SUM(cost), 6) AS cost,
               SUM(tokens_input) AS tokens_input,
               SUM(tokens_output) AS tokens_output,
               SUM(tokens_reasoning) AS tokens_reasoning
          FROM session
          ${whereSql}
       GROUP BY period
       ${having.length ? "HAVING " + having.join(" AND ") : ""}
       ORDER BY period DESC
          LIMIT ?`
      if (args.min_cost > 0) params.push(args.min_cost)
      params.push(args.max_buckets)
      const rows = stmt(sql).all(...params) as any[]

      const records = rows.map((r) => ({
        period: r.period,
        sessions: Number(r.sessions),
        cost: Number(r.cost ?? 0),
        tokens_input: Number(r.tokens_input ?? 0),
        tokens_output: Number(r.tokens_output ?? 0),
        tokens_reasoning: Number(r.tokens_reasoning ?? 0),
      }))
      const total = {
        sessions: records.reduce((a, b) => a + b.sessions, 0),
        cost: Number(records.reduce((a, b) => a + b.cost, 0).toFixed(6)),
        tokens_input: records.reduce((a, b) => a + b.tokens_input, 0),
        tokens_output: records.reduce((a, b) => a + b.tokens_output, 0),
      }
      return { bucket: args.bucket, tz_offset_min: args.tz_offset_min, filters: { min_cost: args.min_cost, include_zero_buckets: args.include_zero_buckets }, buckets: table(records), total }
    })
  },
})
