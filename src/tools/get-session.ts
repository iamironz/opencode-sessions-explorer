/**
 * opencode-sessions-explorer-get-session
 *
 * Fetch one session with metadata + counts + tool-call-status breakdown
 * + immediate child session ids. Does NOT return message bodies (use
 * session_timeline, get_message, or get_part for content).
 *
 * V2: parts are INLINE in `session_message.data.content[]`; counts are
 * computed via json_each over the content arrays (plus user/system/synthetic
 * text messages and compaction markers, which map onto V1 part semantics).
 *
 * Cap: 16 KB.
 */
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodeModel } from "../lib/decode.js"
import { defineTool } from "../lib/tool-v2.js"

export const getSession = defineTool<{ session_id: string }>({
  name: "opencode-sessions-explorer-get-session",
  description:
    "opencode-sessions-explorer: fetch ONE specific OpenCode session's metadata and aggregate counts when you have a session id. " +
    "Answers: \"tell me about session ses_XYZ\", \"metadata for ses_X\", \"how many messages/parts in session ses_Y\", \"what was the cost and token usage of ses_Z\", \"who is the parent of session ses_X\", \"what child sessions did ses_X spawn\", \"quick info about a session id\". " +
    "Returns: full session row (id, title, project_id, parent_id, directory, agent, model, cost, tokens, timestamps, archived flag), message_count, part_count, parts grouped by type (text/tool/reasoning/compaction), tool-call status breakdown (completed/error/running/pending), and immediate child_session_ids. " +
    "NOT a transcript — for actual conversation content use session-timeline (events) or session-summary (overview) or get-message/get-part for specific bodies.",
  args: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session ID (e.g. 'ses_…')" },
    },
    required: ["session_id"],
  },
  async execute(args) {
    return runWithEnvelope("get_session", 16, async () => {
      const row = stmt(`
        SELECT id, project_id, parent_id, directory, title, slug, version, share_url,
               agent, model, cost,
               tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
               time_created, time_updated, time_archived, time_compacting,
               workspace_id, path
          FROM session_v2 WHERE id = ?
      `).get(args.session_id) as any
      if (!row) fail("NOT_FOUND", `session not found: ${args.session_id}`)

      const messageCount = (stmt(`SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?`).get(args.session_id) as any)?.n ?? 0

      // V2 parts = assistant content items + synthesized user/system/synthetic
      // text parts + compaction markers (see lib/v2-parts.ts).
      const partByType = stmt(`
        SELECT t, COUNT(*) AS n FROM (
          SELECT json_extract(je.value,'$.type') AS t
            FROM session_message sm, json_each(sm.data,'$.content') je
           WHERE sm.session_id = ? AND sm.type = 'assistant'
          UNION ALL
          SELECT 'text' AS t
            FROM session_message
           WHERE session_id = ? AND type IN ('user','system','synthetic')
             AND trim(COALESCE(json_extract(data,'$.text'),'')) != ''
          UNION ALL
          SELECT 'compaction' AS t
            FROM session_message
           WHERE session_id = ? AND type = 'compaction'
        ) GROUP BY t
      `).all(args.session_id, args.session_id, args.session_id) as { t: string | null; n: number }[]

      const toolCallCounts = stmt(`
        SELECT json_extract(je.value,'$.state.status') AS s, COUNT(*) AS n
          FROM session_message sm, json_each(sm.data,'$.content') je
         WHERE sm.session_id = ? AND sm.type = 'assistant'
           AND json_extract(je.value,'$.type') = 'tool'
      GROUP BY s
      `).all(args.session_id) as { s: string | null; n: number }[]

      const children = stmt(`SELECT id, title FROM session_v2 WHERE parent_id = ? ORDER BY time_created DESC LIMIT 50`).all(args.session_id) as { id: string; title: string }[]

      const partsByType = Object.fromEntries(partByType.map((r) => [r.t ?? "unknown", Number(r.n)]))
      const partCount = Object.values(partsByType).reduce((a, b) => a + b, 0)

      return {
        session: {
          id: row.id,
          project_id: row.project_id,
          parent_id: row.parent_id,
          directory: row.directory,
          title: row.title,
          slug: row.slug,
          version: row.version,
          share_url: row.share_url,
          agent: row.agent,
          model: decodeModel(row.model),
          time_created: row.time_created,
          time_updated: row.time_updated,
          time_archived: row.time_archived,
          time_compacting: row.time_compacting,
          workspace_id: row.workspace_id,
          archived: row.time_archived != null,
        },
        cost: Number(row.cost ?? 0),
        tokens: {
          input: Number(row.tokens_input ?? 0),
          output: Number(row.tokens_output ?? 0),
          reasoning: Number(row.tokens_reasoning ?? 0),
          cache_read: Number(row.tokens_cache_read ?? 0),
          cache_write: Number(row.tokens_cache_write ?? 0),
        },
        message_count: Number(messageCount),
        part_count: Number(partCount),
        parts_by_type: partsByType,
        tool_call_counts: Object.fromEntries(toolCallCounts.map((r) => [r.s ?? "unknown", Number(r.n)])),
        child_sessions: children,
      }
    })
  },
})
