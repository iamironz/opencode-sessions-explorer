/**
 * opencode-sessions-explorer-get-message
 *
 * One message + its parts (bounded). Cap: 128 KB; each part body capped via max_part_bytes.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodePart, decodeMessage } from "../lib/decode.js"
import { truncateString } from "../lib/truncate.js"

const ALL_TYPES = ["text", "tool", "reasoning", "file", "patch", "step-start", "step-finish", "compaction", "subtask"] as const

export const getMessage = tool({
  description:
    "opencode-sessions-explorer: fetch one OpenCode message and its parts (bodies capped) when you have a message id. " +
    "Answers: \"fetch message msg_X\", \"show me message msg_Y with its parts\", \"get the conversational turn at msg_Z\", \"what was in that one assistant response (by msg_id)\". " +
    "Returns: message metadata (role, agent, model, parent_id, cost, tokens, timestamps) + parts array. Each part is fully decoded but its body is capped via max_part_bytes (default 8192) to keep the response bounded — a single message can have parts totalling hundreds of MB in compaction cases. " +
    "Filter to specific part_types (text/tool/reasoning/file/patch/subtask/etc) if you only want some. " +
    "Use this for a SINGLE turn — for a whole session use session-timeline; for one specific part use get-part.",
  args: {
    message_id: tool.schema.string().describe("Message ID (e.g. 'msg_…')"),
    include_part_data: tool.schema.boolean().default(true).describe("Include decoded part bodies (capped) — set false for header-only listing"),
    part_types: tool.schema.array(tool.schema.enum(ALL_TYPES)).optional().describe("Restrict to these part types"),
    max_part_bytes: tool.schema.number().int().min(256).max(65536).default(8192).describe("Per-part byte cap (256-65536)"),
  },
  async execute(args) {
    return runWithEnvelope("get_message", 128, async (ctx) => {
      const m = stmt(`
        SELECT id, session_id, time_created, time_updated, data
          FROM message WHERE id = ?`).get(args.message_id) as any
      if (!m) fail("NOT_FOUND", `message not found: ${args.message_id}`)
      const decoded = decodeMessage(m.data)
      const session = stmt(`SELECT id, title, time_archived, agent, directory FROM session WHERE id = ?`).get(m.session_id) as any

      const where: string[] = ["p.message_id = ?"]
      const params: any[] = [m.id]
      if (args.part_types && args.part_types.length > 0) {
        where.push(`json_extract(p.data,'$.type') IN (${args.part_types.map(() => "?").join(",")})`)
        params.push(...args.part_types)
      }
      const partRows = stmt(`
        SELECT p.id, p.time_created, p.data, LENGTH(p.data) AS data_bytes
          FROM part p
         WHERE ${where.join(" AND ")}
      ORDER BY p.time_created ASC, p.id ASC`).all(...params) as { id: string; time_created: number; data: string; data_bytes: number }[]

      let anyTruncated = false
      const parts = partRows.map((r) => {
        if (!args.include_part_data) {
          return { part_id: r.id, ts: r.time_created, data_bytes: r.data_bytes, type: pickType(r.data) }
        }
        const d = decodePart(r.data)
        // We cap large string fields inside `d` by re-encoding.
        const { decoded: capped, truncated, truncatedFields } = capDecodedPart(d, args.max_part_bytes)
        if (truncated) { anyTruncated = true; ctx.truncated = true }
        return {
          part_id: r.id,
          ts: r.time_created,
          data_bytes: r.data_bytes,
          truncated,
          truncated_fields: truncatedFields,
          decoded: capped,
        }
      })
      return {
        message: {
          id: m.id,
          session_id: m.session_id,
          time_created: m.time_created,
          time_updated: m.time_updated,
          role: decoded.role,
          agent: decoded.agent,
          providerID: decoded.providerID,
          modelID: decoded.modelID,
          parentID: decoded.parentID,
          cost: decoded.cost,
          tokens: decoded.tokens,
        },
        session: session ? { id: session.id, title: session.title, agent: session.agent, directory: session.directory, archived: session.time_archived != null } : null,
        parts,
        any_truncated: anyTruncated,
      }
    })
  },
})

function pickType(data: string): string {
  // Cheap path: just peek at "type" without full decode.
  const m = /"type"\s*:\s*"([^"]+)"/.exec(data)
  return m?.[1] ?? "unknown"
}

function capDecodedPart(d: ReturnType<typeof decodePart>, maxBytes: number): { decoded: any; truncated: boolean; truncatedFields: string[] } {
  // Walk known fields and truncate big strings; leave structure intact.
  const fields: string[] = []
  const cap = (s: string | null, field: string): string | null => {
    if (s == null) return null
    const tr = truncateString(s, maxBytes)
    if (tr.truncated) fields.push(field)
    return tr.value
  }
  switch (d.type) {
    case "text":
      return { decoded: { type: d.type, text: cap(d.text, "text") }, truncated: fields.length > 0, truncatedFields: fields }
    case "reasoning":
      return { decoded: { type: d.type, text: cap(d.text, "text") }, truncated: fields.length > 0, truncatedFields: fields }
    case "tool": {
      let input = d.input
      try {
        const raw = JSON.stringify(input)
        const tr = truncateString(raw, maxBytes)
        if (tr.truncated) {
          input = { __truncated: true, __original_bytes: tr.originalBytes, __preview: tr.value }
          fields.push("input")
        }
      } catch { /* leave as-is */ }
      const output = cap(d.output, "output")
      const error = cap(d.error, "error")
      return {
        decoded: {
          type: d.type,
          tool: d.tool,
          callID: d.callID,
          status: d.status,
          start: d.start,
          end: d.end,
          duration_ms: d.duration_ms,
          input,
          output,
          error,
          outputPath: d.outputPath,
          truncated: d.truncated,
          title: d.title,
        },
        truncated: fields.length > 0,
        truncatedFields: fields,
      }
    }
    case "patch": {
      const files = d.files.length > 200 ? d.files.slice(0, 200) : d.files
      if (files.length !== d.files.length) fields.push(`files[${d.files.length} → 200]`)
      return { decoded: { type: d.type, hash: d.hash, files, files_total: d.files.length }, truncated: fields.length > 0, truncatedFields: fields }
    }
    case "subtask":
      return { decoded: { type: d.type, agent: d.agent, description: d.description, prompt: cap(d.prompt, "prompt") }, truncated: fields.length > 0, truncatedFields: fields }
    default:
      return { decoded: d, truncated: fields.length > 0, truncatedFields: fields }
  }
}
