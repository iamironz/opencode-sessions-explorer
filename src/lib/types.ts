/**
 * Shared types used across opencode-sessions-explorer tools.
 *
 * OpenCode V2 plugin tools declare args as plain JSON Schema
 * (`lib/jsonschema.ts` + `lib/tool-v2.ts`); no zod is used anymore.
 */
import type { StructuredError } from "./errors.js"

/**
 * Every part type the V2 adapter (`lib/v2-parts.ts` messageToParts) produces —
 * for imported and V2-live data alike.
 */
export type PartType =
  | "text"
  | "tool"
  | "reasoning"
  | "compaction"

export const PART_TYPES_SEARCHABLE: PartType[] = [
  "text",
  "reasoning",
  "tool",
]

/** Raw session row as projected from the DB (defensive — most columns optional). */
export type SessionRow = {
  id: string
  project_id: string
  parent_id: string | null
  slug: string | null
  directory: string
  title: string
  version: string | null
  share_url: string | null
  summary_additions: number | null
  summary_deletions: number | null
  summary_files: number | null
  time_created: number
  time_updated: number
  time_compacting: number | null
  time_archived: number | null
  workspace_id: string | null
  path: string | null
  agent: string | null
  model: string | null
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number | null
  tokens_cache_write: number | null
}

export type MessageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

export type PartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

export type Cursor = { ts: number; id: string }

/** The common envelope every tool returns (serialized to JSON before handoff). */
export type Envelope<T> = {
  ok: boolean
  function: string
  data: T
  meta: {
    db_path: string
    query_ms: number
    bytes_returned: number
    cap_kb: number
    truncated: boolean
    cursor?: string
    next_cursor?: string
    has_more?: boolean
    index_status?: "fresh" | "stale" | "missing" | "disabled" | "n/a" | "partial"
    mode?: string
    schema_drift?: string[]
  }
  warnings: string[]
  error?: StructuredError
}

/** Decoded session.model (defensive). */
export type DecodedModel = {
  id: string | null
  providerID: string | null
  variant: string | null
}
