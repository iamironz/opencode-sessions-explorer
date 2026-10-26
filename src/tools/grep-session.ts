import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { runCk, type CkScopeCoverage } from "../lib/ck.js"
import { channelExportComplete, runExport, exportRoot } from "../lib/export.js"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { truncateString, redactSecrets } from "../lib/truncate.js"
import { CHANNELS, channelsForSurface, inferSurface, type SearchChannel, type SearchSurface } from "../lib/channel.js"
import { table } from "../lib/table.js"
import { defineTool } from "../lib/tool-v2.js"

export const grepSession = defineTool<{
  session_id: string
  pattern: string
  surface: SearchSurface
  channels?: readonly SearchChannel[]
  fixed_string: boolean
  case_sensitive: boolean
  whole_word: boolean
  context_lines: number
  limit: number
  redact: boolean
} & Record<string, unknown>>({
  name: "opencode-sessions-explorer-grep-session",
  removedArgs: { mode: "mode is not supported by grep-session (semantic modes were removed); grep always uses regex — remove this parameter" },
  description:
    "opencode-sessions-explorer: grep/regex search inside ONE specific OpenCode session's body content (when you already have the session id). " +
    "Answers: \"inside session ses_X, grep for Y\", \"search session ses_Z for pattern P\", \"find references to X within session ses_Y\", \"regex search in a single session\", \"look up keyword W inside session ses_V\". " +
    "Operates only on the filesystem export of one session's parts (~50-500 files) so it's fast (<200ms typical). Auto delta-syncs any new parts since the last call. " +
    "Default surface is `recall`, searching curated conversation/session-summary channels when available. Use `surface:'forensics'` or channels:['raw'] to search raw exported bodies including tool output and reasoning. " +
    "Uses regex search. Supports fixed_string (literal match, no regex special chars), case_sensitive, whole_word, context_lines (lines before/after match). " +
    "For CROSS-SESSION content search (across ALL your OpenCode sessions) use search-text instead — that one supports group_by_session and role filter.",
  args: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session ID" },
      pattern: { type: "string", description: "Pattern (regex by default unless fixed_string=true)" },
      surface: { type: "string", enum: ["recall", "debug_trace", "tool_audit", "code", "forensics"], default: "recall" },
      channels: { type: "array", items: { type: "string", enum: [...CHANNELS] }, description: "Override surface-derived channels. Use raw for current full-fidelity behavior." },
      fixed_string: { type: "boolean", default: false, description: "Treat pattern as fixed string (no regex)" },
      case_sensitive: { type: "boolean", default: false },
      whole_word: { type: "boolean", default: false },
      context_lines: { type: "integer", minimum: 0, maximum: 10, default: 1 },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      redact: { type: "boolean", default: true, description: "Mask obvious secrets in snippets" },
    },
    required: ["session_id", "pattern"],
  },
  async execute(args) {
    return runWithEnvelope("grep_session", 160, async (ctx) => {
      if ("mode" in (args as object)) {
        fail("BAD_ARGS", "mode is not supported by grep-session", "Remove mode; grep-session always uses regex.")
      }
      const session = stmt(`SELECT id, title, directory, time_archived FROM session_v2 WHERE id = ?`).get(args.session_id) as any
      if (!session) fail("NOT_FOUND", `session not found: ${args.session_id}`)

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

      const ck = await runCk({
        query: args.pattern,
        scopes,
        topk: args.limit,
        contextLines: args.context_lines,
        caseSensitive: args.case_sensitive,
        wholeWord: args.whole_word,
        fixedString: args.fixed_string,
        timeoutMs: 10000,
      })
      if (ck.timedOut) ctx.warnings.push("ck timed out at 10 s")
      warnOnPartialScopeCoverage(ctx, ck.scopeCoverage)
      if (ck.rc !== 0 && ck.rc !== 1) ctx.warnings.push(`ck rc=${ck.rc} stderr=${truncateString(ck.stderr, 256).value}`)

      const matches = ck.hits.slice(0, args.limit).map((h) => enrichHit(h, args.redact))
      return {
        session_id: args.session_id,
        session_title: session.title,
        archived: session.time_archived != null,
        pattern: args.pattern,
        surface,
        channels,
        mode: "regex",
        scanned_files: matches.length,
        matches: table(matches, { dict: ["channel"] }),
        ck_duration_ms: ck.durationMs,
        ck_scope_coverage: ck.scopeCoverage,
      }
    })
  },
})

function warnOnPartialScopeCoverage(ctx: any, coverage: CkScopeCoverage): void {
  if (!coverage.truncated) return
  ctx.warnings.push(
    `ck searched ${coverage.searched_scopes}/${coverage.total_scopes} scopes before stopping; results are partial and ${coverage.omitted_scopes} scopes were not searched. ` +
    "Narrow channels/surface or retry with a smaller session export.",
  )
}

function enrichHit(h: any, redact: boolean) {
  // ck path format: ".../by-session/<ses_id>/<NNNN>-<part_id>.txt"
  const parsed = parseHitPath(h.path)
  let snippet = h.snippet ?? ""
  if (redact) snippet = redactSecrets(snippet)
  return {
    part_id: parsed.partId,
    channel: parsed.channel,
    path: h.path,
    line_start: h.span?.line_start ?? null,
    line_end: h.span?.line_end ?? null,
    byte_start: h.span?.byte_start ?? null,
    byte_end: h.span?.byte_end ?? null,
    score: h.score ?? null,
    snippet: truncateString(snippet, 400).value,
  }
}

function parseHitPath(p: string): { partId: string | null; channel: SearchChannel } {
  const ch = /\/by-channel\/([^/]+)\/by-session\/ses_[A-Za-z0-9_-]+\/(?:summary\.txt|(?:\d{5}-)?(msg_[A-Za-z0-9_-]+#\d+)\.txt)$/.exec(p)
  if (ch) return { partId: ch[2] ?? null, channel: (ch[1] as SearchChannel) ?? "raw" }
  const m = /\/\d{5}-(msg_[A-Za-z0-9_-]+#\d+)\.txt$/.exec(p)
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
