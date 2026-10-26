/**
 * opencode-sessions-explorer-session-timeline
 *
 * Compact event list for one session — one event per part with a short
 * summary string. Use this to reconstruct what happened without pulling
 * raw bodies.
 *
 * V2: events are enumerated from `session_message` (ordered by `seq`, the
 * column the OpenCode server itself orders messages by): assistant content
 * items, user/system/synthetic text, and compaction markers. The opaque
 * cursor encodes `(seq, partId)`.
 *
 * Cap: 128 KB.
 */
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodePart } from "../lib/decode.js"
import { truncateString } from "../lib/truncate.js"
import { encodeCursor } from "../lib/pagination.js"
import { table } from "../lib/table.js"
import { messageToParts, parsePartId, type V2MessageRow } from "../lib/v2-parts.js"
import { defineTool } from "../lib/tool-v2.js"

/** Every part type the V2 adapter (lib/v2-parts.ts) produces; compaction is opt-in. */
const ALL_TYPES = ["text", "tool", "reasoning", "compaction"] as const
const DEFAULT_TYPES = ["text", "tool", "reasoning"] as const

const MESSAGE_PAGE = 200

export const sessionTimeline = defineTool<{
  session_id: string
  types?: readonly string[]
  granularity: "events" | "turns"
  from_ts?: number
  until_ts?: number
  limit: number
  cursor?: string
  max_summary_chars: number
}>({
  name: "opencode-sessions-explorer-session-timeline",
  description:
    "opencode-sessions-explorer: chronological event stream for one OpenCode session. " +
    "Answers: \"walk me through session ses_X chronologically\", \"what happened in ses_Y step by step\", \"show me the events in session ses_Z in order\", \"play back session ses_W\", \"reconstruct the conversation flow of ses_X\", \"show me only the tool calls in ses_X\", \"only the reasoning steps in ses_Y\". " +
    "Returns: events array (each = one part with type + short summary; NO raw bodies), sorted by time_created ascending. Each event has part_id, message_id, ts, type, data_bytes, and a one-line summary tuned per type (text snippet, [tool=X status=Y], [reasoning] snippet, [compaction auto=…]). " +
    "Filter by part types (any of text/tool/reasoning/compaction; compaction markers only when requested), and a time window via from_ts/until_ts. Cursor pagination via meta.next_cursor. " +
    "To expand a specific event use get-message (entire turn) or get-part (single part full body).",
  args: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session ID" },
      types: { type: "array", items: { type: "string", enum: [...ALL_TYPES] }, description: "Restrict to these part types" },
      granularity: { type: "string", enum: ["events", "turns"], default: "events", description: "events returns one row per part; turns collapses adjacent parts by message_id" },
      from_ts: { type: "integer", minimum: 0, description: "Only events with time_created >= from_ts" },
      until_ts: { type: "integer", minimum: 0, description: "Only events with time_created <= until_ts" },
      limit: { type: "integer", minimum: 1, maximum: 300, default: 100, description: "Max events (1-300)" },
      cursor: { type: "string" },
      max_summary_chars: { type: "integer", minimum: 40, maximum: 2000, default: 200 },
    },
    required: ["session_id"],
  },
  async execute(args) {
    return runWithEnvelope("session_timeline", 128, async (ctx) => {
      // Confirm session exists
      const session = stmt(`SELECT id, time_archived FROM session_v2 WHERE id = ?`).get(args.session_id) as any
      if (!session) fail("NOT_FOUND", `session not found: ${args.session_id}`)

      const types = args.types && args.types.length > 0 ? (args.types as readonly string[]) : [...DEFAULT_TYPES]
      const cursorPart = args.cursor ? parseCursorPart(args.cursor) : null

      type Event = { part_id: string; message_id: string; seq: number; index: number; ts: number; type: string; data_bytes: number; summary: string }
      const events: Event[] = []
      let hasMore = false
      let lastSeq = cursorPart ? cursorPart.seq : -1
      let exhausted = false

      while (!exhausted && events.length <= args.limit) {
        const page = stmt(`
          SELECT id, session_id, type, seq, time_created, time_updated, data
            FROM session_message
           WHERE session_id = ? AND seq > ?
        ORDER BY seq ASC, id ASC
           LIMIT ?`).all(args.session_id, lastSeq, MESSAGE_PAGE) as V2MessageRow[]
        if (page.length === 0) { exhausted = true; break }
        for (const m of page) {
          lastSeq = m.seq
          for (const p of messageToParts(m)) {
            if (!types.includes(p.type)) continue
            if (args.from_ts !== undefined && p.ts < args.from_ts) continue
            if (args.until_ts !== undefined && p.ts > args.until_ts) continue
            // Cursor skip uses the SAME total order the events are sorted by:
            // (ts, seq, index). Item-level ts can interleave within a message
            // (items without their own time fall back to the message time).
            if (cursorPart) {
              const after = p.ts > cursorPart.ts ||
                (p.ts === cursorPart.ts && (m.seq > cursorPart.seq || (m.seq === cursorPart.seq && p.index > cursorPart.index)))
              if (!after) continue
            }
            const d = decodePart(p.canonical)
            events.push({
              part_id: p.partId,
              message_id: m.id,
              seq: m.seq,
              index: p.index,
              ts: p.ts,
              type: d.type,
              data_bytes: p.bytes,
              summary: summarize(d, args.max_summary_chars),
            })
            if (events.length > args.limit) { hasMore = true; break }
          }
          if (hasMore) break
        }
        if (page.length < MESSAGE_PAGE) exhausted = true
      }

      // Chronological order: (ts, seq, index) — matches the cursor tuple above.
      events.sort((a, b) => a.ts - b.ts || a.seq - b.seq || a.index - b.index)
      const page = events.slice(0, args.limit)
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1]!
        ctx.nextCursor = encodeCursor({ ts: last.ts, id: `${last.seq}:${last.part_id}` })
      }
      // Public wire shape: seq/index stay internal (cursor bookkeeping only).
      const publicEvents = page.map(({ seq: _seq, index: _index, ...pub }) => pub)
      const collapsed = args.granularity === "turns" ? collapseTurns(publicEvents, args.max_summary_chars) : publicEvents
      return {
        session_id: args.session_id,
        archived: session.time_archived != null,
        events: table(collapsed, { dict: ["type", "message_id"] }),
        has_more: hasMore,
      }
    })
  },
})

