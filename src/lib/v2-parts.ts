/**
 * V2 session schema adapter: maps `session_message` rows (parts INLINE in
 * `data.content[]`) onto the V1 part semantics every tool already speaks.
 *
 * Verified live V2 shapes (opencode v2.1.3, checked 2026-10-23):
 *
 * - `session_message.type` ∈ {user, assistant, system, synthetic, compaction,
 *   idle, model-switched}; ordering is `(seq)` per session.
 * - user data:      `{time:{created}, text, files?:[]}`
 * - assistant data: `{time, agent, model:{id,providerID,variant}, content[],
 *                    cost, tokens, finish, snapshot?}`
 * - content items:  `{type:"text"|"reasoning", text}` and
 *   `{type:"tool", id:"call_…", name, executed?, state:{status, input,
 *                    content?:[{type:"text",text}|{type:"file",…}],
 *                    error?:{type,message}|string, metadata:{preview?,
 *                    outputPath?, truncated?, output?, …}}, time:{created,
 *                    completed}?, native?}`
 *   — identical for imported (pre-migration) and V2-live rows.
 *
 * Part identity: V2 has no part rows, so parts are addressed as
 * `<messageId>#<index>` — the content-array index for assistant messages, `0`
 * for the synthesized single part of user/system/synthetic/compaction
 * messages. Message ids never contain `#` (verified across all 325k rows).
 *
 * Each part is projected to a CANONICAL V1-shaped part JSON so `decodePart()`,
 * `buildPartFile()`, and `buildChannelDocuments()` keep their V1 semantics.
 */
export type V2MessageRow = {
  id: string
  session_id: string
  type: string
  seq: number
  time_created: number
  time_updated: number
  data: string
  data_bytes?: number
}

export type V2Part = {
  /** Synthesized part id: `<messageId>#<index>`. */
  partId: string
  /** Content-array index (0 for single-part messages). */
  index: number
  /** Canonical V1 part type: text/reasoning/tool/compaction/… */
  type: string
  /** Event timestamp (item time when present, else message time_created). */
  ts: number
  /** Byte length of the canonical JSON. */
  bytes: number
  /** Canonical V1-shaped part JSON (input for decodePart()). */
  canonical: string
}

const enc = new TextEncoder()

/** Build a synthesized part id. */
export function partIdOf(messageId: string, index: number): string {
  return `${messageId}#${index}`
}

/** Parse `<messageId>#<index>`; returns null for foreign shapes. */
export function parsePartId(partId: string): { messageId: string; index: number } | null {
  const m = /^(.+)#(\d+)$/.exec(partId)
  if (!m) return null
  return { messageId: m[1]!, index: Number(m[2]!) }
}

/** Map a session_message.type onto the V1 role vocabulary. */
export function roleOfType(type: string): "user" | "assistant" | "system" | "unknown" {
  if (type === "user") return "user"
  if (type === "assistant") return "assistant"
  if (type === "system" || type === "synthetic") return "system"
  return "unknown"
}

function safeParse(jsonStr: string): any {
  try { return JSON.parse(jsonStr) } catch { return null }
}

/** Join a V2 tool result `state.content[]` into plain text (text items only). */
export function toolOutputText(state: any): string | null {
  const content = state?.content
  if (Array.isArray(content)) {
    const texts = content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
    return texts.length > 0 ? texts.join("\n") : null
  }
  return null
}

/** V2 tool errors are `{type,message}` objects or plain strings. */
export function toolErrorText(state: any): string | null {
  const err = state?.error
  if (typeof err === "string") return err
  if (err && typeof err === "object" && typeof err.message === "string") return err.message
  return null
}

/** Project one assistant content item to canonical V1 part JSON. */
function itemToCanonical(item: any): { type: string; json: unknown } | null {
  if (!item || typeof item !== "object") return null
  const t = typeof item.type === "string" ? item.type : ""
  switch (t) {
    case "text":
    case "reasoning":
      return { type: t, json: { type: t, text: typeof item.text === "string" ? item.text : "" } }
    case "tool": {
      const state = item.state ?? {}
      const md = state.metadata ?? {}
      const time = item.time ?? {}
      const start = typeof time.created === "number" ? time.created : null
      const end = typeof time.completed === "number" ? time.completed : null
      const output = toolOutputText(state) ?? (typeof md.output === "string" ? md.output : null)
      return {
        type: "tool",
        json: {
          type: "tool",
          tool: typeof item.name === "string" ? item.name : "",
          callID: typeof item.id === "string" ? item.id : null,
          state: {
            status: state.status,
            input: state.input ?? null,
            output,
            error: toolErrorText(state),
            metadata: md,
            time: { start, end },
          },
        },
      }
    }
    default:
      // Unknown/future item types pass through so decodePart tags them unknown.
      return { type: t || "unknown", json: { type: t || "unknown" } }
  }
}

/**
 * Enumerate the parts of one V2 message row, in canonical order:
 * assistant content items by array index; user/system/synthetic text and
 * compaction markers as single `#0` parts. Non-searchable message types
 * (idle, model-switched) enumerate to zero parts.
 */
export function messageToParts(row: V2MessageRow): V2Part[] {
  const d = safeParse(row.data) ?? {}
  const baseTs = typeof d?.time?.created === "number" ? d.time.created : row.time_created
  const parts: V2Part[] = []
  const push = (index: number, type: string, json: unknown, ts: number) => {
    const canonical = JSON.stringify(json)
    parts.push({ partId: partIdOf(row.id, index), index, type, ts, bytes: enc.encode(canonical).length, canonical })
  }

  if (row.type === "assistant" && Array.isArray(d.content)) {
    for (let i = 0; i < d.content.length; i++) {
      const item = d.content[i]
      const projected = itemToCanonical(item)
      if (!projected) continue
      const itemTs = typeof item?.time?.created === "number" ? item.time.created : baseTs
      push(i, projected.type, projected.json, itemTs)
    }
    return parts
  }

  if (row.type === "compaction") {
    push(0, "compaction", { type: "compaction", auto: d.reason === "auto" }, baseTs)
    return parts
  }

  if (row.type === "user" || row.type === "system" || row.type === "synthetic") {
    if (typeof d.text === "string" && d.text.length > 0) {
      push(0, "text", { type: "text", text: d.text }, baseTs)
    }
    return parts
  }

  return parts // idle, model-switched, unknown → no parts
}
