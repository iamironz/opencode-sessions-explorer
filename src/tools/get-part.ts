/**
 * opencode-sessions-explorer-get-part
 *
 * Single part with optional dereference of externalized tool-output files.
 * Path-traversal-checked. Cap: 128 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodePart, type DecodedPart } from "../lib/decode.js"
import { truncateString, approxJsonBytes } from "../lib/truncate.js"
import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { isWhitelistedToolOutputPath } from "../lib/path-guard.js"

export const getPart = tool({
  description:
    "opencode-sessions-explorer: fetch ONE OpenCode part (the atomic unit — a text block, tool invocation, reasoning step, file reference, patch, or subtask) when you have a part id. " +
    "Answers: \"show me part prt_X\", \"get the full content of part prt_Y\", \"dereference the externalized output of tool call prt_Z\", \"what was the actual output of the read tool at prt_X\", \"fetch the raw body of part prt_Y\". " +
    "Returns: part metadata (id, message_id, session_id, ts, data_bytes) + fully decoded body. Each string field inside the decoded part is capped to max_bytes (default 65536); for `patch` parts the file list is capped to 200 entries with files_total preserved. " +
    "For tool parts where $.state.metadata.outputPath points to an externalized output file in ~/.local/share/opencode/tool-output/ (used when tool output exceeded ~95KB), set `dereference_output_path:true` to read + cap that external file. The path is whitelisted to ~/.local/share/opencode/tool-output/** — any path outside is rejected with PATH_TRAVERSAL.",
  args: {
    part_id: tool.schema.string().describe("Part ID (e.g. 'prt_…')"),
    max_bytes: tool.schema.number().int().min(256).max(262144).default(65536).describe("Body cap (256B-256KB)"),
    dereference_output_path: tool.schema.boolean().default(false).describe("If true and the part has $.state.metadata.outputPath, read that file (capped). Path must be inside ~/.local/share/opencode/tool-output/."),
  },
  async execute(args) {
    return runWithEnvelope("get_part", 128, async (ctx) => {
      const row = stmt(`SELECT id, message_id, session_id, time_created, time_updated, data, LENGTH(data) AS data_bytes FROM part WHERE id = ?`).get(args.part_id) as any
      if (!row) fail("NOT_FOUND", `part not found: ${args.part_id}`)

      const decodedRaw = decodePart(row.data)
      const { decoded, truncatedFields } = capDecoded(decodedRaw, args.max_bytes)
      if (truncatedFields.length > 0) {
        ctx.truncated = true
        ctx.warnings.push(`decoded fields truncated: ${truncatedFields.join(",")}`)
      }
      const tr = truncateString(row.data, args.max_bytes)
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
          id: row.id,
          message_id: row.message_id,
          session_id: row.session_id,
          time_created: row.time_created,
          time_updated: row.time_updated,
          data_bytes: row.data_bytes,
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

const MAX_ARRAY_ITEMS = 200

/** Cap large string fields and array fields inside a decoded part. */
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
    case "patch": {
      let files = d.files
      if (files.length > MAX_ARRAY_ITEMS) {
        files = files.slice(0, MAX_ARRAY_ITEMS)
        tf.push(`files[${d.files.length} → ${MAX_ARRAY_ITEMS}]`)
      }
      return { decoded: { type: d.type, hash: d.hash, files, files_total: d.files.length }, truncatedFields: tf }
    }
    case "subtask":
      return { decoded: { type: d.type, agent: d.agent, description: d.description, prompt: capStr(d.prompt, "prompt") }, truncatedFields: tf }
    default:
      return { decoded: d, truncatedFields: tf }
  }
}
