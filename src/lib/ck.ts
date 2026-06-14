/**
 * Thin shell-out wrapper for the `ck` CLI (https://github.com/BeaconBay/ck).
 *
 * ck modes:
 *   regex   — drop-in grep, no index needed (fast on small scope)
 *   lex     — BM25 full-text, auto-builds Tantivy index
 *   sem     — semantic embeddings, lazily builds/refreshes the ck index
 *   hybrid  — RRF of regex + semantic
 *
 * We use `--jsonl` for structured output. Each line is one hit:
 *   { path, span:{byte_start,byte_end,line_start,line_end}, language, snippet, score }
 *
 * Timeouts are enforced by killing the child process via AbortController.
 */
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { exportRoot } from "./export.js"
import { SessionsError } from "./errors.js"

export type CkMode = "regex" | "lex" | "sem" | "hybrid"

export type CkHit = {
  path: string
  span: { byte_start: number; byte_end: number; line_start: number; line_end: number }
  language: string | null
  snippet: string
  score: number
}

export type CkOptions = {
  mode: CkMode
  query: string
  scopes: string[]               // paths to search (files or dirs)
  topk?: number                  // ck --topk N
  threshold?: number             // ck --threshold X
  contextLines?: number          // ck -C N
  caseSensitive?: boolean        // default false → -i
  wholeWord?: boolean            // ck -w
  fixedString?: boolean          // ck -F (no regex)
  noSnippet?: boolean            // ck --no-snippet
  excludePatterns?: string[]     // ck --exclude PAT ...
  timeoutMs?: number             // hard kill
}

export type CkRunResult = {
  hits: CkHit[]
  rc: number
  stderr: string
  durationMs: number
  timedOut: boolean
  scopeCoverage: CkScopeCoverage
}

export type CkScopeCoverage = {
  strategy: "single" | "fanout"
  searched_scopes: number
  total_scopes: number
  omitted_scopes: number
  truncated: boolean
  timed_out: boolean
}

export type CkIndexStatus = "fresh" | "stale" | "missing" | "partial"

export type CkIndexFreshness = {
  status: CkIndexStatus
  present: boolean
  embedded_chunks: number | null
  index_updated_ms: number | null
  export_marker_ms: number | null
  status_json_available: boolean
  source: "status-json" | "manifest" | "missing"
  warning: string | null
}

/**
 * Locate the `ck` binary. Resolution order:
 *   1. $OPENCODE_SESSIONS_EXPLORER_CK_BIN env override (absolute path)
 *   2. Common install locations checked for absolute presence
 *   3. Fall back to bare `ck` for $PATH resolution at spawn time
 */
function defaultCkCandidates(): string[] {
  const home = process.env.HOME ?? ""
  const candidates = [
    // Common cross-platform install locations
    home ? `${home}/.cargo/bin/ck` : null,
    "/usr/local/bin/ck",
    "/opt/homebrew/bin/ck",
    "/usr/bin/ck",
  ].filter((p): p is string => !!p)
  return candidates
}

export function locateCk(): string {
  if (process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN) return process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN
  for (const c of defaultCkCandidates()) {
    if (c.startsWith("/") && existsSync(c)) return c
  }
  return "ck"
}