/** Decode the opaque cursor back to (ts, seq, partId→index) — the event sort tuple. */
function parseCursorPart(cursor: string): { ts: number; seq: number; index: number } | null {
  try {
    const obj = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (typeof obj?.ts !== "number" || typeof obj?.id !== "string") return null
    const colon = obj.id.indexOf(":")
    if (colon < 0) return null
    const seq = Number(obj.id.slice(0, colon))
    const parsed = parsePartId(obj.id.slice(colon + 1))
    if (!Number.isFinite(seq) || !parsed) return null
    return { ts: obj.ts, seq, index: parsed.index }
  } catch {
    return null
  }
}

function summarize(d: ReturnType<typeof decodePart>, maxChars: number): string {
  switch (d.type) {
    case "text":
      return truncateString(d.text.replace(/\s+/g, " "), maxChars).value
    case "reasoning":
      return "[reasoning] " + truncateString(d.text.replace(/\s+/g, " "), maxChars - 12).value
    case "tool":
      return `[tool=${d.tool} status=${d.status}${d.duration_ms != null ? ` ${d.duration_ms}ms` : ""}]` +
        (d.error ? " err:" + truncateString(d.error.replace(/\s+/g, " "), maxChars - 64).value : "")
    case "compaction":
      return `[compaction auto=${d.auto}]`
    default:
      return `[${d.type}]`
  }
}

function collapseTurns(events: any[], maxChars: number): any[] {
  const out: any[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (last && last.message_id === e.message_id) {
      last.part_id = `${last.part_id},${e.part_id}`
      last.type = last.type === e.type ? last.type : "mixed"
      last.data_bytes += e.data_bytes
      last.summary = truncateString(`${last.summary} | ${e.summary}`, maxChars).value
    } else {
      out.push({ ...e })
    }
  }
  return out
}
