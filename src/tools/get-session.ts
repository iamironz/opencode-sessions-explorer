/**
 * opencode-sessions-explorer-get-session
 *
 * Fetch one session with metadata + counts + tool-call-status breakdown
 * + immediate child session ids. Does NOT return message bodies (use
 * session_timeline, get_message, or get_part for content).
 *
 * Cap: 16 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodeModel } from "../lib/decode.js"

export const getSession = tool({
  description:
    "opencode-sessions-explorer: fetch ONE specific OpenCode session's metadata and aggregate counts when you have a session id. " +
    "Answers: \"tell me about session ses_XYZ\", \"metadata for ses_X\", \"how many messages/parts in session ses_Y\", \"what was the cost and token usage of ses_Z\", \"who is the parent of session ses_X\", \"what child sessions did ses_X spawn\", \"quick info about a session id\". " +
    "Returns: full session row (id, title, project_id, parent_id, directory, agent, model, cost, tokens, timestamps, archived flag), message_count, part_count, parts grouped by type (text/tool/reasoning/patch/file/etc), tool-call status breakdown (completed/error/running/pending), and immediate child_session_ids. " +
    "NOT a transcript — for actual conversation content use session-timeline (events) or session-summary (overview) or get-message/get-part for specific bodies.",
  args: {
    session_id: tool.schema.string().describe("Session ID (e.g. 'ses_…')"),
  },
  async execute(args) {
    return runWithEnvelope("get_session", 16, async () => {
      const row = stmt(`
        SELECT id, project_id, parent_id, directory, title, slug, version, share_url,
               agent, model, cost,
               tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
               time_created, time_updated, time_archived, time_compacting,
               workspace_id, path
          FROM session WHERE id = ?
      `).get(args.session_id) as any
      if (!row) fail("NOT_FOUND", `session not found: ${args.session_id}`)

      const messageCount = (stmt(`SELECT COUNT(*) AS n FROM message WHERE session_id = ?`).get(args.session_id) as any)?.n ?? 0
      const partCount = (stmt(`SELECT COUNT(*) AS n FROM part WHERE session_id = ?`).get(args.session_id) as any)?.n ?? 0

      const partByType = stmt(`
        SELECT json_extract(data,'$.type') AS t, COUNT(*) AS n
          FROM part WHERE session_id = ?
       GROUP BY t
      `).all(args.session_id) as { t: string | null; n: number }[]

      const toolCallCounts = stmt(`
        SELECT json_extract(data,'$.state.status') AS s, COUNT(*) AS n
          FROM part WHERE session_id = ? AND json_extract(data,'$.type') = 'tool'
       GROUP BY s
      `).all(args.session_id) as { s: string | null; n: number }[]

      const children = stmt(`SELECT id, title FROM session WHERE parent_id = ? ORDER BY time_created DESC LIMIT 50`).all(args.session_id) as { id: string; title: string }[]

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
        parts_by_type: Object.fromEntries(partByType.map((r) => [r.t ?? "unknown", Number(r.n)])),
        tool_call_counts: Object.fromEntries(toolCallCounts.map((r) => [r.s ?? "unknown", Number(r.n)])),
        child_sessions: children,
      }
    })
  },
})
