/**
 * Thin shell-out wrapper for the `rg` (ripgrep) CLI.
 *
 * Replaces `ck --regex` for plain regex/fixed-string search: ck is
 * pathologically slow on large export trees (11.5s for a single channel
 * root, >120s for two roots at once) while `rg -F` over the same two roots
 * finishes in ~1.66s. Unlike `ck`, ALL scopes are passed to a single `rg`
 * invocation — rg natively accepts multiple path arguments, so there is no
 * need (and no benefit) to loop per-scope the way the ck multi-scope
 * fallback does.
 *
 * We use `rg --json` for structured output (JSON Lines). Event types:
 *   begin   — start of a per-file search (ignored)
 *   match   — a matching line (the only event type we care about)
 *   context — a context line (ignored; we never pass -A/-B/-C)
 *   end     — end of a per-file search (ignored)
 *   summary — final stats (ignored)
 *
 * Timeouts are enforced by killing the child process via AbortController,
 * mirroring `runCk` in ./ck.js. `topk` is enforced by counting parsed match
 * events as they stream in and killing the child early once the cap is
 * reached, since an unbounded query can emit hundreds of thousands of lines.
 */
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { statSync, accessSync, constants as fsConstants } from "node:fs"
import { isAbsolute, join } from "node:path"
import { SessionsError, type ErrorCode } from "./errors.js"

export type RgHit = {
  path: string
  line_number: number | null
  byte_offset: number | null
  line_text: string
  match_start: number | null
  match_end: number | null
}

export type RgOptions = {
  query: string
  scopes: string[]
  fixedString?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  topk?: number
  maxCountPerFile?: number
  timeoutMs?: number
  globs?: string[]
}

export type RgRunResult = {
  hits: RgHit[]
  rc: number
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
}

/** Defensive cap so a single pathological (e.g. minified) line can't blow up memory. */
const MAX_LINE_TEXT_LEN = 4000

/**
 * Locate the `rg` binary. Resolution order:
 *   1. $OPENCODE_SESSIONS_EXPLORER_RG_BIN env override (absolute path, or a
 *      bare name resolved against $PATH)
 *   2. Common install locations checked for absolute presence
 *   3. Fall back to a real $PATH scan for bare `rg`
 */
function defaultRgCandidates(): string[] {
  const home = process.env.HOME ?? ""
  return [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
    home ? `${home}/.cargo/bin/rg` : null,
  ].filter((p): p is string => !!p)
}

/**
 * True when `path` is a regular file AND (on POSIX) executable by this
 * process. Mere existence is NOT enough: a present-but-non-executable file
 * (the auditor's repro used `OPENCODE_SESSIONS_EXPLORER_RG_BIN=/etc/hosts`)
 * previously made `rgAvailable()` report `true`, and `runRg()` then failed
 * at spawn time as a bare `rc=2` with zero hits instead of a structured
 * error — a search reporting success with an empty result set while
 * ripgrep never actually ran. This is the fix for that exact failure mode.
 *
 * Windows has no POSIX execute-permission bit: `fs.constants.X_OK` on
 * Windows only checks the file exists (it cannot distinguish "executable"
 * there), and Windows resolves what's runnable via file extension +
 * `%PATHEXT%`, not a permission bit. Applying the POSIX X_OK semantics on
 * win32 would therefore report a real, working `rg.exe` as unavailable —
 * strictly worse than the bug we're fixing. So this degrades to the
 * existence + regular-file check on win32, matching the previous (pre-fix)
 * behavior there rather than introducing a new, meaningless failure mode;
 * a genuinely broken Windows install still gets caught at spawn time by
 * the structured-error handling in `runRg` below.
 */
