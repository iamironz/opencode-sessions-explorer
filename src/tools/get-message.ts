/**
 * opencode-sessions-explorer-get-message
 *
 * One message + its parts (bounded). Cap: 128 KB; each part body capped via max_part_bytes.
 *
 * V2: parts are enumerated from `session_message` — assistant content items
 * (`<messageId>#<index>` part ids), user/system/synthetic text as a single
 * `#0` text part, compaction markers as a `#0` compaction part.
 */
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodePart, decodeMessage } from "../lib/decode.js"
import { truncateString } from "../lib/truncate.js"
import { roleOfType, messageToParts, type V2MessageRow } from "../lib/v2-parts.js"
import { defineTool } from "../lib/tool-v2.js"

/** Every part type the V2 adapter (lib/v2-parts.ts) produces. */
const ALL_TYPES = ["text", "tool", "reasoning", "compaction"] as const

export const getMessage = defineTool<{
  message_id: string
  include_part_data: boolean
  part_types?: readonly string[]
  max_part_bytes: number
}>({
  name: "opencode-sessions-explorer-get-message",
  description:
    "opencode-sessions-explorer: fetch one OpenCode message and its parts (bodies capped) when you have a message id. " +
    "Answers: \"fetch message msg_X\", \"show me message msg_Y with its parts\", \"get the conversational turn at msg_Z\", \"what was in that one assistant response (by msg_id)\". " +
    "Returns: message metadata (role, agent, model, parent_id, cost, tokens, timestamps) + parts array. Each part is fully decoded but its body is capped via max_part_bytes (default 8192) to keep the response bounded — a single message can have parts totalling hundreds of MB in compaction cases. " +
    "Filter to specific part_types (text/tool/reasoning/compaction) if you only want some. " +
    "Use this for a SINGLE turn — for a whole session use session-timeline; for one specific part use get-part.",
  args: {
    type: "object",
    properties: {
      message_id: { type: "string", description: "Message ID (e.g. 'msg_…')" },
      include_part_data: { type: "boolean", default: true, description: "Include decoded part bodies (capped) — set false for header-only listing" },
      part_types: { type: "array", items: { type: "string", enum: [...ALL_TYPES] }, description: "Restrict to these part types" },
      max_part_bytes: { type: "integer", minimum: 256, maximum: 65536, default: 8192, description: "Per-part byte cap (256-65536)" },
    },
    required: ["message_id"],
  },
  async execute(args) {
    return runWithEnvelope("get_message", 128, async (ctx) => {
      const m = stmt(`
        SELECT id, session_id, type, seq, time_created, time_updated, data
          FROM session_message WHERE id = ?`).get(args.message_id) as V2MessageRow | undefined
      if (!m) fail("NOT_FOUND", `message not found: ${args.message_id}`)
      const decoded = decodeMessage(m!.data, roleOfType(m!.type))
      const session = stmt(`SELECT id, title, time_archived, agent, directory FROM session_v2 WHERE id = ?`).get(m!.session_id) as any

      let parts = messageToParts(m!)
      if (args.part_types && args.part_types.length > 0) {
        parts = parts.filter((p) => (args.part_types as readonly string[]).includes(p.type))
      }

      let anyTruncated = false
      const outParts = parts.map((p) => {
        if (!args.include_part_data) {
          return { part_id: p.partId, ts: p.ts, data_bytes: p.bytes, type: p.type }
        }
        const d = decodePart(p.canonical)
        // We cap large string fields inside `d` by re-encoding.
        const { decoded: capped, truncated, truncatedFields } = capDecodedPart(d, args.max_part_bytes)
        if (truncated) { anyTruncated = true; ctx.truncated = true }
        return {
          part_id: p.partId,
          ts: p.ts,
          data_bytes: p.bytes,
          truncated,
          truncated_fields: truncatedFields,
          decoded: capped,
        }
      })
      return {
        message: {
          id: m!.id,
          session_id: m!.session_id,
          time_created: m!.time_created,
          time_updated: m!.time_updated,
          role: decoded.role,
          agent: decoded.agent,
          providerID: decoded.providerID,
          modelID: decoded.modelID,
          parentID: decoded.parentID,
          cost: decoded.cost,
          tokens: decoded.tokens,
        },
        session: session ? { id: session.id, title: session.title, agent: session.agent, directory: session.directory, archived: session.time_archived != null } : null,
        parts: outParts,
        any_truncated: anyTruncated,
      }
    })
  },
})

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
    default:
      return { decoded: d, truncated: fields.length > 0, truncatedFields: fields }
  }
}
