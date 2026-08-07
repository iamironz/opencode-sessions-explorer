/**
 * Health/drift probe for opencode-sessions-explorer.
 *
 * Returns the cached SchemaState (migrations head, table counts, json1 status,
 * busy_timeout, hard_drift, drift_warnings), plus a compact FTS sidecar
 * health section. The schema state is computed once per process and cached.
 */
import { tool } from "@opencode-ai/plugin"
import { getSchemaState } from "../lib/schema.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { ftsPresent, ftsStats } from "../lib/fts.js"

/** Compact FTS sidecar health, additive to the schema-state response.
 *  Tolerant of a missing or corrupt sidecar: `ftsPresent`/`ftsStats` never
 *  throw (they report `lastError` instead), and this function wraps them in
 *  a try/catch anyway so a future change there still can't fail this tool.
 *
 *  Surfaces the completeness ("built") vs freshness ("lag") split so an
 *  operator can tell WHY literal search may be routing to ripgrep:
 *   - `complete` (gates the fast tier — a durable "fully built at least once,
 *     no unresolved failures" flag),
 *   - `at_source` / `lag_ms` (informational freshness — lag NEVER disables the
 *     fast tier), and
 *   - `failed_parts` / `dead_letters` (build-failure accounting), plus
 *   - `case_folding_ascii_only` (documents the one recall gap vs ripgrep -i). */
function ftsHealth(): {
  present: boolean
  complete: boolean
  docs: number
  bytes: number
  channels: string[]
  cursor: { ts: number; id: string } | null
  at_source: boolean
  lag_ms: number | null
  failed_parts: number
  dead_letters: number
  case_folding_ascii_only: boolean
  last_error: string | null
} {
  try {
    const present = ftsPresent()
    const s = ftsStats()
    return {
      present,
      complete: s.complete,
      docs: s.docs,
      bytes: s.bytes,
      channels: s.channels,
      cursor: s.cursor,
      at_source: s.atSource,
      lag_ms: s.lagMs,
      failed_parts: s.failedParts,
      dead_letters: s.deadLetters,
      case_folding_ascii_only: s.caseFoldingAsciiOnly,
      last_error: s.lastError,
    }
  } catch (e) {
    return {
      present: false,
      complete: false,
      docs: 0,
      bytes: 0,
      channels: [],
      cursor: null,
      at_source: false,
      lag_ms: null,
      failed_parts: 0,
      dead_letters: 0,
      case_folding_ascii_only: true,
      last_error: (e as Error).message,
    }
  }
}

export const dbStats = tool({
  description:
    "opencode-sessions-explorer: health probe for the OpenCode SQLite database (~/.local/share/opencode/opencode.db). " +
    "Returns migration head, table counts (session/message/part), json1 extension status, busy_timeout, any schema-drift warnings, " +
    "and a compact FTS5 sidecar health section (present, complete/authoritative, doc count, on-disk bytes, indexed channels, cursor, lag behind source, failed/dead-letter parts, ascii-only case folding, last error). " +
    "Run this when troubleshooting: any opencode-sessions-explorer-* tool returning SCHEMA_DRIFT, after an OpenCode upgrade, when verifying the DB is reachable, when literal/lex search seems stale or absent, or when answering 'is opencode.db healthy / what schema is it on / how many sessions are stored / is the FTS index built'.",
  args: {},
  async execute() {
    return runWithEnvelope("db_stats", 8, async () => {
      const s = getSchemaState()
      return {
        migrations_head: s.migrations_head,
        table_counts: s.table_counts,
        json1_ok: s.json1_ok,
        busy_timeout_ms: s.busy_timeout_ms,
        drift_warnings: s.drift_warnings,
        hard_drift: s.hard_drift,
        cached_at: s.cached_at,
        fts: ftsHealth(),
      }
    })
  },
})
