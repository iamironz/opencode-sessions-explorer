/**
 * Thin shell-out wrapper for the `ck` CLI (https://github.com/BeaconBay/ck).
 *
 * ck modes:
 *   regex   — drop-in grep, no index needed (fast on small scope)
 *   lex     — BM25 full-text, auto-builds Tantivy index
 *   sem     — semantic embeddings, requires `ck --index .` (slow to build)
 *   hybrid  — RRF of regex + semantic
 *
 * We use `--jsonl` for structured output. Each line is one hit:
 *   { path, span:{byte_start,byte_end,line_start,line_end}, language, snippet, score }
 *
 * Timeouts are enforced by killing the child process via AbortController.
 */
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
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
    process.env.OPENCODE_SESSIONS_EXPLORER_CK_BIN,
    // Common cross-platform install locations
    home ? `${home}/.cargo/bin/ck` : null,
    "/usr/local/bin/ck",
    "/opt/homebrew/bin/ck",
    "/usr/bin/ck",
  ].filter((p): p is string => !!p)
  return candidates
}

export function locateCk(): string {
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
    proc.on("error", (e: any) => {
      if (e?.name === "AbortError" || ctl.signal.aborted) { timedOut = true; resolve(124) }
      else resolve(2)
    })
    proc.on("close", (code) => resolve(code ?? 0))
  })
  if (timer) clearTimeout(timer)

  // Flush trailing buf
  if (buf.trim()) {
    try { const obj = JSON.parse(buf.trim()); if (obj?.path) hits.push(obj as CkHit) } catch {}
  }

  return { hits, rc, stderr, durationMs: Date.now() - start, timedOut }
}

async function runCkMultiScope(opts: CkOptions): Promise<CkRunResult> {
  const start = Date.now()
  const hits: CkHit[] = []
  let stderr = ""
  let rc = 1
  let timedOut = false
  const topk = opts.topk ?? 50
  const perScopeTopk = Math.max(5, Math.ceil(topk / Math.max(1, opts.scopes.length)))

  for (const scope of opts.scopes) {
    const elapsed = Date.now() - start
    const remaining = opts.timeoutMs == null ? undefined : Math.max(1, opts.timeoutMs - elapsed)
    if (remaining != null && remaining <= 1) { timedOut = true; break }
    const res = await runCk({ ...opts, scopes: [scope], timeoutMs: remaining, topk: perScopeTopk })
    hits.push(...res.hits)
    if (res.stderr) stderr += (stderr && !stderr.endsWith("\n") ? "\n" : "") + res.stderr
    if (res.timedOut) timedOut = true
    if (res.rc === 0) rc = 0
    else if (rc !== 0 && res.rc !== 1) rc = res.rc
  }

  return {
    hits: hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topk),
    rc,
    stderr,
    durationMs: Date.now() - start,
    timedOut,
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
