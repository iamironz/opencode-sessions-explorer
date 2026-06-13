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
export type DecodedFilePart = { type: "file"; url: string | null; filename: string | null; mime: string | null; sourcePath: string | null }
export type DecodedPatchPart = { type: "patch"; hash: string | null; files: string[] }
export type DecodedStepStart = { type: "step-start"; snapshot: string | null }
export type DecodedStepFinish = { type: "step-finish"; reason: string | null; snapshot: string | null; cost: number | null }
export type DecodedCompaction = { type: "compaction"; auto: boolean }
export type DecodedSubtask = { type: "subtask"; prompt: string; description: string | null; agent: string | null }
export type DecodedUnknown = { type: "unknown"; raw_type: string | null }

export type DecodedPart =
  | DecodedTextPart
  | DecodedReasoningPart
  | DecodedToolPart
  | DecodedFilePart
  | DecodedPatchPart
  | DecodedStepStart
  | DecodedStepFinish
  | DecodedCompaction
  | DecodedSubtask
  | DecodedUnknown

function safeParse(jsonStr: string): any {
  try { return JSON.parse(jsonStr) } catch { return null }
}

export function decodeMessage(dataStr: string): DecodedMessage {
  const d = safeParse(dataStr) ?? {}
  const role = (d.role === "user" || d.role === "assistant" || d.role === "system") ? d.role : "unknown"
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
    modelID: d.model?.modelID ?? d.modelID ?? null,
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
    case "file":
      return {
        type: "file",
        url: typeof d.url === "string" ? d.url : null,
        filename: typeof d.filename === "string" ? d.filename : null,
        mime: typeof d.mime === "string" ? d.mime : null,
        sourcePath: typeof d.source?.path === "string" ? d.source.path : null,
      }
    case "patch":
      return {
        type: "patch",
        hash: typeof d.hash === "string" ? d.hash : null,
        files: Array.isArray(d.files) ? d.files.filter((x: any) => typeof x === "string") : [],
      }
    case "step-start":
      return { type: "step-start", snapshot: typeof d.snapshot === "string" ? d.snapshot : null }
    case "step-finish":
      return {
        type: "step-finish",
        reason: typeof d.reason === "string" ? d.reason : null,
        snapshot: typeof d.snapshot === "string" ? d.snapshot : null,
        cost: typeof d.cost === "number" ? d.cost : null,
      }
    case "compaction":
      return { type: "compaction", auto: d.auto === true }
    case "subtask":
      return {
        type: "subtask",
        prompt: typeof d.prompt === "string" ? d.prompt : "",
        description: typeof d.description === "string" ? d.description : null,
        agent: typeof d.agent === "string" ? d.agent : null,
      }
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
  return ["text", "tool", "reasoning", "file", "patch", "step-start", "step-finish", "compaction", "subtask"].includes(t)
}
