/**
 * Health/drift probe for opencode-sessions-explorer.
 *
 * Returns the cached SchemaState (migrations head, table counts, json1 status,
 * busy_timeout, hard_drift, drift_warnings). The state is computed once per
 * process and cached.
 */
import { tool } from "@opencode-ai/plugin"
import { getSchemaState } from "../lib/schema.js"
import { runWithEnvelope } from "../lib/envelope.js"

export const dbStats = tool({
  description:
    "opencode-sessions-explorer: health probe for the local OpenCode SQLite database (~/.local/share/opencode/opencode.db). " +
    "Returns migration head, table counts (session/message/part), json1 extension status, busy_timeout, and any schema-drift warnings. " +
    "Run this when troubleshooting: any opencode-sessions-explorer-* tool returning SCHEMA_DRIFT, after an OpenCode upgrade, when verifying the DB is reachable, or when answering 'is opencode.db healthy / what schema is it on / how many sessions are stored'.",
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
      }
    })
  },
})
