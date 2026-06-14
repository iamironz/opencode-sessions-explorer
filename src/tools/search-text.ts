/**
 * opencode-sessions-explorer-search-text
 *
 * Canonical interface for "where in my OpenCode history did X happen?" and
 * "find sessions mentioning Y" queries. Backed by the local `ck` CLI over the
 * filesystem export of session content.
 *
 * Modes:
 *   regex   — drop-in grep, no index needed (default; works always)
 *   lex     — BM25 full-text (auto-builds Tantivy index)
 *   sem     — semantic embeddings (ck lazily builds/refreshes the index)
 *   hybrid  — combined regex + semantic (ck lazily builds/refreshes the index)
 *
 * SCOPING: cross-session content search has unbounded fan-out. To keep response
 * times reasonable, callers SHOULD pre-filter via session_ids / project_id /
 * agent / since_ms. The tool dispatches to ck only on the resulting scope set.
 *
 * Cap: 160 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope } from "../lib/envelope.js"
import { runCk, ckIndexFreshness, type CkIndexFreshness, type CkIndexStatus, type CkScopeCoverage } from "../lib/ck.js"
import { channelExportComplete, runExport, exportRoot } from "../lib/export.js"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { truncateString, redactSecrets, snippet as makeSnippet } from "../lib/truncate.js"
import { decodeModel } from "../lib/decode.js"
import { CHANNELS, channelsForSurface, channelWeight, inferSurface, looksLikeExactIdentifier, normalizeForDedupe, type SearchChannel, type SearchSurface } from "../lib/channel.js"
import { table } from "../lib/table.js"

export const searchText = tool({
  description:
    "opencode-sessions-explorer: full-text search across the BODIES of all your prior OpenCode sessions (the actual conversation content — user prompts, assistant responses, tool inputs/outputs, reasoning, file references, patches, subtask prompts). " +
    "Answers any of: \"where in my OpenCode history did I mention X\", \"find sessions about Y\", \"have I ever discussed Z\", \"look up earlier conversations about W\", \"all references to V across my OpenCode sessions\", \"did this topic come up before\", \"when did I last talk about Q\", \"find the session where I worked on R\", \"search my prior chat content for S\", \"grep across all OpenCode sessions for T\", \"have I asked about this before\". " +
    "Default surface is `recall`: session-first, channel-aware, and evidence-limited. It searches high-signal conversation/session-summary views first and returns ranked sessions with raw part refs. " +
    "Use `surface:'forensics'` (or explicit channels including `raw`) for exhaustive raw replay over tool output, reasoning, patches, and all exported bodies. " +
    "ARG `group_by_session`: when true, rolls hits up to one row per session with hit_count, first/last seen timestamps, evidence snippets, and channel counts. If omitted, unscoped recall defaults to true; scoped one-session searches default to flat hits. " +
    "CRITICAL ARG `role` (default 'any'): which message roles to search inside. **Default to 'any'** for natural-language questions like \"where did I mention X\", \"find sessions about Y\", \"did I discuss Z\" — these are asking about appearances ANYWHERE in your conversations (user prompts AND assistant text AND tool I/O AND reasoning). " +
    "Only set role='user' when the user EXPLICITLY narrows to authored messages: \"what prompts have I typed containing X\", \"my user-authored messages mentioning Y\", \"questions I sent OpenCode with Z\". Phrases like \"did I mention\" / \"in my history\" / \"have I discussed\" do NOT imply role='user' — those are asking about the corpus as a whole. " +
    "Only set role='assistant' for questions explicitly about what the AI said (\"what has the assistant said about X\"). " +
    "Modes: 'regex' (default — drop-in grep, no index needed), 'lex' (BM25 phrase search, lets ck auto-build/update its Tantivy index), 'sem' (semantic embeddings, lets ck lazily build/refresh its index), 'hybrid' (regex + sem). " +
    "Pre-filter cross-session searches via session_ids[], project_id, agent, since_ms/until_ms — unscoped full-corpus search can take 10-30 seconds. Scoped searches return in <1s. " +
    "For grep INSIDE a single known session use grep-session instead (faster, narrower).",
  args: {
    q: tool.schema.string().describe("Search query (regex pattern, BM25 phrase, or natural-language depending on mode)"),
    mode: tool.schema.enum(["regex", "lex", "sem", "hybrid"]).default("regex"),
    surface: tool.schema.enum(["recall", "debug_trace", "tool_audit", "code", "forensics"]).default("recall").describe("Retrieval preset. recall is curated/default; forensics searches raw replay data."),
    channels: tool.schema.array(tool.schema.enum(CHANNELS)).optional().describe("Override surface-derived channels. Use raw for current full-fidelity behavior."),
    group_by_session: tool.schema.boolean().optional().describe("If true, return one entry per matching session with evidence snippets instead of one entry per part. Defaults true for unscoped recall and false for scoped/forensic searches."),
    role: tool.schema.enum(["user", "assistant", "any"]).default("any").describe("Restrict hits to parts attached to messages of this role. 'user' = only what the human typed; 'assistant' = only assistant output."),
    session_ids: tool.schema.array(tool.schema.string()).optional().describe("Restrict to these session IDs (recommended for cross-session speed)"),
    project_id: tool.schema.string().optional(),
    agent: tool.schema.string().optional(),
    since_ms: tool.schema.number().int().nonnegative().optional(),
    until_ms: tool.schema.number().int().nonnegative().optional(),
    archived: tool.schema.enum(["no", "only", "any"]).default("any"),
    limit: tool.schema.number().int().min(1).max(50).default(20).describe("Max RESULTS (hits or sessions depending on group_by_session)"),
    threshold: tool.schema.number().min(0).max(1).optional().describe("Only for sem/hybrid: min score"),
    fixed_string: tool.schema.boolean().default(false),
    case_sensitive: tool.schema.boolean().default(false),
    timeout_ms: tool.schema.number().int().min(1000).max(60000).default(20000),
    redact: tool.schema.boolean().default(true),
  },
  async execute(args) {
    return runWithEnvelope("search_text", 160, async (ctx) => {
      const surface = inferSurface(args.q, args.surface as SearchSurface)
      const channels = normalizeChannels(args.channels?.length ? args.channels : channelsForSurface(surface, args.q))
      const groupBySession = args.group_by_session ?? (surface !== "forensics" && !args.session_ids?.length)

      // Pre-filter scope: resolve to a list of session_ids in DB.
      const scopeIds = resolveScope(args)
      const root = exportRoot()
      if (scopeIds !== "all" && scopeIds.length === 0) {
        return groupBySession
          ? { sessions: table([]), hits_total: 0, mode: args.mode, surface, channels, scope_session_count: 0, ck_duration_ms: 0, suppressed: emptySuppressed(channels) }
          : { hits: table([]), mode: args.mode, scope_session_count: 0, ck_duration_ms: 0 }
      }

      if (scopeIds === "all" && (surface === "forensics" || channels.includes("raw"))) {
        ctx.warnings.push("raw unscoped forensic search can take 10-30s. Add session_ids/project_id/agent/since_ms to narrow.")
      }

      // Delta-sync (best-effort)
      let exportStatus: "fresh" | "stale" = "fresh"
      try {
        exportStatus = applyExportProgress(ctx, await runExport({ budgetMs: 4000 }))
      } catch (e) {
        ctx.warnings.push(`delta sync skipped: ${(e as Error).message}`)
        ctx.indexStatus = "stale"
        exportStatus = "stale"
      }

      const scopes = resolveCkScopes(root, scopeIds, channels, ctx)
      if (scopeIds !== "all" && scopes.length === 0) {
        ctx.warnings.push(`export scope missing after delta sync for ${scopeIds.length} DB session(s); returning empty results from stale/partial export data.`)
        return groupBySession
          ? { sessions: table([]), hits_total: 0, mode: args.mode, surface, channels, scope_session_count: scopeIds.length, ck_duration_ms: 0, suppressed: emptySuppressed(channels) }
          : { hits: table([]), mode: args.mode, scope_session_count: scopeIds.length, ck_duration_ms: 0 }
      }

      // For sem/hybrid, check index presence but still call ck in the requested
      // mode so ck's own lazy auto-indexing can run during normal search.
      let effectiveMode = args.mode
      let preSearchFreshness: CkIndexFreshness | null = null
      if (args.mode === "sem" || args.mode === "hybrid") {
        preSearchFreshness = await ckIndexFreshness(root)
        ctx.indexStatus = combineExportAndCkStatus(exportStatus, preSearchFreshness.status)
      }
      if (!ctx.mode) ctx.mode = effectiveMode

      // When group_by_session is true, fetch MORE hits so each session's hit_count is accurate.
      // The cap on output size is bounded by `limit` (number of SESSIONS); ck may return many parts per session.
      const ckTopk = groupBySession
        ? Math.min(Math.max(args.limit * 20, 100), 500)
        : Math.min(args.limit * (effectiveMode === "regex" ? 2 : 3), 150)

      const result = await runWithCk(args, scopes, effectiveMode, ctx, scopeIds === "all" ? null : scopeIds.length, ckTopk, channels, surface, groupBySession)
      if (preSearchFreshness) await refreshCkStatusAfterSearch(ctx, root, exportStatus, preSearchFreshness)
      return result
    })
  },
})

function resolveScope(args: any): "all" | string[] {
  const where: string[] = []
  const params: any[] = []
  if (args.session_ids?.length) {
    where.push(`id IN (${args.session_ids.map(() => "?").join(",")})`)
    params.push(...args.session_ids)
  }
  if (args.project_id) { where.push("project_id = ?"); params.push(args.project_id) }
  if (args.agent) { where.push("agent = ?"); params.push(args.agent) }
  if (args.since_ms !== undefined) { where.push("time_updated >= ?"); params.push(args.since_ms) }
  if (args.until_ms !== undefined) { where.push("time_updated <= ?"); params.push(args.until_ms) }
  if (args.archived === "no") where.push("time_archived IS NULL")
  else if (args.archived === "only") where.push("time_archived IS NOT NULL")
  if (where.length === 0) return "all"
  // Bump to 5000 so a since/until_ms or other filter doesn't accidentally exclude
  // older sessions where the search term may legitimately live.
  const sql = `SELECT id FROM session WHERE ${where.join(" AND ")} ORDER BY time_updated DESC LIMIT 5000`
  const rows = stmt(sql).all(...params) as { id: string }[]
  return rows.map((r) => r.id)
}

function normalizeChannels(channels: SearchChannel[]): SearchChannel[] {
  return Array.from(new Set(channels.length ? channels : ["conversation", "session-summary"]))
}

function applyExportProgress(ctx: any, progress: { lock_skipped: boolean }): "fresh" | "stale" {
  if (progress.lock_skipped) {
    ctx.warnings.push("delta sync skipped: export lock is held by another process; results may use stale/partial export data.")
    ctx.indexStatus = "stale"
    return "stale"
  }
  ctx.indexStatus = "fresh"
  return "fresh"
}

function resolveCkScopes(root: string, scopeIds: "all" | string[], channels: SearchChannel[], ctx: any): string[] {
  const rawOnly = channels.includes("raw")
  const rawRoot = join(root, "by-session")
  if (rawOnly) {
    if (scopeIds === "all") return existsSync(rawRoot) ? [rawRoot] : [root]
    return scopeIds.map((id) => join(rawRoot, id)).filter((p) => existsSync(p))
  }

  if (!channelExportComplete(root)) {
    ctx.warnings.push("curated channel export is partial — using raw by-session export to avoid false negatives. Run opencode-sessions-explorer-bulk-export --reset to enable curated channels by default.")
    if (scopeIds === "all") return existsSync(rawRoot) ? [rawRoot] : [root]
    return scopeIds.map((id) => join(rawRoot, id)).filter((p) => existsSync(p))
  }

  const channelRoots = channels.map((ch) => join(root, "by-channel", ch, "by-session"))
  if (scopeIds === "all") {
    const existing = channelRoots.filter((p) => existsSync(p))
    if (existing.length > 0) return existing
    ctx.warnings.push("curated channel export is not backfilled yet — falling back to raw by-session export. Run opencode-sessions-explorer-bulk-export to build channels.")
    return existsSync(rawRoot) ? [rawRoot] : [root]
  }

  const scoped = channelRoots.flatMap((base) => scopeIds.map((id) => join(base, id))).filter((p) => existsSync(p))
  if (scoped.length > 0) return scoped
  ctx.warnings.push("curated channel export missing for scoped sessions — falling back to raw session export.")
  return scopeIds.map((id) => join(rawRoot, id)).filter((p) => existsSync(p))
}

function emptySuppressed(channels: SearchChannel[]) {
  return { duplicate_hits: 0, omitted_channels: CHANNELS.filter((c) => !channels.includes(c) && c !== "raw") }
}

async function runWithCk(args: any, scopes: string[], mode: "regex" | "lex" | "sem" | "hybrid", ctx: any, sessionCount: number | null, topk: number, channels: SearchChannel[], surface: SearchSurface, groupBySession: boolean) {
  const ck = await runCk({
    mode,
    query: args.q,
    scopes,
    topk,
    threshold: args.threshold,
    caseSensitive: args.case_sensitive,
    fixedString: args.fixed_string,
    timeoutMs: args.timeout_ms,
  })
  if (ck.timedOut) ctx.warnings.push(`ck timed out at ${args.timeout_ms}ms`)
  warnOnPartialScopeCoverage(ctx, ck.scopeCoverage, args.timeout_ms)
  if (ck.rc !== 0 && ck.rc !== 1) ctx.warnings.push(`ck rc=${ck.rc} stderr=${truncateString(ck.stderr, 256).value}`)

  // Parse session_id + part_id per hit
  type ParsedHit = ReturnType<typeof parsePath> & { ck: typeof ck.hits[0] }
  const parsed: ParsedHit[] = ck.hits.map((h) => ({ ...parsePath(h.path), ck: h }))

  // Batch-fetch part metadata (one query for all part_ids)
  const partIds = parsed.map((p) => p.partId).filter((x): x is string => !!x)
  const partInfo = new Map<string, { id: string; message_id: string; time_created: number; type: string }>()
  if (partIds.length > 0) {
    const placeholders = partIds.map(() => "?").join(",")
    const rows = stmt(`SELECT id, message_id, time_created, json_extract(data,'$.type') AS type FROM part WHERE id IN (${placeholders})`).all(...partIds) as any[]
    for (const r of rows) partInfo.set(r.id, r)
  }

  // Batch-fetch message.role per message_id (for role filter)
  const msgIds = Array.from(new Set(Array.from(partInfo.values()).map((p) => p.message_id)))
  const roleByMsg = new Map<string, string>()
  if (msgIds.length > 0) {
    const placeholders = msgIds.map(() => "?").join(",")
    const rows = stmt(`SELECT id, json_extract(data,'$.role') AS role FROM message WHERE id IN (${placeholders})`).all(...msgIds) as any[]
    for (const r of rows) roleByMsg.set(r.id, r.role ?? "unknown")
  }

  // Batch-fetch session metadata per session_id
  const sessIds = Array.from(new Set(parsed.map((p) => p.sessionId).filter((x): x is string => !!x)))
  const sessInfo = new Map<string, any>()
  if (sessIds.length > 0) {
    const placeholders = sessIds.map(() => "?").join(",")
    const rows = stmt(`SELECT id, title, project_id, directory, agent, model, time_archived, time_updated FROM session WHERE id IN (${placeholders})`).all(...sessIds) as any[]
    for (const r of rows) sessInfo.set(r.id, r)
  }

  // Build hits + apply role filter
  const allHits = parsed.map((p) => {
    const session = p.sessionId ? sessInfo.get(p.sessionId) : null
    const part = p.partId ? partInfo.get(p.partId) : null
    const role = part ? (roleByMsg.get(part.message_id) ?? null) : null
    let snippet = centerSnippet(p.ck.snippet ?? "", args.q)
    if (args.redact) snippet = redactSecrets(snippet)
    const score = scoreHit({ channel: p.channel, role, ckScore: p.ck.score ?? null, title: session?.title ?? "", q: args.q })
    return {
      session_id: p.sessionId,
      channel: p.channel,
      part_id: p.partId,
      part_type: part?.type ?? null,
      message_id: part?.message_id ?? null,
      role,
      ts: part?.time_created ?? session?.time_updated ?? null,
      score,
      raw_score: p.ck.score ?? null,
      line_start: p.ck.span?.line_start ?? null,
      line_end: p.ck.span?.line_end ?? null,
      snippet: truncateString(snippet, 400).value,
      source: mode,
      raw_ref: p.partId
        ? { tool: "opencode-sessions-explorer-get-part", part_id: p.partId }
        : p.channel === "session-summary" && p.sessionId
          ? { tool: "opencode-sessions-explorer-session-summary", session_id: p.sessionId }
          : null,
    }
  })

  const { hits: dedupedHits, duplicateCount } = dedupeHits(allHits)

  const roleFiltered = args.role && args.role !== "any"
    ? dedupedHits.filter((h) => h.role === args.role)
    : dedupedHits

  if (groupBySession) {
    // Group hits by session_id and aggregate
    type SessionHit = {
      session_id: string | null
      session_title: string | null
      project_id: string | null
      directory: string | null
      agent: string | null
      model: any
      archived: boolean | null
      hit_count: number
      hit_count_by_channel: Record<string, number>
      first_hit_ts: number | null
      last_hit_ts: number | null
      best_score: number | null
      sample_snippet: string
      sample_part_id: string | null
      sample_role: string | null
      evidence: any[]
      why: string
    }
    const bySession = new Map<string, SessionHit>()
    for (const h of roleFiltered) {
      if (!h.session_id) continue
      const session = sessInfo.get(h.session_id)
      let cur = bySession.get(h.session_id)
      if (!cur) {
        cur = {
          session_id: h.session_id,
          session_title: session?.title ?? null,
          project_id: session?.project_id ?? null,
          directory: session?.directory ?? null,
          agent: session?.agent ?? null,
          model: session ? decodeModel(session.model) : null,
          archived: session ? session.time_archived != null : null,
          hit_count: 0,
          hit_count_by_channel: {},
          first_hit_ts: null,
          last_hit_ts: null,
          best_score: h.score,
          sample_snippet: h.snippet,
          sample_part_id: h.part_id,
          sample_role: h.role,
          evidence: [],
          why: "",
        }
        bySession.set(h.session_id, cur)
      }
      cur.hit_count++
      cur.hit_count_by_channel[h.channel] = (cur.hit_count_by_channel[h.channel] ?? 0) + 1
      if (h.ts != null) {
        if (cur.first_hit_ts == null || h.ts < cur.first_hit_ts) cur.first_hit_ts = h.ts
        if (cur.last_hit_ts == null || h.ts > cur.last_hit_ts) cur.last_hit_ts = h.ts
      }
      // Prefer the highest-score hit's snippet as the sample
      if (h.score != null && (cur.best_score == null || h.score > cur.best_score)) {
        cur.best_score = h.score
        cur.sample_snippet = h.snippet
        cur.sample_part_id = h.part_id
        cur.sample_role = h.role
      }
      cur.evidence.push({
        channel: h.channel,
        role: h.role,
        part_id: h.part_id,
        message_id: h.message_id,
        score: h.score,
        snippet: h.snippet,
        raw_ref: h.raw_ref,
      })
    }
    const sessions = Array.from(bySession.values()).map((s) => ({
      ...s,
      evidence: s.evidence.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3),
      why: buildWhy(args.q, s),
    })).sort((a, b) => {
      // sort by best_score desc then last_hit_ts desc
      const sa = a.best_score ?? 0
      const sb = b.best_score ?? 0
      if (sa !== sb) return sb - sa
      return (b.last_hit_ts ?? 0) - (a.last_hit_ts ?? 0)
    }).slice(0, args.limit)
    return {
      sessions: table(sessions, { dict: ["agent", "model", "directory", "project_id", "sample_role"] }),
      hits_total: roleFiltered.length,
      mode,
      surface,
      channels,
      scope_session_count: sessionCount,
      ck_duration_ms: ck.durationMs,
      ck_timed_out: ck.timedOut,
      ck_scope_coverage: ck.scopeCoverage,
      role_filter: args.role,
      suppressed: { ...emptySuppressed(channels), duplicate_hits: duplicateCount },
    }
  }

  const sessionMeta = Object.fromEntries(Array.from(sessInfo.entries()).map(([id, s]) => [id, {
    title: s.title,
    project_id: s.project_id,
    directory: s.directory,
    agent: s.agent,
    model: decodeModel(s.model),
    archived: s.time_archived != null,
  }]))

  // Flat hits drop the constant raw_ref object (part_id is present in-row; pass it
  // to opencode-sessions-explorer-get-part to drill down). Grouped evidence keeps raw_ref.
  const flatHits = roleFiltered
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, args.limit)
    .map(({ raw_ref, ...h }) => h)
  return {
    hits: table(flatHits, { dict: ["channel", "role", "source", "session_id", "part_type"] }),
    session_meta: sessionMeta,
    mode,
    surface,
    channels,
    scope_session_count: sessionCount,
    ck_duration_ms: ck.durationMs,
    ck_timed_out: ck.timedOut,
    ck_scope_coverage: ck.scopeCoverage,
    role_filter: args.role,
    suppressed: { ...emptySuppressed(channels), duplicate_hits: duplicateCount },
  }
}

function combineExportAndCkStatus(exportStatus: "fresh" | "stale", ckStatus: CkIndexStatus): CkIndexStatus {
  if (ckStatus === "missing" || ckStatus === "partial") return ckStatus
  if (exportStatus === "stale") return "stale"
  return ckStatus
}

async function refreshCkStatusAfterSearch(ctx: any, root: string, exportStatus: "fresh" | "stale", preSearchFreshness: CkIndexFreshness): Promise<void> {
  try {
    const postSearchFreshness = await ckIndexFreshness(root)
    ctx.indexStatus = combineExportAndCkStatus(exportStatus, postSearchFreshness.status)
    if (postSearchFreshness.status !== "fresh") {
      ctx.warnings.push(postSearchFreshness.warning ?? preSearchFreshness.warning ?? "ck semantic index freshness is not verified after search; results may be partial.")
    }
  } catch (e) {
    ctx.indexStatus = combineExportAndCkStatus(exportStatus, preSearchFreshness.status)
    ctx.warnings.push(preSearchFreshness.warning ?? `ck semantic index freshness recheck failed after search: ${(e as Error).message}`)
  }
}

function warnOnPartialScopeCoverage(ctx: any, coverage: CkScopeCoverage, timeoutMs: number): void {
  if (!coverage.truncated) return
  ctx.warnings.push(
    `ck searched ${coverage.searched_scopes}/${coverage.total_scopes} scopes before stopping; results are partial and ${coverage.omitted_scopes} scopes were not searched. ` +
    `Narrow session_ids/project_id/since_ms or raise timeout_ms (current ${timeoutMs}ms).`,
  )
}

function parsePath(p: string): { sessionId: string | null; partId: string | null; channel: SearchChannel } {
  const ch = /\/by-channel\/([^/]+)\/by-session\/(ses_[A-Za-z0-9_-]+)\/(?:summary\.txt|(?:\d{5}-)?(prt_[A-Za-z0-9_-]+)\.txt)$/.exec(p)
  if (ch) return { sessionId: ch[2] ?? null, partId: ch[3] ?? null, channel: (ch[1] as SearchChannel) ?? "raw" }
  // Handles both the seq-prefixed scheme (default) and bare <part_id>.txt
  const m = /\/by-session\/(ses_[A-Za-z0-9_-]+)\/(?:\d{5}-)?(prt_[A-Za-z0-9_-]+)\.txt$/.exec(p)
  return { sessionId: m?.[1] ?? null, partId: m?.[2] ?? null, channel: "raw" }
}

function centerSnippet(text: string, q: string): string {
  if (!text) return ""
  const centered = makeSnippet(text, q, 400)
  return centered.value || truncateString(text.replace(/\s+/g, " "), 400).value
}

function dedupeHits<T extends { session_id: string | null; part_id: string | null; line_start: number | null; snippet: string }>(hits: T[]): { hits: T[]; duplicateCount: number } {
  const seen = new Set<string>()
  const out: T[] = []
  let duplicateCount = 0
  for (const h of hits) {
    const key = `${h.session_id ?? "?"}:${h.part_id ?? "summary"}:${h.line_start ?? "?"}:${normalizeForDedupe(h.snippet).slice(0, 220)}`
    if (seen.has(key)) { duplicateCount++; continue }
    seen.add(key)
    out.push(h)
  }
  return { hits: out, duplicateCount }
}

function scoreHit(input: { channel: SearchChannel; role: string | null; ckScore: number | null; title: string; q: string }): number {
  let score = channelWeight(input.channel) * 10
  if (input.role === "user") score += 8
  else if (input.role === "assistant") score += 4
  if (input.ckScore != null) score += Math.min(20, input.ckScore)
  if (input.title && input.q && input.title.toLowerCase().includes(input.q.toLowerCase())) score += 20
  if (looksLikeExactIdentifier(input.q)) score += 10
  return Number(score.toFixed(3))
}

function buildWhy(q: string, s: { session_title: string | null; hit_count_by_channel: Record<string, number>; evidence: any[] }): string {
  const channels = Object.entries(s.hit_count_by_channel).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(", ")
  if (s.session_title?.toLowerCase().includes(q.toLowerCase())) return `title match; evidence by channel: ${channels}`
  const first = s.evidence[0]
  return first ? `best evidence in ${first.channel}; evidence by channel: ${channels}` : `evidence by channel: ${channels}`
}