export async function runCk(opts: CkOptions): Promise<CkRunResult> {
  if (opts.scopes.length > 1) return runCkMultiScope(opts)

  const args = ["--jsonl"]
  switch (opts.mode) {
    case "regex": args.push("--regex"); break
    case "lex": args.push("--lex"); break
    case "sem": args.push("--sem"); break
    case "hybrid": args.push("--hybrid"); break
  }
  if (opts.topk != null) args.push("--topk", String(opts.topk))
  if (opts.threshold != null) args.push("--threshold", String(opts.threshold))
  if (opts.contextLines != null) args.push("-C", String(opts.contextLines))
  if (opts.caseSensitive === false) args.push("-i")
  if (opts.wholeWord) args.push("-w")
  if (opts.fixedString) args.push("-F")
  if (opts.noSnippet) args.push("--no-snippet")
  if (opts.excludePatterns) for (const p of opts.excludePatterns) args.push("--exclude", p)
  args.push(opts.query)
  if (opts.scopes.length === 0) args.push(exportRoot())
  else args.push(...opts.scopes)

  const start = Date.now()
  const ctl = new AbortController()
  const timer = opts.timeoutMs ? setTimeout(() => ctl.abort(), opts.timeoutMs) : null

  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(locateCk(), args, { signal: ctl.signal })
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new SessionsError("CK_NOT_FOUND", `ck CLI not found in $PATH; install via 'cargo install ck-search'`)
    throw new SessionsError("CK_FAILED", `spawn failed: ${e?.message ?? String(e)}`)
  }

  const hits: CkHit[] = []
  let stderr = ""
  let buf = ""
  let timedOut = false

  proc.stdout.setEncoding("utf8")
  proc.stderr.setEncoding("utf8")
  let procError: unknown = null

  proc.stdout.on("data", (chunk: string) => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj.path === "string") hits.push(obj as CkHit)
      } catch { /* swallow malformed lines */ }
    }
  })
  proc.stderr.on("data", (chunk: string) => { stderr += chunk })

  const rc = await new Promise<number>((resolve) => {
    proc.on("error", (e: Error & { code?: string }) => {
      procError = e
      if (e.name === "AbortError" || ctl.signal.aborted) { timedOut = true; resolve(124) }
      else resolve(2)
    })
    proc.on("close", (code) => resolve(code ?? 0))
  })
  if (timer) clearTimeout(timer)

  const childError = procError as (Error & { code?: string }) | null
  if (childError && !timedOut) {
    if (childError.code === "ENOENT") throw new SessionsError("CK_NOT_FOUND", `ck CLI not found at '${locateCk()}'; install via 'cargo install ck-search'`)
    throw new SessionsError("CK_FAILED", `ck process failed: ${childError.message}`)
  }

  // Flush trailing buf
  if (buf.trim()) {
    try { const obj = JSON.parse(buf.trim()); if (obj?.path) hits.push(obj as CkHit) } catch {}
  }

  const totalScopes = opts.scopes.length === 0 ? 1 : opts.scopes.length
  return {
    hits,
    rc,
    stderr,
    durationMs: Date.now() - start,
    timedOut,
    scopeCoverage: {
      strategy: "single",
      searched_scopes: totalScopes,
      total_scopes: totalScopes,
      omitted_scopes: 0,
      truncated: false,
      timed_out: timedOut,
    },
  }
}

async function runCkMultiScope(opts: CkOptions): Promise<CkRunResult> {
  const start = Date.now()
  const hits: CkHit[] = []
  let stderr = ""
  let rc = 1
  let timedOut = false
  let searchedScopes = 0
  const topk = opts.topk ?? 50
  const perScopeTopk = Math.max(5, Math.ceil(topk / Math.max(1, opts.scopes.length)))

  for (const scope of opts.scopes) {
    const elapsed = Date.now() - start
    const remaining = opts.timeoutMs == null ? undefined : Math.max(1, opts.timeoutMs - elapsed)
    if (remaining != null && remaining <= 1) { timedOut = true; break }
    const res = await runCk({ ...opts, scopes: [scope], timeoutMs: remaining, topk: perScopeTopk })
    searchedScopes++
    hits.push(...res.hits)
    if (res.stderr) stderr += (stderr && !stderr.endsWith("\n") ? "\n" : "") + res.stderr
    if (res.timedOut) timedOut = true
    if (res.rc === 0) rc = 0
    else if (rc !== 0 && res.rc !== 1) rc = res.rc
    if (timedOut && opts.timeoutMs != null && Date.now() - start >= opts.timeoutMs) break
  }

  const truncated = searchedScopes < opts.scopes.length
  if (truncated && timedOut && rc === 1) rc = 124

  return {
    hits: hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topk),
    rc,
    stderr,
    durationMs: Date.now() - start,
    timedOut,
    scopeCoverage: {
      strategy: "fanout",
      searched_scopes: searchedScopes,
      total_scopes: opts.scopes.length,
      omitted_scopes: Math.max(0, opts.scopes.length - searchedScopes),
      truncated,
      timed_out: timedOut,
    },
  }
}

