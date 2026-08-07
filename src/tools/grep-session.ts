/**
 * opencode-sessions-explorer-grep-session
 *
 * Pattern search inside ONE session via ripgrep over its export directory.
 * `ck` is no longer used here: ck is pathologically slow and manifest-heavy
 * (see `../lib/rg.ts` module doc), and this tool never needed ck's semantic
 * modes in the first place — it only ever exposed `regex`/`lex`, both of
 * which ripgrep serves directly with no index to build or keep fresh.
 * Fast (~100 files per session). Cap: 160 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { runRg, rgAvailable, type RgHit } from "../lib/rg.js"
import { isLiteralPattern } from "../lib/query-plan.js"
import { channelExportComplete, runExport, exportRoot } from "../lib/export.js"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { truncateString, redactSecrets } from "../lib/truncate.js"
import { CHANNELS, channelsForSurface, inferSurface, type SearchChannel, type SearchSurface } from "../lib/channel.js"
import { table } from "../lib/table.js"

export const grepSession = tool({
  description:
    "opencode-sessions-explorer: grep/regex search inside ONE specific OpenCode session's body content (when you already have the session id). " +
    "Answers: \"inside session ses_X, grep for Y\", \"search session ses_Z for pattern P\", \"find references to X within session ses_Y\", \"regex search in a single session\", \"look up keyword W inside session ses_V\". " +
    "Operates only on the filesystem export of one session's parts (~50-500 files) so it's fast (<200ms typical) — backed by ripgrep, not ck, so there is no index to build or keep fresh. Auto delta-syncs any new parts since the last call. " +
    "Default surface is `recall`, searching curated conversation/session-summary channels when available. Use `surface:'forensics'` or channels:['raw'] to search raw exported bodies including tool output and reasoning. " +
    "Modes: 'regex' (default — like grep, a real regex) or 'lex' (treated as a literal substring within this one session — no BM25 index here; use search-text's 'lex' mode for BM25-ranked cross-session search). Supports fixed_string (literal match, no regex special chars), case_sensitive, whole_word, context_lines (lines before/after match, read directly from the matched file). " +
    "For CROSS-SESSION content search (across ALL your OpenCode sessions) use search-text instead — that one supports group_by_session, role filter, and semantic modes.",
  args: {
    session_id: tool.schema.string().describe("Session ID"),
    pattern: tool.schema.string().describe("Pattern (regex by default unless fixed_string=true)"),
    surface: tool.schema.enum(["recall", "debug_trace", "tool_audit", "code", "forensics"]).default("recall"),
    channels: tool.schema.array(tool.schema.enum(CHANNELS)).optional().describe("Override surface-derived channels. Use raw for current full-fidelity behavior."),
    mode: tool.schema.enum(["regex", "lex"]).default("regex"),
    fixed_string: tool.schema.boolean().default(false).describe("Treat pattern as fixed string (no regex)"),
    case_sensitive: tool.schema.boolean().default(false),
    whole_word: tool.schema.boolean().default(false),
    context_lines: tool.schema.number().int().min(0).max(10).default(1),
    limit: tool.schema.number().int().min(1).max(200).default(50),
    redact: tool.schema.boolean().default(true).describe("Mask obvious secrets in snippets"),
  },
  async execute(args) {
    return runWithEnvelope("grep_session", 160, async (ctx) => {
      // Confirm session exists
      const session = stmt(`SELECT id, title, directory, time_archived FROM session WHERE id = ?`).get(args.session_id) as any
      if (!session) fail("NOT_FOUND", `session not found: ${args.session_id}`)

      // Delta-sync (cheap if up to date)
      try {
        const syncRes = await runExport({ budgetMs: 3000 })
        if (syncRes.lock_skipped) {
          ctx.warnings.push("delta sync skipped: export lock is held by another process; results may use stale/partial export data.")
          ctx.indexStatus = "stale"
        } else {
          ctx.indexStatus = "fresh"
        }
      } catch (e) {
        ctx.warnings.push(`delta sync skipped: ${(e as Error).message}`)
        ctx.indexStatus = "stale"
      }

      const surface = inferSurface(args.pattern, args.surface as SearchSurface)
      const channels = Array.from(new Set(args.channels?.length ? args.channels as SearchChannel[] : channelsForSurface(surface, args.pattern)))
      const scopes = resolveSessionScopes(exportRoot(), args.session_id, channels, ctx)
      if (scopes.length === 0) fail("INDEX_MISSING", `session not in export tree (may be very new): ${args.session_id}`, "Run delta-sync or bulk-export.")

      if (!rgAvailable()) {
        fail("RG_NOT_FOUND", "rg CLI not found in $PATH", "install via 'brew install ripgrep'")
      }

      // `lex` has no local BM25 index available to grep-session (fts is out of
      // scope for a single-session tool; ck is reserved for sem/hybrid). Its
      // closest honest equivalent is a literal substring match, same as
      // `fixed_string:true` on the regex path. `isLiteralPattern` also governs
      // whether an already-literal regex query gets the (faster) -F treatment.
      const treatAsFixedString = args.mode === "lex" ? true : (args.fixed_string || isLiteralPattern(args.pattern, args.fixed_string))

      const rg = await runRg({
        query: args.pattern,
        scopes,
        fixedString: treatAsFixedString,
        caseSensitive: args.case_sensitive,
        wholeWord: args.whole_word,
        topk: args.limit,
        timeoutMs: 10000,
      })
      if (rg.timedOut) ctx.warnings.push("rg timed out at 10 s")
      if (rg.truncated) ctx.warnings.push(`rg stopped after reaching the ${args.limit}-hit limit; results may be partial.`)
      if (rg.rc !== 0 && rg.rc !== 1) ctx.warnings.push(`rg rc=${rg.rc} stderr=${truncateString(rg.stderr, 256).value}`)

      const fileLinesCache = new Map<string, string[]>()
      const matches = rg.hits.slice(0, args.limit).map((h) => enrichHit(h, args.context_lines, args.redact, fileLinesCache))
      return {
        session_id: args.session_id,
        session_title: session.title,
        archived: session.time_archived != null,
        pattern: args.pattern,
        surface,
        channels,
        mode: args.mode,
        scanned_files: new Set(rg.hits.map((h) => h.path)).size,
        matches: table(matches, { dict: ["channel"] }),
        rg_duration_ms: rg.durationMs,
      }
    })
  },
})

/**
 * Small per-call cache so hits on the same file (common when a pattern
 * appears more than once in one part) only pay the file-read cost once.
 */
