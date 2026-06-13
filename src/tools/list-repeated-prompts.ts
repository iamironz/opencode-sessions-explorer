/**
 * opencode-sessions-explorer-list-repeated-prompts
 *
 * Cluster sessions whose first user-prompt shares the same normalized prefix.
 * Useful for finding "I've asked this before" patterns.
 * Cap: 48 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { truncateString } from "../lib/truncate.js"
import { normalizePrompt } from "../lib/channel.js"
import { table } from "../lib/table.js"

export const listRepeatedPrompts = tool({
  description:
    "opencode-sessions-explorer: cluster OpenCode sessions by the prefix of their FIRST USER PROMPT, surfacing repeated patterns. " +
    "Answers: \"have I asked this question before\", \"my most repeated prompts\", \"common patterns in what I ask OpenCode\", \"cluster my prompts to find duplicates\", \"what do I tend to start sessions with\", \"top recurring prompt templates\", \"how often do I ask about the same thing\". " +
    "Methodology: for each session, takes the first user message → concatenates its text parts → normalizes (lowercase, collapse whitespace) → takes the first `prefix_chars` characters (default 80) as the cluster key → groups sessions sharing that prefix → returns clusters with count >= min_count (default 2). " +
    "Each cluster: prefix, count, first_ts, last_ts, total_cost, session_ids[], samples[] (sample_per_group full prompt previews). " +
    "Use this for usage-analysis questions. For exact content search across all session bodies use search-text.",
  args: {
    since_ms: tool.schema.number().int().nonnegative().optional(),
    until_ms: tool.schema.number().int().nonnegative().optional(),
    min_count: tool.schema.number().int().min(2).default(3),
    prefix_chars: tool.schema.number().int().min(20).max(512).default(80).describe("Prefix length defining the cluster (clamped 20..512)"),
    archived: tool.schema.enum(["no", "only", "any"]).default("no"),
    limit: tool.schema.number().int().min(1).max(50).default(20),
    sample_per_group: tool.schema.number().int().min(1).max(5).default(2),
  },
  async execute(args) {
    return runWithEnvelope("list_repeated_prompts", 48, async () => {
      const where: string[] = ["json_extract(m.data,'$.role') = 'user'"]
      const params: any[] = []
      if (args.since_ms !== undefined) { where.push("s.time_created >= ?"); params.push(args.since_ms) }
      if (args.until_ms !== undefined) { where.push("s.time_created <= ?"); params.push(args.until_ms) }
      if (args.archived === "no") where.push("s.time_archived IS NULL")
      else if (args.archived === "only") where.push("s.time_archived IS NOT NULL")

      // Get first user message per session
      const rows = stmt(`
        WITH first_user AS (
          SELECT m.session_id, MIN(m.time_created) AS first_ts, MIN(m.id) AS first_msg
            FROM message m
            JOIN session s ON s.id = m.session_id
           WHERE ${where.join(" AND ")}
        GROUP BY m.session_id
        )
        SELECT fu.session_id, fu.first_ts, s.title, s.cost,
               (SELECT GROUP_CONCAT(COALESCE(json_extract(p.data,'$.text'), ''), ' ')
                  FROM part p
                 WHERE p.message_id = (SELECT id FROM message
                                        WHERE session_id = fu.session_id
                                          AND json_extract(data,'$.role') = 'user'
                                        ORDER BY time_created, id
                                        LIMIT 1)
                   AND json_extract(p.data,'$.type') = 'text') AS prompt_text
          FROM first_user fu
          JOIN session s ON s.id = fu.session_id
      `).all(...params) as { session_id: string; first_ts: number; title: string; cost: number; prompt_text: string | null }[]

      // Normalize + cluster in TS
      const clusters = new Map<string, { prefix: string; sessions: { id: string; title: string; ts: number; cost: number; sample: string }[] }>()
      for (const r of rows) {
        if (!r.prompt_text) continue
        const normalized = normalizePrompt(r.prompt_text)
        if (!normalized) continue
        const prefix = normalized.slice(0, args.prefix_chars)
        const c = clusters.get(prefix) ?? { prefix, sessions: [] }
        c.sessions.push({ id: r.session_id, title: r.title, ts: r.first_ts, cost: Number(r.cost ?? 0), sample: truncateString(r.prompt_text, 200).value })
        clusters.set(prefix, c)
      }
      const out = Array.from(clusters.values())
        .filter((c) => c.sessions.length >= args.min_count)
        .sort((a, b) => b.sessions.length - a.sessions.length)
        .slice(0, args.limit)
        .map((c) => ({
          prefix: c.prefix,
          count: c.sessions.length,
          first_ts: Math.min(...c.sessions.map((s) => s.ts)),
          last_ts: Math.max(...c.sessions.map((s) => s.ts)),
          total_cost: c.sessions.reduce((a, s) => a + s.cost, 0),
          session_ids: c.sessions.slice(0, 50).map((s) => s.id),
          samples: c.sessions.slice(0, args.sample_per_group).map((s) => ({ session_id: s.id, title: s.title, ts: s.ts, prompt: s.sample })),
        }))
      return { clusters: table(out), scanned: rows.length, total_clusters: out.length }
    })
  },
})
