/**
 * opencode-sessions-explorer-session-summary
 *
 * Headline numbers + first/last user prompt + top files touched + top tools used
 * + errors count + duration. Cap: 32 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodePart, decodeMessage, decodeModel } from "../lib/decode.js"
import { truncateString } from "../lib/truncate.js"
import { compactPath } from "../lib/channel.js"

export const sessionSummary = tool({
  description:
    "opencode-sessions-explorer: one-call human-readable overview of an OpenCode session. " +
    "Answers: \"summarize session ses_X\", \"what did I work on in ses_Y\", \"give me an overview of ses_Z\", \"TLDR of this session\", \"what was the gist of session ses_W\", \"what files did I touch in ses_X\", \"what tools did I use in ses_Y\". " +
    "Returns: session metadata, first user prompt (truncated to max_prompt_bytes), last user prompt, top files touched (extracted from `patch` parts + tool inputs to read/edit/write/apply_patch), top tools used (with completed/error counts), errors_count, duration_ms, cost. " +
    "Best single-call session overview. For event-level chronology use session-timeline; for one specific message use get-message; for raw metadata use get-session.",
  args: {
    session_id: tool.schema.string().describe("Session ID"),
    max_prompt_bytes: tool.schema.number().int().min(64).max(8192).default(2048).describe("Cap on each user-prompt snippet"),
  },
  async execute(args) {
    return runWithEnvelope("session_summary", 32, async (ctx) => {
      const session = stmt(`
        SELECT id, project_id, directory, title, agent, model, cost,
               tokens_input, tokens_output, tokens_reasoning,
               time_created, time_updated, time_archived
          FROM session WHERE id = ?`).get(args.session_id) as any
      if (!session) fail("NOT_FOUND", `session not found: ${args.session_id}`)

      // Find first/last user message + grab its text parts.
      const userMsgs = stmt(`
        SELECT m.id, m.time_created
          FROM message m
         WHERE m.session_id = ? AND json_extract(m.data,'$.role') = 'user'
         ORDER BY m.time_created ASC, m.id ASC`).all(args.session_id) as { id: string; time_created: number }[]

      const firstPrompt = userMsgs[0] ? collectUserText(userMsgs[0].id, args.max_prompt_bytes) : null
      const lastPrompt = userMsgs.length > 1 ? collectUserText(userMsgs[userMsgs.length - 1]!.id, args.max_prompt_bytes) : firstPrompt

      // Top tools used (by count, excluding errors)
      const topTools = stmt(`
        SELECT json_extract(data,'$.tool') AS tool,
               json_extract(data,'$.state.status') AS status,
               COUNT(*) AS n
          FROM part
         WHERE session_id = ? AND json_extract(data,'$.type') = 'tool'
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

      // Files touched: gather from patch parts ($.files[]) + tool read/edit/write inputs ($.state.input.filePath)
      const filesTouched = new Map<string, { count: number; score: number }>()
      const addFile = (path: string, weight: number) => {
        const cur = filesTouched.get(path) ?? { count: 0, score: 0 }
        cur.count++
        cur.score += weight
        filesTouched.set(path, cur)
      }
      const patchRows = stmt(`
        SELECT data FROM part
         WHERE session_id = ? AND json_extract(data,'$.type') = 'patch'
         LIMIT 500`).all(args.session_id) as { data: string }[]
      for (const r of patchRows) {
        const d = decodePart(r.data)
        if (d.type === "patch") for (const f of d.files) addFile(f, 3)
      }
      const fileToolRows = stmt(`
        SELECT json_extract(data,'$.state.input.filePath') AS fp,
               json_extract(data,'$.tool') AS tool
           FROM part
          WHERE session_id = ? AND json_extract(data,'$.type') = 'tool'
                AND json_extract(data,'$.tool') IN ('read','edit','write','apply_patch')
                AND json_extract(data,'$.state.input.filePath') IS NOT NULL
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

function collectUserText(messageId: string, maxBytes: number): { text: string; truncated: boolean; original_bytes: number } | null {
  const rows = stmt(`
    SELECT json_extract(data,'$.text') AS t
      FROM part
     WHERE message_id = ? AND json_extract(data,'$.type') = 'text'
     ORDER BY time_created ASC, id ASC`).all(messageId) as { t: string | null }[]
  if (rows.length === 0) return null
  const joined = rows.map((r) => r.t ?? "").join("\n").trim()
  if (!joined) return null
  const tr = truncateString(joined, maxBytes)
  return { text: tr.value, truncated: tr.truncated, original_bytes: tr.originalBytes }
}
