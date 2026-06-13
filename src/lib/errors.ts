/**
 * Structured error codes used across all opencode-sessions-explorer tools.
 *
 * Every tool that may fail in a recoverable way returns
 * `{ ok: false, error: { code, message } }` instead of throwing.
 * Unrecoverable bugs are still thrown so OpenCode surfaces them with a stack.
 */
export type ErrorCode =
  | "NOT_FOUND"
  | "SCHEMA_DRIFT"
  | "OUTPUT_TRUNCATED"
  | "INDEX_MISSING"
  | "INDEX_STALE"
  | "BUSY"
  | "BAD_REGEX"
  | "PATH_TRAVERSAL"
  | "BAD_ARGS"
  | "DB_NOT_FOUND"
  | "CK_NOT_FOUND"
  | "CK_FAILED"
  | "EXPORT_FAILED"
  | "WRITE_FAILED"
  | "TIMEOUT"
  | "INTERNAL"

export type StructuredError = { code: ErrorCode; message: string; hint?: string }

export class SessionsError extends Error {
  code: ErrorCode
  hint?: string
  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message)
    this.code = code
    this.hint = hint
    this.name = "SessionsError"
  }
}

export function asStructured(e: unknown): StructuredError {
  if (e instanceof SessionsError) {
    return { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }
  }
  if (e instanceof Error) {
    return { code: "INTERNAL", message: e.message }
  }
  return { code: "INTERNAL", message: String(e) }
}
