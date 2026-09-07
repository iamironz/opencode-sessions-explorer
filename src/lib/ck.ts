import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { exportRoot } from "./export.js"
import { SessionsError } from "./errors.js"

export type CkHit = {
  path: string
  span: { byte_start: number; byte_end: number; line_start: number; line_end: number }
  language: string | null
  snippet: string
  score: number
}

export type CkOptions = {
  query: string
  scopes: string[]
  topk?: number
  contextLines?: number
  caseSensitive?: boolean
  wholeWord?: boolean
  fixedString?: boolean
  noSnippet?: boolean
  excludePatterns?: string[]
  timeoutMs?: number
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

function defaultCkCandidates(): string[] {
  const home = process.env.HOME ?? ""
  const candidates = [
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

  const args = ["--jsonl", "--regex"]
  if (opts.topk != null) args.push("--topk", String(opts.topk))
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
