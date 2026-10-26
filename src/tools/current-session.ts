/**
 * opencode-sessions-explorer-current-session
 *
 * Self-introspection: the CURRENT OpenCode session's id, message id, agent,
 * model, directory, worktree, parent_id, cost-so-far, counts of messages/parts/
 * tool-calls done in THIS session, and filesystem paths (db, export tree,
 * this-session's export dir + meta.json).
 *
 * The LLM has no native way to know its own session_id; this tool reads it
 * from the OpenCode ToolContext and enriches with DB state.
 *
 * V2 ToolContext carries sessionID/messageID/agent (+ abort signal) but NO
 * directory/worktree — the plugin entry captures the location directory at
 * setup time (`lib/tool-v2.ts` getHostDirectory()); worktree is reported as
 * an empty string.
 */
import { stmt, locateDb } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { decodeModel } from "../lib/decode.js"
import { exportRoot } from "../lib/export.js"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { getHostDirectory, type HostToolContext } from "../lib/tool-v2.js"
import { defineTool } from "../lib/tool-v2.js"
import { canonicalToolNameSql } from "../lib/tool-aliases.js"

export const currentSession = defineTool<{
  detail: "compact" | "full"
  include_suggestions: boolean
} & Record<string, unknown>>({
  name: "opencode-sessions-explorer-current-session",
  description:
    "opencode-sessions-explorer: identify the CURRENT OpenCode session you (the assistant) are running in — return this session's id, message id, agent, model, directory, parent_id, cost-so-far, message/part/tool-call counters, immediate child sessions, and useful filesystem paths (opencode.db, the opencode-sessions-explorer tree, this session's export subdirectory and meta.json). " +
    "Answers: \"what session am I in\", \"what's my current session id\", \"tell me about this session\", \"who am I (which agent/model)\", \"where am I (directory/worktree)\", \"my session context\", \"this session's metadata\", \"first-call orientation\", \"self-introspection\", \"what's the OpenCode db path\", \"where is the export tree\", \"what's my session id so I can pass it to other opencode-sessions-explorer-* tools\". " +
    "Useful as the FIRST opencode-sessions-explorer-* call when you need to know your own context — e.g. to then feed your own session_id into session-timeline, session-genealogy, grep-session, or to compare against siblings via list-sessions / search-sessions-meta. " +
    "Default detail is compact to avoid noise. Pass detail:'full' for counters, child sessions, paths, and suggestions. " +
    "Takes no args. Cap 8 KB.",
  args: {
    type: "object",
    properties: {
      detail: { type: "string", enum: ["compact", "full"], default: "compact", description: "compact returns orientation only; full includes counters, children, paths, and suggestions" },
      include_suggestions: { type: "boolean", default: false, description: "Include suggested follow-up tool calls" },
    },
    required: [],
  },
  async execute(args, ctx) {
    return runWithEnvelope("current_session", 8, async () => {
      const c = (ctx ?? {}) as HostToolContext
      const sessionId: string = String(c.sessionID ?? "")
      const messageId: string = String(c.messageID ?? "")
      const agent: string = String(c.agent ?? "")
      const directory: string = getHostDirectory()
      const worktree: string = ""

      const root = exportRoot()
      const sessionDir = sessionId ? join(root, "by-session", sessionId) : null
      const sessionMeta = sessionDir ? join(sessionDir, "meta.json") : null
      const dbPath = safe(() => locateDb())

      // Session row (may be missing on very first tool call before OpenCode flushes the session row)
      let sessionRow: any = null
      if (sessionId) {
        sessionRow = stmt(`
          SELECT id, project_id, parent_id, slug, directory, title, agent, model, cost,
                 tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                 time_created, time_updated, time_archived, share_url, workspace_id, version
            FROM session_v2 WHERE id = ?`).get(sessionId) as any
      }

      // Build response
      const session = sessionRow
        ? {
            id: sessionRow.id,
            project_id: sessionRow.project_id,
            parent_id: sessionRow.parent_id,
            slug: sessionRow.slug,
            directory: sessionRow.directory,
            title: sessionRow.title,
            version: sessionRow.version,
            share_url: sessionRow.share_url ?? null,
            workspace_id: sessionRow.workspace_id ?? null,
            agent: sessionRow.agent,
            model: decodeModel(sessionRow.model),
            cost: Number(sessionRow.cost ?? 0),
            tokens: {
              input: Number(sessionRow.tokens_input ?? 0),
              output: Number(sessionRow.tokens_output ?? 0),
              reasoning: Number(sessionRow.tokens_reasoning ?? 0),
              cache_read: Number(sessionRow.tokens_cache_read ?? 0),
              cache_write: Number(sessionRow.tokens_cache_write ?? 0),
            },
            time_created: Number(sessionRow.time_created),
            time_updated: Number(sessionRow.time_updated),
            time_archived: sessionRow.time_archived ?? null,
            archived: sessionRow.time_archived != null,
            duration_ms: Math.max(0, Number(sessionRow.time_updated) - Number(sessionRow.time_created)),
          }
        : null

      const suggestions = sessionId && (args.detail === "full" || args.include_suggestions)
        ? [
            { use: "opencode-sessions-explorer-session-timeline", purpose: "walk this session chronologically", args: { session_id: sessionId } },
            { use: "opencode-sessions-explorer-session-summary", purpose: "summarize what happened in this session", args: { session_id: sessionId } },
            { use: "opencode-sessions-explorer-session-genealogy", purpose: "show ancestors and descendants of this session", args: { session_id: sessionId, direction: "both" } },
            { use: "opencode-sessions-explorer-grep-session", purpose: "regex search inside this session", args: { session_id: sessionId, pattern: "<query>" } },
            { use: "opencode-sessions-explorer-search-tool-calls", purpose: "find tool calls in this session", args: { session_id: sessionId } },
          ]
        : []

      const compact = {
        context: {
          session_id: sessionId || null,
          message_id: messageId || null,
          agent,
          directory,
          worktree,
        },
        session,
      }
      if (args.detail !== "full") return { ...compact, suggestions }

      // Full detail only: counters and relationship lookups can be expensive on huge sessions.
      const msgCount = sessionId ? Number((stmt(`SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?`).get(sessionId) as any)?.n ?? 0) : 0
      const partCountRow = sessionId
        ? (stmt(`
            SELECT (SELECT COUNT(*) FROM session_message sm, json_each(sm.data,'$.content') je
                     WHERE sm.session_id = ? AND sm.type = 'assistant'
                       AND json_extract(je.value,'$.type') IN ('text','reasoning','tool')) AS content_parts,
                   (SELECT COUNT(*) FROM session_message
                     WHERE session_id = ? AND type IN ('user','system','synthetic')
                       AND trim(COALESCE(json_extract(data,'$.text'),'')) != '') AS text_msgs,
                   (SELECT COUNT(*) FROM session_message
                     WHERE session_id = ? AND type = 'compaction') AS compactions
          `).get(sessionId, sessionId, sessionId) as any)
        : null
      const partCount = partCountRow ? Number(partCountRow.content_parts) + Number(partCountRow.text_msgs) + Number(partCountRow.compactions) : 0
      // Per-tool counters keyed by the canonical V2 name (bash→shell, task→subagent).
      const toolStats = sessionId
        ? (stmt(`
            SELECT ${canonicalToolNameSql("json_extract(je.value,'$.name')")} AS tool,
                   json_extract(je.value,'$.state.status') AS status,
                   COUNT(*) AS n
              FROM session_message sm, json_each(sm.data,'$.content') je
             WHERE sm.session_id = ? AND sm.type = 'assistant'
               AND json_extract(je.value,'$.type') = 'tool'
          GROUP BY tool, status
          ORDER BY n DESC`).all(sessionId) as any[])
        : []
      const toolsSummary: Record<string, { total: number; completed: number; error: number; running: number; pending: number }> = {}
      for (const r of toolStats) {
        const t = String(r.tool ?? "unknown")
        const s = String(r.status ?? "unknown") as "completed" | "error" | "running" | "pending"
        const entry = (toolsSummary[t] ??= { total: 0, completed: 0, error: 0, running: 0, pending: 0 })
        entry.total += Number(r.n)
        if (s in entry) (entry as any)[s] += Number(r.n)
      }
      const children = sessionId
        ? (stmt(`SELECT id, title, agent, time_created FROM session_v2 WHERE parent_id = ? ORDER BY time_created DESC LIMIT 20`).all(sessionId) as any[])
        : []
      let parent: any = null
      if (sessionRow?.parent_id) {
        parent = stmt(`SELECT id, title, agent FROM session_v2 WHERE id = ?`).get(sessionRow.parent_id) as any
      }

      return {
        ...compact,
        parent_session: parent,
        children_sessions: children,
        counters: {
          messages_so_far: msgCount,
          parts_so_far: partCount,
          tools_by_name: toolsSummary,
        },
        paths: {
          db: dbPath ?? null,
          export_root: root,
          this_session_export_dir: sessionDir,
          this_session_export_dir_exists: sessionDir ? existsSync(sessionDir) : false,
          this_session_meta_json: sessionMeta,
          this_session_meta_json_exists: sessionMeta ? existsSync(sessionMeta) : false,
          tool_output_dir: dbPath ? join(dirname(dbPath), "tool-output") : null,
        },
        suggestions,
      }
    })
  },
})

function safe<T>(fn: () => T): T | null {
  try { return fn() } catch { return null }
}
