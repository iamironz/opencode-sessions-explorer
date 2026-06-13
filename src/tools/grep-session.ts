/**
 * opencode-sessions-explorer-grep-session
 *
 * Pattern search inside ONE session via `ck` regex over its export directory.
 * Fast (~100 files per session). Cap: 160 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { runCk } from "../lib/ck.js"
import { channelExportComplete, runExport, exportRoot } from "../lib/export.js"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { truncateString, redactSecrets } from "../lib/truncate.js"
import { CHANNELS, channelsForSurface, inferSurface, type SearchChannel, type SearchSurface } from "../lib/channel.js"
import { table } from "../lib/table.js"

export const grepSession = tool({
  description:
    "opencode-sessions-explorer: grep/regex search inside ONE specific OpenCode session's body content (when you already have the session id). " +
    "Answers: \"inside session ses_X, grep for Y\", \"search session ses_Z for pattern P\", \"find references to X within session ses_Y\", \"regex search in a single session\", \"look up keyword W inside session ses_V\". " +
    "Operates only on the filesystem export of one session's parts (~50-500 files) so it's fast (<200ms typical). Auto delta-syncs any new parts since the last call. " +
    "Default surface is `recall`, searching curated conversation/session-summary channels when available. Use `surface:'forensics'` or channels:['raw'] to search raw exported bodies including tool output and reasoning. " +
    "Modes: 'regex' (default — like grep) or 'lex' (BM25 phrase). Supports fixed_string (literal match, no regex special chars), case_sensitive, whole_word, context_lines (lines before/after match). " +
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
        ctx.indexStatus = syncRes.exported > 0 ? "fresh" : "fresh"
      } catch (e) {
        ctx.warnings.push(`delta sync skipped: ${(e as Error).message}`)
        ctx.indexStatus = "stale"
      }

      const surface = inferSurface(args.pattern, args.surface as SearchSurface)
      const channels = Array.from(new Set(args.channels?.length ? args.channels as SearchChannel[] : channelsForSurface(surface, args.pattern)))
      const scopes = resolveSessionScopes(exportRoot(), args.session_id, channels, ctx)
      if (scopes.length === 0) fail("INDEX_MISSING", `session not in export tree (may be very new): ${args.session_id}`, "Run delta-sync or bulk-export.")

      const ck = await runCk({
        mode: args.mode,
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
      if (ck.rc !== 0 && ck.rc !== 1) ctx.warnings.push(`ck rc=${ck.rc} stderr=${truncateString(ck.stderr, 256).value}`)

      const matches = ck.hits.slice(0, args.limit).map((h) => enrichHit(h, args.redact))
      return {
        session_id: args.session_id,
        session_title: session.title,
        archived: session.time_archived != null,
        pattern: args.pattern,
        surface,
        channels,
        mode: args.mode,
        scanned_files: matches.length, // ck doesn't report total scanned in jsonl; approximate
        matches: table(matches, { dict: ["channel"] }),
        ck_duration_ms: ck.durationMs,
      }
    })
  },
})

function enrichHit(h: any, redact: boolean) {
  // ck path format: ".../by-session/<ses_id>/<NNNN>-<prt_id>.txt"
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