/** Returns true if a ck semantic/lex index appears present in the export root. */
export function ckIndexPresent(root = exportRoot()): { present: boolean; embedded_chunks: number | null } {
  const manifestPath = `${root}/.ck/manifest.json`
  if (!existsSync(manifestPath)) return { present: false, embedded_chunks: null }
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"))
    return { present: true, embedded_chunks: m?.totals?.embedded_chunks ?? null }
  } catch {
    return { present: true, embedded_chunks: null }
  }
}

/**
 * Best-effort semantic index freshness probe. This never builds/rebuilds ck; it
 * only asks `ck --status-json` when supported and falls back to manifest markers.
 */
export async function ckIndexFreshness(root = exportRoot(), timeoutMs = 1500): Promise<CkIndexFreshness> {
  const manifestPath = `${root}/.ck/manifest.json`
  const markerMs = exportMarkerMtime(root)
  const manifest = readManifestProbe(manifestPath)
  if (!manifest.present) {
    return {
      status: "missing",
      present: false,
      embedded_chunks: null,
      index_updated_ms: null,
      export_marker_ms: markerMs,
      status_json_available: false,
      source: "missing",
      warning: ckIndexWarning("missing", root),
    }
  }

  const statusJson = await readStatusJson(root, timeoutMs)
  const statusProbe = statusJson.ok ? probeFromUnknown(statusJson.value) : null
  const embedded = statusProbe?.embedded_chunks ?? manifest.embedded_chunks
  const indexUpdated = statusProbe?.index_updated_ms ?? manifest.index_updated_ms
  let status = statusFromProbe(statusProbe?.status, embedded, indexUpdated, markerMs)
  const source: CkIndexFreshness["source"] = statusProbe ? "status-json" : "manifest"

  // If ck cannot attest its own status, avoid claiming a semantic index is fresh.
  if (!statusJson.ok && status === "fresh") status = "partial"

  const warning = status === "fresh"
    ? null
    : ckIndexWarning(status, root, statusJson.ok ? null : statusJson.reason)

  return {
    status,
    present: true,
    embedded_chunks: embedded,
    index_updated_ms: indexUpdated,
    export_marker_ms: markerMs,
    status_json_available: statusJson.ok,
    source,
    warning,
  }
}

function statusFromProbe(
  explicit: CkIndexStatus | null | undefined,
  embeddedChunks: number | null,
  indexUpdatedMs: number | null,
  exportMarkerMs: number | null,
): CkIndexStatus {
  if (explicit === "missing" || explicit === "stale" || explicit === "partial") return explicit
  if (embeddedChunks != null && embeddedChunks <= 0) return "partial"
  if (indexUpdatedMs == null) return "partial"
  if (exportMarkerMs != null && indexUpdatedMs + 1000 < exportMarkerMs) return "stale"
  return "fresh"
}

function ckIndexWarning(status: CkIndexStatus, root: string, probeFailure?: string | null): string {
  const prewarm = `opencode-sessions-explorer will not call ck --index or ck --reindex inline; run 'cd "${root}" && ck --index .' or 'ck --reindex .' only to prewarm or troubleshoot.`
  if (status === "missing") return `ck semantic index is missing at ${root}/.ck. ck will lazily create or update the index during sem/hybrid search; the first run may be slow. ${prewarm}`
  if (status === "stale") return `ck semantic index appears stale relative to the export tree; ck will attempt a lazy refresh during sem/hybrid search. Results may be partial if refresh fails or times out. ${prewarm}`
  const reason = probeFailure ? ` (${probeFailure})` : ""
  return `ck semantic index freshness is partial/unverified${reason}; ck will attempt lazy index refresh during sem/hybrid search. Results may cover only indexed files if refresh fails or times out. ${prewarm}`
}

