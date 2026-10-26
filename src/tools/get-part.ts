/**
 * opencode-sessions-explorer-get-part
 *
 * Single part with optional dereference of externalized tool-output files.
 * Path-traversal-checked. Cap: 128 KB.
 *
 * V2 part ids are synthesized `<messageId>#<index>` (see lib/v2-parts.ts);
 * the part is re-projected from the owning session_message row.
 */
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodePart, type DecodedPart } from "../lib/decode.js"
import { truncateString, approxJsonBytes } from "../lib/truncate.js"
import { messageToParts, parsePartId, type V2MessageRow } from "../lib/v2-parts.js"
import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { isWhitelistedToolOutputPath } from "../lib/path-guard.js"
import { defineTool } from "../lib/tool-v2.js"

export const getPart = defineTool<{
  part_id: string
  max_bytes: number
  dereference_output_path: boolean
}>({
  name: "opencode-sessions-explorer-get-part",
  description:
    "opencode-sessions-explorer: fetch ONE OpenCode part (the atomic unit — a text block, tool invocation, reasoning step, or compaction marker) when you have a part id. " +
    "Answers: \"show me part msg_X#2\", \"get the full content of part msg_Y#0\", \"dereference the externalized output of tool call msg_Z#1\", \"what was the actual output of the read tool at msg_X#2\", \"fetch the raw body of part msg_Y#0\". " +
    "Returns: part metadata (id, message_id, session_id, ts, data_bytes) + fully decoded body. Each string field inside the decoded part is capped to max_bytes (default 65536); an oversized tool input is replaced by a capped preview. " +
    "For tool parts where $.state.metadata.outputPath points to an externalized output file in ~/.local/share/opencode/tool-output/ (used when tool output exceeded ~95KB), set `dereference_output_path:true` to read + cap that external file. The path is whitelisted to ~/.local/share/opencode/tool-output/** — any path outside is rejected with PATH_TRAVERSAL.",
  args: {
    type: "object",
    properties: {
      part_id: { type: "string", description: "Part ID (e.g. 'msg_…#N')" },
      max_bytes: { type: "integer", minimum: 256, maximum: 262144, default: 65536, description: "Body cap (256B-256KB)" },
      dereference_output_path: { type: "boolean", default: false, description: "If true and the part has $.state.metadata.outputPath, read that file (capped). Path must be inside ~/.local/share/opencode/tool-output/." },
    },
    required: ["part_id"],
  },
  async execute(args) {
    return runWithEnvelope("get_part", 128, async (ctx) => {
      const parsed = parsePartId(args.part_id)
      if (!parsed) fail("NOT_FOUND", `part not found: ${args.part_id} (V2 part ids are '<messageId>#<index>')`)
      const m = stmt(`
        SELECT id, session_id, type, seq, time_created, time_updated, data
          FROM session_message WHERE id = ?`).get(parsed.messageId) as V2MessageRow | undefined
      if (!m) fail("NOT_FOUND", `part not found: ${args.part_id}`)
      const part = messageToParts(m!).find((p) => p.index === parsed.index)
      if (!part) fail("NOT_FOUND", `part not found: ${args.part_id}`)

      const decodedRaw = decodePart(part.canonical)
      const { decoded, truncatedFields } = capDecoded(decodedRaw, args.max_bytes)
      if (truncatedFields.length > 0) {
        ctx.truncated = true
        ctx.warnings.push(`decoded fields truncated: ${truncatedFields.join(",")}`)
      }
      const tr = truncateString(part.canonical, args.max_bytes)
      if (tr.truncated) ctx.truncated = true

      let deref: { path: string; truncated: boolean; bytes: number; content: string } | null = null
      if (args.dereference_output_path && decoded.type === "tool" && decoded.outputPath) {
        const abs = resolve(decoded.outputPath)
        if (!isWhitelistedToolOutputPath(abs)) {
          fail("PATH_TRAVERSAL", `refused to dereference path outside whitelist: ${decoded.outputPath}`, "Whitelist: ~/.local/share/opencode/tool-output/**")
        }
        try {
          const s = await stat(abs)
          if (!s.isFile()) fail("PATH_TRAVERSAL", `not a regular file: ${decoded.outputPath}`)
          const buf = await readFile(abs)
          const ttr = truncateString(buf.toString("utf8"), args.max_bytes)
          deref = { path: abs, truncated: ttr.truncated, bytes: buf.byteLength, content: ttr.value }
          if (ttr.truncated) ctx.truncated = true
        } catch (e) {
          ctx.warnings.push(`dereference failed: ${(e as Error).message}`)
        }
      }

      return {
        part: {
          id: part.partId,
          message_id: m!.id,
          session_id: m!.session_id,
          time_created: part.ts,
          time_updated: m!.time_updated,
          data_bytes: part.bytes,
        },
        decoded,
        truncated: tr.truncated || truncatedFields.length > 0,
        truncated_fields: truncatedFields,
        original_bytes: tr.originalBytes,
        dereferenced: deref,
      }
    })
  },
})

/** Cap large string fields (and an oversized tool input) inside a decoded part. */
function capDecoded(d: DecodedPart, maxBytes: number): { decoded: any; truncatedFields: string[] } {
  const tf: string[] = []
  const capStr = (s: string | null, field: string): string | null => {
    if (s == null) return null
    const r = truncateString(s, maxBytes)
    if (r.truncated) tf.push(field)
    return r.value
  }
  switch (d.type) {
    case "text":
      return { decoded: { type: d.type, text: capStr(d.text, "text") }, truncatedFields: tf }
    case "reasoning":
      return { decoded: { type: d.type, text: capStr(d.text, "text") }, truncatedFields: tf }
    case "tool": {
      // input is structured — clamp its JSON size by inspecting bytes
      let input = d.input
      try {
        const bytes = approxJsonBytes(input)
        if (bytes > maxBytes) {
          input = { __truncated: true, __original_bytes: bytes, __preview: capStr(JSON.stringify(input), "input") }
          tf.push("input")
        }
      } catch { /* leave as-is */ }
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
          output: capStr(d.output, "output"),
          error: capStr(d.error, "error"),
          outputPath: d.outputPath,
          truncated: d.truncated,
          title: d.title,
        },
        truncatedFields: tf,
      }
    }
    default:
      return { decoded: d, truncatedFields: tf }
  }
}