function isExecutable(path: string): boolean {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch {
    return false
  }
  if (!st.isFile()) return false
  if (process.platform === "win32") return true
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Scan `$PATH` for an executable regular file named `bin`. This is the
 * actual probe that used to be skipped for the bare `"rg"` fallback — the
 * old code returned `true` from `rgAvailable()` on the mere ASSUMPTION that
 * $PATH resolution would work, so a genuinely missing `rg` only surfaced
 * later, asynchronously, as a spawn error (see the ENOENT handling in
 * `runRg` below) rather than as a clean, synchronous "not available".
 */
function resolveOnPath(bin: string): string | null {
  const pathEnv = process.env.PATH ?? ""
  const sep = process.platform === "win32" ? ";" : ":"
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    const candidate = join(dir, bin)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function locateRg(): string {
  const override = process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
  if (override) {
    if (isAbsolute(override)) return override
    return resolveOnPath(override) ?? override
  }
  for (const c of defaultRgCandidates()) {
    if (isExecutable(c)) return c
  }
  return resolveOnPath("rg") ?? "rg"
}

// Cheap per-process cache: rgAvailable() is called once per search, and the
// underlying probe is a handful of existsSync/statSync calls, but there is
// no reason to repeat that filesystem work every call within one process.
// Keyed by the override env var so tests that flip
// OPENCODE_SESSIONS_EXPLORER_RG_BIN between runs still get a fresh probe.
let _rgAvailableCache: boolean | null = null
let _rgAvailableCacheKey: string | undefined

/**
 * Real availability probe — actually resolves the binary rather than
 * assuming a bare `"rg"` name will succeed against $PATH at spawn time.
 * Previously this returned `true` for the bare-name fallback unconditionally,
 * so a genuinely missing ripgrep install reported `rgAvailable() === true`
 * and the failure only surfaced later as an async spawn `rc=2` — a search
 * tool could return a successful EMPTY result with only a warning, a silent
 * false negative. See runRg's ENOENT handling for the complementary fix.
 */
export function rgAvailable(): boolean {
  const key = process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
  if (_rgAvailableCache !== null && _rgAvailableCacheKey === key) return _rgAvailableCache
  const resolved = locateRg()
  const ok = isAbsolute(resolved) ? isExecutable(resolved) : resolveOnPath(resolved) !== null
  _rgAvailableCache = ok
  _rgAvailableCacheKey = key
  return ok
}

function truncateLineText(s: string): string {
  return s.length > MAX_LINE_TEXT_LEN ? s.slice(0, MAX_LINE_TEXT_LEN) : s
}

/** Strip a single trailing newline (rg's `lines.text` includes it). */
function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s
}

/**
 * Classify a spawn-level (not rg-process-level) failure. `ENOENT` means the
 * resolved path doesn't exist -> `RG_NOT_FOUND` (the "not installed" case).
 * Anything else — `EACCES`/`EPERM` (not executable / permission denied,
 * exactly the `/etc/hosts`-as-rg-binary repro), `ENOEXEC` (exists,
 * executable bit set, but isn't a valid executable), or any other spawn
 * failure — is a real, distinct dependency problem and must never resolve
 * as a bare `rc=2` with an empty hit list: it becomes `RG_FAILED` instead.
 */
function classifySpawnError(e: any): { code: ErrorCode; message: string } {
  const errno = typeof e?.code === "string" ? e.code : undefined
  if (errno === "ENOENT") {
    return { code: "RG_NOT_FOUND", message: `rg CLI not found in $PATH; install via 'brew install ripgrep'` }
  }
  return {
    code: "RG_FAILED",
    message: `rg process failed to start${errno ? ` (${errno})` : ""}: ${e?.message ?? String(e)}`,
  }
}

export async function runRg(opts: RgOptions): Promise<RgRunResult> {
  if (!opts.scopes || opts.scopes.length === 0) {
    throw new SessionsError("BAD_ARGS", "runRg requires at least one scope (file or directory) in opts.scopes")
  }

  const args = ["--json", "--no-messages", "--no-heading", "--no-config"]
  if (opts.fixedString) args.push("-F")
  if (opts.caseSensitive !== true) args.push("-i")
  if (opts.wholeWord) args.push("-w")
  if (opts.maxCountPerFile != null) args.push("-m", String(opts.maxCountPerFile))
  if (opts.globs) for (const g of opts.globs) args.push("-g", g)
  args.push("--", opts.query, ...opts.scopes)

  const start = Date.now()
  const ctl = new AbortController()
  const timer = opts.timeoutMs ? setTimeout(() => ctl.abort(), opts.timeoutMs) : null

  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(locateRg(), args, { signal: ctl.signal })
  } catch (e: any) {
    if (timer) clearTimeout(timer)
    const { code, message } = classifySpawnError(e)
    throw new SessionsError(code, message)
  }

  const hits: RgHit[] = []
  let stderr = ""
  let buf = ""
  let timedOut = false
  let truncated = false
  const topk = opts.topk

  const maybeParseLine = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      return // swallow malformed lines
    }
    if (!obj || obj.type !== "match") return
    const data = obj.data ?? {}
    const path: string = typeof data.path?.text === "string" ? data.path.text : ""
    const lineNumber: number | null = typeof data.line_number === "number" ? data.line_number : null
    const byteOffset: number | null = typeof data.absolute_offset === "number" ? data.absolute_offset : null
    let lineText = ""
    if (typeof data.lines?.text === "string") {
      lineText = truncateLineText(stripTrailingNewline(data.lines.text))
    } else {
      // data.lines.bytes (base64, non-UTF8 content) — fall back to empty rather than crash.
      lineText = ""
    }
    const firstSub = Array.isArray(data.submatches) ? data.submatches[0] : undefined
    const matchStart: number | null = typeof firstSub?.start === "number" ? firstSub.start : null
    const matchEnd: number | null = typeof firstSub?.end === "number" ? firstSub.end : null

    hits.push({
      path,
      line_number: lineNumber,
      byte_offset: byteOffset,
      line_text: lineText,
      match_start: matchStart,
      match_end: matchEnd,
    })

    if (topk != null && hits.length >= topk) {
      truncated = true
      try { proc.kill() } catch { /* already exited */ }
    }
  }

  proc.stdout.setEncoding("utf8")
  proc.stderr.setEncoding("utf8")

  proc.stdout.on("data", (chunk: string) => {
    if (truncated) return
    buf += chunk
    let idx: number
    while (!truncated && (idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      maybeParseLine(line)
    }
  })
  proc.stderr.on("data", (chunk: string) => { stderr += chunk })

  // A spawn-time failure (ENOENT, EACCES/EPERM for a non-executable file,
  // ENOEXEC, ...) can arrive asynchronously via the child's "error" event
  // (rather than synchronously from `spawn()` itself, which is already
  // caught above) — e.g. when the resolved path looked plausible but the
  // binary vanished, or platform-specific spawn timing. Capture it distinctly
  // from a normal exit so it can be translated into a structured error
  // instead of silently surfacing as rc=2 (a successful-looking empty
  // result with only a warning) — the exact bug this module exists to fix.
  let spawnError: { code: ErrorCode; message: string } | null = null
  const rc = await new Promise<number>((resolve) => {
    proc.on("error", (e: any) => {
      if (e?.name === "AbortError" || ctl.signal.aborted) { timedOut = true; resolve(124); return }
      spawnError = classifySpawnError(e)
      resolve(2)
    })
    proc.on("close", (code) => {
      if (ctl.signal.aborted) { timedOut = true; resolve(124); return }
      resolve(code ?? 0)
    })
  })
  if (timer) clearTimeout(timer)

  if (spawnError) {
    const { code, message } = spawnError as { code: ErrorCode; message: string }
    throw new SessionsError(code, message)
  }

  // Flush trailing buf (last line without a terminating newline).
  if (!truncated && buf.trim()) maybeParseLine(buf)

  // rg exit codes: 0 = matches found, 1 = no matches (not an error), 2 = a
  // genuine rg-level usage/runtime error (invalid pattern, permission
  // denied on a search-path argument, etc). Unlike rc=1, this must NEVER be
  // returned as a normal (if empty) result: that is indistinguishable from
  // "the query legitimately found nothing" to a caller and masks a real
  // failure as silent success. Surface it as a structured error carrying
  // rg's own stderr so the underlying reason (e.g. a malformed regex) isn't
  // lost.
  if (!timedOut && rc === 2) {
    const detail = stderr.trim()
    throw new SessionsError("RG_FAILED", `rg exited with a usage/runtime error (exit code 2)${detail ? `: ${detail}` : ""}`)
  }

  return { hits, rc, stderr, durationMs: Date.now() - start, timedOut, truncated }
}
