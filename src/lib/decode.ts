/**
 * JSON-shape unwrap helpers for message.data and part.data blobs.
 *
 * Every decoder is DEFENSIVE — it never throws on missing optional fields
 * and tags the result with `unknown_type` if it can't recognize the shape.
 * The hard contract is just `$.type` on parts and `$.role` on messages.
 */
import type { DecodedModel, PartType } from "./types.js"

export type DecodedMessage = {
  role: "user" | "assistant" | "system" | "unknown"
  agent: string | null
  providerID: string | null
  modelID: string | null
  parentID: string | null
  cost: number | null
  tokens: { input: number; output: number; reasoning: number; cache_read: number; cache_write: number } | null
}

export type DecodedTextPart = { type: "text"; text: string }
export type DecodedReasoningPart = { type: "reasoning"; text: string }
export type DecodedToolPart = {
  type: "tool"
  tool: string
  callID: string | null
  status: "pending" | "running" | "completed" | "error" | "unknown"
  input: unknown
  output: string | null
  error: string | null
  outputPath: string | null
  truncated: boolean
  start: number | null
  end: number | null
  duration_ms: number | null
  title: string | null
}
export type DecodedCompaction = { type: "compaction"; auto: boolean }
export type DecodedUnknown = { type: "unknown"; raw_type: string | null }

/**
 * The V2 adapter (`lib/v2-parts.ts`) only projects text/reasoning/tool/
 * compaction parts; anything else decodes as `unknown`.
 */
export type DecodedPart =
  | DecodedTextPart
  | DecodedReasoningPart
  | DecodedToolPart
  | DecodedCompaction
  | DecodedUnknown

function safeParse(jsonStr: string): any {
  try { return JSON.parse(jsonStr) } catch { return null }
}

/**
 * V2: the role lives in the `session_message.type` column (there is no
 * `$.role` in `data`); pass it in. `d.role` is still honored defensively.
 * V2 assistant `model` is `{id, providerID, variant}` — `id`, not `modelID`.
 */
export function decodeMessage(dataStr: string, typeRole?: string): DecodedMessage {
  const d = safeParse(dataStr) ?? {}
  const raw = typeRole ?? d.role
  const role = (raw === "user" || raw === "assistant" || raw === "system") ? raw : "unknown"
  const tokens = d.tokens
    ? {
        input: Number(d.tokens.input ?? 0),
        output: Number(d.tokens.output ?? 0),
        reasoning: Number(d.tokens.reasoning ?? 0),
        cache_read: Number(d.tokens.cache?.read ?? d.tokens.cache_read ?? 0),
        cache_write: Number(d.tokens.cache?.write ?? d.tokens.cache_write ?? 0),
      }
    : null
  return {
    role,
    agent: d.agent ?? null,
    providerID: d.model?.providerID ?? d.providerID ?? null,
    modelID: d.model?.modelID ?? d.model?.id ?? d.modelID ?? null,
    parentID: d.parentID ?? null,
    cost: typeof d.cost === "number" ? d.cost : null,
    tokens,
  }
}

export function decodePart(dataStr: string): DecodedPart {
  const d = safeParse(dataStr)
  if (!d || typeof d !== "object") return { type: "unknown", raw_type: null }
  const t: string = d.type ?? ""
  switch (t) {
    case "text":
      return { type: "text", text: typeof d.text === "string" ? d.text : "" }
    case "reasoning":
      return { type: "reasoning", text: typeof d.text === "string" ? d.text : "" }
    case "tool": {
      const s = d.state ?? {}
      const md = s.metadata ?? {}
      const time = s.time ?? {}
      const start = typeof time.start === "number" ? time.start : null
      const end = typeof time.end === "number" ? time.end : null
      return {
        type: "tool",
        tool: typeof d.tool === "string" ? d.tool : "",
        callID: typeof d.callID === "string" ? d.callID : null,
        status: ["pending", "running", "completed", "error"].includes(s.status) ? s.status : "unknown",
        input: s.input ?? null,
        output: typeof s.output === "string" ? s.output : null,
        error: typeof s.error === "string" ? s.error : null,
        outputPath: typeof md.outputPath === "string" ? md.outputPath : null,
        truncated: md.truncated === true,
        start,
        end,
        duration_ms: start != null && end != null ? end - start : null,
        title: typeof s.title === "string" ? s.title : null,
      }
    }
    case "compaction":
      return { type: "compaction", auto: d.auto === true }
    default:
      return { type: "unknown", raw_type: typeof t === "string" ? t : null }
  }
}

/** Decode the stringified session.model JSON. */
export function decodeModel(modelStr: string | null | undefined): DecodedModel {
  if (!modelStr) return { id: null, providerID: null, variant: null }
  const d = safeParse(modelStr)
  if (!d || typeof d !== "object") return { id: null, providerID: null, variant: null }
  return {
    id: typeof d.id === "string" ? d.id : null,
    providerID: typeof d.providerID === "string" ? d.providerID : null,
    variant: typeof d.variant === "string" ? d.variant : null,
  }
}

/** Type-predicate helpers used by callers. */
export function isPartType(t: string): t is PartType {
  return ["text", "tool", "reasoning", "compaction"].includes(t)
}
