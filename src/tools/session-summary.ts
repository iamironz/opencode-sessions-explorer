/**
 * opencode-sessions-explorer-session-summary
 *
 * Headline numbers + first/last user prompt + top files touched + top tools used
 * + errors count + duration. Cap: 32 KB.
 *
 * V2: user prompts are `session_message` rows of type 'user' (`data.text`);
 * tool stats come from json_each over assistant `data.content[]`; file paths
 * from tool inputs — both the legacy `filePath` key and the V2 `path` key
 * (V2 renamed the read/edit/write argument), across the legacy and V2 tool
 * name spellings (`apply_patch` → `patch`).
 */
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodeModel } from "../lib/decode.js"
import { truncateString } from "../lib/truncate.js"
import { compactPath } from "../lib/channel.js"
import { defineTool } from "../lib/tool-v2.js"
import { canonicalToolNameSql } from "../lib/tool-aliases.js"

export const sessionSummary = defineTool<{ session_id: string; max_prompt_bytes: number }>({
  name: "opencode-sessions-explorer-session-summary",
  description:
    "opencode-sessions-explorer: one-call human-readable overview of an OpenCode session. " +
    "Answers: \"summarize session ses_X\", \"what did I work on in ses_Y\", \"give me an overview of ses_Z\", \"TLDR of this session\", \"what was the gist of session ses_W\", \"what files did I touch in ses_X\", \"what tools did I use in ses_Y\". " +
    "Returns: session metadata, first user prompt (truncated to max_prompt_bytes), last user prompt, top files touched (extracted from tool inputs to read/edit/write/apply_patch), top tools used (with completed/error counts), errors_count, duration_ms, cost. " +
    "Best single-call session overview. For event-level chronology use session-timeline; for one specific message use get-message; for raw metadata use get-session.",
  args: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session ID" },
      max_prompt_bytes: { type: "integer", minimum: 64, maximum: 8192, default: 2048, description: "Cap on each user-prompt snippet" },
    },
    required: ["session_id"],
  },
  async execute(args) {
    return runWithEnvelope("session_summary", 32, async () => {
      const session = stmt(`
        SELECT id, project_id, directory, title, agent, model, cost,
               tokens_input, tokens_output, tokens_reasoning,
               time_created, time_updated, time_archived
          FROM session_v2 WHERE id = ?`).get(args.session_id) as any
      if (!session) fail("NOT_FOUND", `session not found: ${args.session_id}`)

      // First/last user prompt (V2: type='user', text lives in data.text).
      const userMsgs = stmt(`
        SELECT id, time_created, json_extract(data,'$.text') AS text
          FROM session_message
         WHERE session_id = ? AND type = 'user'
      ORDER BY seq ASC, id ASC`).all(args.session_id) as { id: string; time_created: number; text: string | null }[]
      const mkPrompt = (m: { text: string | null } | undefined) => {
        if (!m || !m.text || !m.text.trim()) return null
        const tr = truncateString(m.text, args.max_prompt_bytes)
        return { text: tr.value, truncated: tr.truncated, original_bytes: tr.originalBytes }
      }
      const firstPrompt = mkPrompt(userMsgs[0])
      const lastPrompt = userMsgs.length > 1 ? (mkPrompt(userMsgs[userMsgs.length - 1]) ?? firstPrompt) : firstPrompt

      // Top tools used (by count, excluding errors). Grouped by the canonical
      // V2 name so V1-era bash/task and V2-live shell/subagent calls merge.
      const topTools = stmt(`
        SELECT ${canonicalToolNameSql("json_extract(je.value,'$.name')")} AS tool,
               json_extract(je.value,'$.state.status') AS status,
               COUNT(*) AS n
          FROM session_message sm, json_each(sm.data,'$.content') je
         WHERE sm.session_id = ? AND sm.type = 'assistant'
           AND json_extract(je.value,'$.type') = 'tool'
      GROUP BY tool, status`).all(args.session_id) as { tool: string; status: string; n: number }[]

      const toolSummary: Record<string, { total: number; completed: number; error: number }> = {}
      let errorsCount = 0
      for (const r of topTools) {
        const tn = r.tool || "unknown"
        const entry = (toolSummary[tn] ??= { total: 0, completed: 0, error: 0 })
        entry.total += r.n
        if (r.status === "completed") entry.completed += r.n
        if (r.status === "error") { entry.error += r.n; errorsCount += r.n }
      }
      const tools_top = Object.entries(toolSummary)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 10)
        .map(([name, s]) => ({ name, ...s }))

      // Files touched: tool inputs to file tools — legacy `filePath` key and the
      // V2 `path` key, across legacy + V2 tool names (apply_patch → patch).
      const filesTouched = new Map<string, { count: number; score: number }>()
      const addFile = (path: string, weight: number) => {
        const cur = filesTouched.get(path) ?? { count: 0, score: 0 }
        cur.count++
        cur.score += weight
        filesTouched.set(path, cur)
      }
      const fileToolRows = stmt(`
        SELECT COALESCE(json_extract(je.value,'$.state.input.filePath'), json_extract(je.value,'$.state.input.path')) AS fp,
               json_extract(je.value,'$.name') AS tool
          FROM session_message sm, json_each(sm.data,'$.content') je
         WHERE sm.session_id = ? AND sm.type = 'assistant'
           AND json_extract(je.value,'$.type') = 'tool'
           AND json_extract(je.value,'$.name') IN ('read','edit','write','apply_patch','patch')
           AND COALESCE(json_extract(je.value,'$.state.input.filePath'), json_extract(je.value,'$.state.input.path')) IS NOT NULL
         LIMIT 2000`).all(args.session_id) as { fp: string | null; tool: string | null }[]
      for (const { fp, tool } of fileToolRows) {
        if (!fp) continue
        addFile(fp, tool === "read" ? 1 : 2)
      }
      const files_touched_top = Array.from(filesTouched.entries())
        .sort((a, b) => b[1].score - a[1].score || b[1].count - a[1].count)
        .slice(0, 10)
        .map(([path, stats]) => ({ ...compactPath(path, session.directory), count: stats.count, score: stats.score }))

      const cost_known = Number(session.cost) > 0 || Number(session.tokens_input) > 0

      return {
        session: {
          id: session.id,
          project_id: session.project_id,
          directory: session.directory,
          title: session.title,
          agent: session.agent,
          model: decodeModel(session.model),
          time_created: session.time_created,
          time_updated: session.time_updated,
          archived: session.time_archived != null,
        },
        cost: Number(session.cost ?? 0),
        cost_known,
        tokens: {
          input: Number(session.tokens_input ?? 0),
          output: Number(session.tokens_output ?? 0),
          reasoning: Number(session.tokens_reasoning ?? 0),
        },
        duration_ms: Number(session.time_updated) - Number(session.time_created),
        first_user_prompt: firstPrompt,
        last_user_prompt: lastPrompt,
        user_message_count: userMsgs.length,
        files_touched_top,
        tools_top,
        errors_count: errorsCount,
      }
    })
  },
})
