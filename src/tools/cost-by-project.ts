/**
 * opencode-sessions-explorer-cost-by-project
 *
 * Aggregate cost + tokens grouped by project_id / directory / agent / model.
 * Pre-`session_usage`-migration sessions have cost=0; we surface `cost_known:false`
 * per group when ALL its sessions are pre-migration.
 */
import { stmt } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { table } from "../lib/table.js"
import { defineTool } from "../lib/tool-v2.js"

export const costByProject = defineTool<{
  group_by: "project_id" | "directory" | "agent" | "model"
  since_ms?: number
  until_ms?: number
  archived: "no" | "only" | "any"
  min_cost: number
  min_tokens: number
  top: number
}>({
  name: "opencode-sessions-explorer-cost-by-project",
  description:
    "opencode-sessions-explorer: aggregate OpenCode cost + token usage across sessions, grouped by project, directory, agent, or model. " +
    "Answers: \"how much have I spent on OpenCode\", \"what's my OpenCode API spend by project\", \"cost breakdown by agent\", \"which directory burned the most tokens\", \"Claude Opus vs GPT cost comparison\", \"my biggest spending categories\", \"billing summary\", \"token usage by agent\", \"which model is most expensive for me\", \"OpenCode cost audit\". " +
    "group_by: 'project_id' (default), 'directory', 'agent', or 'model' (uses decoded session.model.id). " +
    "Returns: groups array (each: key, sessions count, cost, tokens.{input,output,reasoning,cache_read,cache_write}, cost_known flag) sorted by cost descending, plus a total summary. Optional since_ms/until_ms time window. " +
    "cost_known is false when ALL sessions in a group predate the session_usage migration — their `cost` column reads as 0 but isn't actually $0. " +
    "For TIME-SERIES (cost over time per period) use cost-by-period instead.",
  args: {
    type: "object",
    properties: {
      group_by: { type: "string", enum: ["project_id", "directory", "agent", "model"], default: "project_id" },
      since_ms: { type: "integer", minimum: 0 },
      until_ms: { type: "integer", minimum: 0 },
      archived: { type: "string", enum: ["no", "only", "any"], default: "any" },
      min_cost: { type: "number", minimum: 0, default: 0.001, description: "Hide groups below this USD cost by default" },
      min_tokens: { type: "integer", minimum: 0, default: 0, description: "Hide groups below this input+output token count" },
      top: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
    required: [],
  },
  async execute(args) {
    return runWithEnvelope("cost_by_project", 32, async () => {
      const where: string[] = []
      const params: any[] = []
      if (args.since_ms !== undefined) { where.push("time_created >= ?"); params.push(args.since_ms) }
      if (args.until_ms !== undefined) { where.push("time_created <= ?"); params.push(args.until_ms) }
      if (args.archived === "no") where.push("time_archived IS NULL")
      else if (args.archived === "only") where.push("time_archived IS NOT NULL")
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : ""

      const keyExpr =
        args.group_by === "model" ? "COALESCE(json_extract(model,'$.id'), 'unknown')" :
        args.group_by === "directory" ? "directory" :
        args.group_by === "agent" ? "COALESCE(agent, 'unknown')" :
        "project_id"

      const having: string[] = []
      if (args.min_cost > 0) having.push("SUM(cost) >= ?")
      if (args.min_tokens > 0) having.push("(SUM(tokens_input) + SUM(tokens_output)) >= ?")
      // NOTE: alias must not be `key` — SQLite 3.53 mis-groups json_extract
      // expressions aliased as `key` (keyword collision); `grp` is safe.
      const sql = `
        SELECT ${keyExpr} AS grp,
               COUNT(*) AS sessions,
               ROUND(SUM(cost), 6) AS cost,
               SUM(tokens_input) AS tokens_input,
               SUM(tokens_output) AS tokens_output,
               SUM(tokens_reasoning) AS tokens_reasoning,
               SUM(tokens_cache_read) AS tokens_cache_read,
               SUM(tokens_cache_write) AS tokens_cache_write,
               SUM(CASE WHEN cost > 0 OR tokens_input > 0 THEN 1 ELSE 0 END) AS known_count,
               MIN(time_created) AS first_ts,
               MAX(time_updated) AS last_ts
          FROM session_v2
          ${whereSql}
       GROUP BY grp
       ${having.length ? "HAVING " + having.join(" AND ") : ""}
       ORDER BY cost DESC
          LIMIT ?`
      if (args.min_cost > 0) params.push(args.min_cost)
      if (args.min_tokens > 0) params.push(args.min_tokens)
      params.push(args.top)
      const rows = stmt(sql).all(...params) as any[]

      const records = rows.map((r) => ({
        key: r.grp,
        sessions: Number(r.sessions),
        cost: Number(r.cost ?? 0),
        cost_known: Number(r.known_count) > 0,
        tokens_input: Number(r.tokens_input ?? 0),
        tokens_output: Number(r.tokens_output ?? 0),
        tokens_reasoning: Number(r.tokens_reasoning ?? 0),
        tokens_cache_read: Number(r.tokens_cache_read ?? 0),
        tokens_cache_write: Number(r.tokens_cache_write ?? 0),
        first_ts: Number(r.first_ts),
        last_ts: Number(r.last_ts),
      }))

      const totalSessions = records.reduce((a, g) => a + g.sessions, 0)
      const total = {
        sessions: totalSessions,
        cost: Number(records.reduce((a, g) => a + g.cost, 0).toFixed(6)),
        tokens_input: records.reduce((a, g) => a + g.tokens_input, 0),
        tokens_output: records.reduce((a, g) => a + g.tokens_output, 0),
        cost_known_pct: totalSessions === 0 ? 0 : Number((records.reduce((a, g) => a + (g.cost_known ? g.sessions : 0), 0) / totalSessions).toFixed(4)),
      }
      return { group_by: args.group_by, filters: { min_cost: args.min_cost, min_tokens: args.min_tokens }, groups: table(records), total }
    })
  },
})