function readFileLinesCached(path: string, cache: Map<string, string[]>): string[] {
  const cached = cache.get(path)
  if (cached) return cached
  let lines: string[] = []
  try {
    lines = readFileSync(path, "utf8").split("\n")
  } catch {
    lines = []
  }
  cache.set(path, lines)
  return lines
}

function enrichHit(h: RgHit, contextLines: number, redact: boolean, fileLinesCache: Map<string, string[]>) {
  // Export path format: ".../by-session/<ses_id>/<NNNN>-<prt_id>.txt"
  const parsed = parseHitPath(h.path)
  const snippetText = buildContextSnippet(h, contextLines, fileLinesCache)
  let snippet = snippetText
  if (redact) snippet = redactSecrets(snippet)
  const lineNumber = h.line_number
  return {
    part_id: parsed.partId,
    channel: parsed.channel,
    path: h.path,
    line_start: lineNumber != null ? Math.max(1, lineNumber - contextLines) : null,
    line_end: lineNumber != null ? lineNumber + contextLines : null,
    byte_start: h.byte_offset,
    byte_end: h.match_end != null && h.byte_offset != null ? h.byte_offset + (h.match_end - (h.match_start ?? 0)) : null,
    score: null,
    snippet: truncateString(snippet, 400).value,
  }
}

/**
 * rg --json only emits `match` events (see rg.ts module doc — it never passes
 * -A/-B/-C, so `context` events are never produced). To honor `context_lines`
 * without editing rg.ts, we read the surrounding lines directly out of the
 * already-located export file (each file is a small per-part export, so this
 * is cheap) and stitch a multi-line snippet ourselves.
 */
function buildContextSnippet(h: RgHit, contextLines: number, fileLinesCache: Map<string, string[]>): string {
  if (contextLines <= 0 || h.line_number == null) return h.line_text
  const lines = readFileLinesCached(h.path, fileLinesCache)
  if (lines.length === 0) return h.line_text
  const idx = h.line_number - 1 // rg line_number is 1-based
  const from = Math.max(0, idx - contextLines)
  const to = Math.min(lines.length - 1, idx + contextLines)
  if (from === to && from === idx) return h.line_text
  return lines.slice(from, to + 1).join("\n")
}

function parseHitPath(p: string): { partId: string | null; channel: SearchChannel } {
  const ch = /\/by-channel\/([^/]+)\/by-session\/ses_[A-Za-z0-9_-]+\/(?:summary\.txt|(?:\d{5}-)?(prt_[A-Za-z0-9_-]+)\.txt)$/.exec(p)
  if (ch) return { partId: ch[2] ?? null, channel: (ch[1] as SearchChannel) ?? "raw" }
  const m = /\/\d{5}-(prt_[A-Za-z0-9_-]+)\.txt$/.exec(p)
  return { partId: m?.[1] ?? null, channel: "raw" }
}

function resolveSessionScopes(root: string, sessionId: string, channels: SearchChannel[], ctx: any): string[] {
  const rawDir = join(root, "by-session", sessionId)
  if (channels.includes("raw")) return existsSync(rawDir) ? [rawDir] : []
  if (!channelExportComplete(root)) {
    if (existsSync(rawDir)) {
      ctx.warnings.push("curated channel export is partial — using raw session export to avoid false negatives. Run opencode-sessions-explorer-bulk-export --reset to enable curated channels by default.")
      return [rawDir]
    }
    return []
  }
  const channelDirs = channels.map((ch) => join(root, "by-channel", ch, "by-session", sessionId)).filter((p) => existsSync(p))
  if (channelDirs.length > 0) return channelDirs
  if (existsSync(rawDir)) {
    ctx.warnings.push("curated channel export missing for this session — falling back to raw session export.")
    return [rawDir]
  }
  return []
}