function exportMarkerMtime(root: string): number | null {
  const markers = [".last_sync", ".channels_v1_complete"]
  let newest: number | null = null
  for (const marker of markers) {
    const path = `${root}/${marker}`
    if (!existsSync(path)) continue
    try {
      const mtime = statSync(path).mtimeMs
      newest = newest == null ? mtime : Math.max(newest, mtime)
    } catch { /* ignore marker races */ }
  }
  return newest
}

type IndexProbe = {
  present: boolean
  embedded_chunks: number | null
  index_updated_ms: number | null
  status?: CkIndexStatus | null
}

function readManifestProbe(manifestPath: string): IndexProbe {
  if (!existsSync(manifestPath)) return { present: false, embedded_chunks: null, index_updated_ms: null }
  try {
    return { present: true, ...probeFromUnknown(JSON.parse(readFileSync(manifestPath, "utf8"))) }
  } catch {
    return { present: true, embedded_chunks: null, index_updated_ms: null, status: "partial" }
  }
}

function probeFromUnknown(value: unknown): Omit<IndexProbe, "present"> {
  return {
    embedded_chunks: firstNumber(value, [["totals", "embedded_chunks"], ["embedded_chunks"], ["index", "embedded_chunks"]]),
    index_updated_ms: firstTimeMs(value, [["index_updated"], ["index_updated_ms"], ["indexed_at"], ["updated_at"], ["last_indexed"], ["manifest", "index_updated"]]),
    status: firstStatus(value),
  }
}

function firstStatus(value: unknown): CkIndexStatus | null {
  const raw = firstString(value, [["status"], ["index_status"], ["semantic_status"], ["index", "status"]])?.toLowerCase()
  if (raw === "fresh" || raw === "stale" || raw === "missing" || raw === "partial") return raw
  return null
}

function firstNumber(value: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const n = numberFromUnknown(valueAtPath(value, path))
    if (n != null) return n
  }
  return null
}

function firstTimeMs(value: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const ms = timeMsFromUnknown(valueAtPath(value, path))
    if (ms != null) return ms
  }
  return null
}

function firstString(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const v = valueAtPath(value, path)
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return null
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let cur = value
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function timeMsFromUnknown(value: unknown): number | null {
  const numeric = numberFromUnknown(value)
  if (numeric != null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

async function readStatusJson(root: string, timeoutMs: number): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(locateCk(), ["--status-json"], { cwd: root, signal: ctl.signal })
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, reason: `ck --status-json spawn failed: ${(e as Error).message}` }
  }

  let stdout = ""
  let stderr = ""
  proc.stdout.setEncoding("utf8")
  proc.stderr.setEncoding("utf8")
  proc.stdout.on("data", (chunk: string) => { stdout += chunk })
  proc.stderr.on("data", (chunk: string) => { stderr += chunk })

  const rc = await new Promise<number>((resolve) => {
    proc.on("error", (e: Error) => resolve(e.name === "AbortError" || ctl.signal.aborted ? 124 : 2))
    proc.on("close", (code) => resolve(code ?? 0))
  })
  clearTimeout(timer)

  if (rc !== 0) return { ok: false, reason: `ck --status-json unavailable (rc=${rc}${stderr ? `: ${stderr.trim().slice(0, 120)}` : ""})` }
  try {
    return { ok: true, value: JSON.parse(stdout.trim()) }
  } catch {
    return { ok: false, reason: "ck --status-json returned non-JSON output" }
  }
}
