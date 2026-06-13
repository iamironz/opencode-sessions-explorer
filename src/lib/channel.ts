/**
 * Channel and query-intent helpers for curated retrieval.
 *
 * Raw DB/export data stays lossless. Channels are derived search views that let
 * default recall search high-signal content first while preserving raw drill-down
 * through part/message IDs.
 */

export const CHANNELS = [
  "conversation",
  "session-summary",
  "tool-input-summary",
  "tool-error",
  "code-touch",
  "tool-output",
  "patch-summary",
  "reasoning",
  "file",
  "raw",
] as const

export type SearchChannel = typeof CHANNELS[number]

export const SURFACES = ["recall", "debug_trace", "tool_audit", "code", "forensics"] as const
export type SearchSurface = typeof SURFACES[number]

export const DEFAULT_RECALL_CHANNELS: SearchChannel[] = ["conversation", "session-summary"]

export function channelsForSurface(surface: SearchSurface, q = ""): SearchChannel[] {
  const inferred = inferSurface(q, surface)
  switch (inferred) {
    case "debug_trace":
      return ["conversation", "session-summary", "tool-error", "tool-input-summary"]
    case "tool_audit":
      return ["tool-input-summary", "tool-error"]
    case "code":
      return ["conversation", "session-summary", "code-touch", "patch-summary", "tool-input-summary"]
    case "forensics":
      return ["raw"]
    case "recall":
    default:
      return DEFAULT_RECALL_CHANNELS
  }
}

export function inferSurface(q: string, explicit: SearchSurface = "recall"): SearchSurface {
  if (explicit !== "recall") return explicit
  const s = q.toLowerCase()
  if (/\b(error|exception|stack trace|failed|failure|crash|timeout|logs?|stderr|stdout)\b/.test(s)) return "debug_trace"
  if (/\b(tool calls?|bash|command|grep|read tool|edit tool|apply_patch|mcp|jira tool|github tool)\b/.test(s)) return "tool_audit"
  if (/\b(file|path|class|function|symbol|diff|patch|edited|wrote|changed|src\/|\.kt\b|\.ts\b|\.tsx\b|\.js\b|\.py\b)\b/.test(s)) return "code"
  return "recall"
}

export function channelWeight(channel: SearchChannel): number {
  switch (channel) {
    case "session-summary": return 7
    case "conversation": return 6
    case "tool-error": return 5
    case "code-touch": return 4
    case "patch-summary": return 3
    case "tool-input-summary": return 3
    case "file": return 2
    case "tool-output": return 1
    case "reasoning": return 0
    case "raw": return 0
  }
}

export function normalizeForDedupe(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[\u27e6\u27e7]/g, "").trim()
}

export function normalizePrompt(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b[A-Z][A-Z0-9_]+-\d+\b/gi, "<jira>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/(?:\/[\w .@-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\bses_[A-Za-z0-9_-]+\b/g, "<session>")
    .replace(/\bmsg_[A-Za-z0-9_-]+\b/g, "<message>")
    .replace(/\bprt_[A-Za-z0-9_-]+\b/g, "<part>")
    .replace(/\s+/g, " ")
    .trim()
}

export function normalizeError(s: string): string {
  return s
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/(?:\/[\w .@-]+){2,}/g, "<path>")
    .replace(/\b[A-Z][A-Z0-9_]+-\d+\b/g, "<jira>")
    .replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b(line|column|col)[:= ]+\d+\b/gi, "$1:<n>")
    .replace(/:\d+:\d+/g, ":<n>:<n>")
    .replace(/\s+/g, " ")
    .trim()
}

export function compactPath(path: string, baseDir?: string | null): { path: string; rel_path: string | null } {
  if (!baseDir || !path.startsWith(baseDir)) return { path, rel_path: null }
  const rel = path.slice(baseDir.length).replace(/^\/+/, "")
  return { path, rel_path: rel || "." }
}

export function looksLikeExactIdentifier(q: string): boolean {
  return /\b(?:[A-Z][A-Z0-9_]+-\d+|ses_[A-Za-z0-9_-]+|msg_[A-Za-z0-9_-]+|prt_[A-Za-z0-9_-]+)\b/.test(q) ||
    /https?:\/\/\S+/.test(q) ||
    /(?:\/[\w .@-]+){2,}/.test(q)
}
