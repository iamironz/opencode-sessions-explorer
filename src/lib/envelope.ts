/**
 * Common envelope builder for all opencode-sessions-explorer tools.
 *
 * Each tool's execute() body is wrapped in `runWithEnvelope` which:
 *   - Asserts schema is OK (hard drift throws SCHEMA_DRIFT).
 *   - Records query_ms, bytes_returned, cap_kb, truncated, schema_drift.
 *   - Catches SessionsError and renders it into the envelope.
 *   - JSON-stringifies the final envelope for the OpenCode tool result.
 */
import { locateDb, _resetForTest } from "./db.js"
import { assertSchemaOk, getSchemaState } from "./schema.js"
import { SessionsError, asStructured, type ErrorCode } from "./errors.js"
import type { Envelope } from "./types.js"

export type EnvelopeCtx = {
  warnings: string[]
  truncated: boolean
  nextCursor?: string
  indexStatus?: "fresh" | "stale" | "missing" | "disabled" | "n/a" | "partial"
  mode?: string
}

export async function runWithEnvelope<T>(
  functionName: string,
  capKb: number,
  fn: (ctx: EnvelopeCtx) => Promise<T>,
): Promise<string> {
  const start = Date.now()
  const ctx: EnvelopeCtx = { warnings: [], truncated: false }
  let dbPath = ""
  try {
    dbPath = safeDbPath()
    assertSchemaOk()
    const schema = getSchemaState()
    const data = await fn(ctx)
    return finalize(functionName, capKb, start, dbPath, data, ctx, schema.drift_warnings)
  } catch (e) {
    const err = asStructured(e)
    const env: Envelope<null> = {
      ok: false,
      function: functionName,
      data: null as any,
      meta: {
        db_path: dbPath,
        query_ms: Date.now() - start,
        bytes_returned: 0,
        cap_kb: capKb,
        truncated: false,
        index_status: ctx.indexStatus,
        mode: ctx.mode,
      },
      warnings: ctx.warnings,
      error: err,
    }
    return JSON.stringify(env)
  }
}

function safeDbPath(): string {
  try { return locateDb() } catch { return "" }
}

function finalize<T>(
  fn: string,
  capKb: number,
  start: number,
  dbPath: string,
  data: T,
  ctx: EnvelopeCtx,
  schemaWarnings: string[],
): string {
  // Build the candidate envelope without `bytes_returned` first, then size it.
  const env: Envelope<T> = {
    ok: true,
    function: fn,
    data,
    meta: {
      db_path: dbPath,
      query_ms: Date.now() - start,
      bytes_returned: 0,
      cap_kb: capKb,
      truncated: ctx.truncated,
      next_cursor: ctx.nextCursor,
      index_status: ctx.indexStatus,
      mode: ctx.mode,
      schema_drift: schemaWarnings.length > 0 ? schemaWarnings : undefined,
    },
    warnings: ctx.warnings,
  }
  const json = JSON.stringify(env)
  const bytes = new TextEncoder().encode(json).length
  // patch the bytes_returned in-place (cheap re-serialize)
  env.meta.bytes_returned = bytes
  return JSON.stringify(env)
}

/** Convenience for raising domain errors from inside a tool body. */
export function fail(code: ErrorCode, message: string, hint?: string): never {
  throw new SessionsError(code, message, hint)
}

/** Test helper. */
export function _resetEnvelopeForTest(): void {
  _resetForTest()
}
