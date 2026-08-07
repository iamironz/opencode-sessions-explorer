/**
 * opencode-sessions-explorer-search-text
 *
 * Canonical interface for "where in my OpenCode history did X happen?" and
 * "find sessions mentioning Y" queries. Backend selection is a THREE-TIER planner
 * (src/lib/query-plan.ts, pure/unit-tested); the tool never searches "via ck".
 *
 * Tiers (chosen per query; see query-plan.ts):
 *   fts — SQLite FTS5 sidecar (src/lib/fts.ts), read straight from the DB, never
 *         the file tree. Trigram `docs_sub` for literal substring; `unicode61`
 *         BM25 `docs_lex` for `lex`. The fast tier (single-digit ms). Only chosen
 *         when the index is ftsUsable() (present AND complete) and covers the
 *         requested channels. NOTE: the huge `tool-output` channel is
 *         EXCERPT-indexed (4KB head + 4KB tail), so the fast tier is NOT
 *         full-fidelity for it — a zero-hit fts pass escalates to rg.
 *   rg  — ripgrep over the filesystem export tree. Handles real regexes, ANY
 *         channel including `raw`, and is the exhaustive terminal fallback tier.
 *   ck  — reserved for `sem`/`hybrid` ONLY (embeddings), with ck's own lazy index
 *         build/refresh during the search. NEVER used for literal/regex/`raw`
 *         (measured 30-34s zero-row timeouts over the 328k-file raw tree).
 *
 * Modes:
 *   regex   — literal text OR a real regex. A literal is served by fts (trigram)
 *             when usable, else rg; a real regex always goes to rg.
 *   lex     — ALWAYS literal/text, NEVER a regex regardless of metacharacters
 *             (`v1.2.3`/`C++`/`*` match literally); fts BM25, or fixed-string rg.
 *   sem     — semantic embeddings (ck lazily builds/refreshes the index).
 *   hybrid  — combined regex + semantic (ck lazily builds/refreshes the index).
 *
 * A literal query WITHOUT a usable 3-character contiguous run (hasUsableTrigram)
 * is routed straight to rg — the trigram index cannot accelerate it and would
 * otherwise degrade to an unbounded full content scan (12.2s measured for a
 * 2-char query).
 *
 * SCOPING: cross-session content search has unbounded fan-out. Callers SHOULD
 * pre-filter via session_ids / project_id / agent / since_ms. The whole chain
 * (sync + each backend + ck freshness probes) is bounded by the caller's
 * timeout_ms via a single deadline. An UNSCOPED `sem`/`hybrid` query that would
 * resolve onto the raw by-session tree is refused (BAD_ARGS) rather than handing
 * ck an unbounded tree.
 *
 * Cap: 160 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { runCk, ckIndexFreshness, type CkHit, type CkIndexFreshness, type CkIndexStatus, type CkScopeCoverage } from "../lib/ck.js"
import { runRg, rgAvailable, type RgHit } from "../lib/rg.js"
import { ftsUsable, ftsCovers, ftsStats, syncFts, queryFts, type FtsHit } from "../lib/fts.js"
import { planSearch, type QueryPlan, type SearchBackend } from "../lib/query-plan.js"
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
    "BACKEND (automatic — you never pick it): a default literal query is served from a local SQLite FTS index in MILLISECONDS; a real regex pattern (anything with `.*`, `|`, `[]`, `^`, `$`, etc.) is run through ripgrep in ~1-2s; `sem`/`hybrid` modes use the ck semantic index, which ck lazily builds/refreshes during the search itself (the first run may be slow). Passing `fixed_string:true` guarantees the fastest indexed path. If the FTS index has not been built yet, literal search transparently falls back to ripgrep with a warning — run the `opencode-sessions-explorer-fts-build` command once to enable millisecond search. If a backend returns nothing it automatically escalates to the next available engine so recall never regresses. " +
    "Modes: 'regex' (default — literal text or a regex; served by the FTS index when literal, by ripgrep when a real regex), 'lex' (BM25/literal phrase search — never treated as a regex, so `C++`/`v1.2.3` match literally), 'sem' (semantic embeddings, ck lazily builds/refreshes its index), 'hybrid' (regex + sem). " +
    "IMPORTANT: `sem`/`hybrid` must be SCOPED when combined with `surface:'forensics'` or `channels:['raw']` — semantic search over the unbounded raw replay tree is refused (add session_ids/project_id/agent/since_ms, or use a curated surface). For raw literal/regex recall use `mode:'regex'` (served by ripgrep). " +
    "Pre-filter cross-session searches via session_ids[], project_id, agent, since_ms/until_ms — an unscoped raw/forensic scan can still take 10-30 seconds, though indexed literal recall is near-instant. Scoped searches return in <1s. Results carry a `partial` flag (plus `interrupted`/`ck_scope_coverage`/`role_filter_truncated`/`scope_truncated`) when coverage was incomplete. " +
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
      // DEFECT A: derive ONE deadline for the WHOLE call, before any sync, index
      // probe, or planning work. Every downstream step (fts/export sync, index
      // freshness probe, primary backend, each fallback) is bounded by the budget
      // remaining against this deadline, so a caller's timeout_ms bounds the total
      // wall time — not just one backend invocation.
      const deadline = Date.now() + args.timeout_ms

      const surface = inferSurface(args.q, args.surface as SearchSurface)
      const channels = normalizeChannels(args.channels?.length ? args.channels : channelsForSurface(surface, args.q))
      const groupBySession = args.group_by_session ?? (surface !== "forensics" && !args.session_ids?.length)

      // Pre-filter scope: resolve to a list of session_ids in DB.
      const scopeIds = resolveScope(args)
      const root = exportRoot()

      // DEFECT E: resolveScope() caps metadata-filtered scopes at SCOPE_CAP. When
      // the cap is hit the scope is silently incomplete — surface it explicitly so
      // a caller is not misled by a `scope_session_count` that equals the cap.
      const scopeTruncated = Array.isArray(scopeIds) && scopeIds.length === SCOPE_CAP
      if (scopeTruncated) {
        ctx.warnings.push(`metadata filter matched at least ${SCOPE_CAP} sessions and was capped: results cover only the ${SCOPE_CAP} most-recently-updated sessions. Narrow with since_ms/until_ms/project_id/agent for complete coverage.`)
      }

      // sem/hybrid always route to ck (the only embedding engine). We deliberately
      // do NOT downgrade to regex when the ck index is absent: ck lazily builds or
      // refreshes its own index during the search, so a missing index is a
      // slow-first-run condition, not a hard failure (upstream lazy-indexing fix).
      // The freshness probe + post-search recheck live in runSearch, around the
      // actual ck invocation.
      const effectiveMode = args.mode as "regex" | "lex" | "sem" | "hybrid"
      if (!ctx.mode) ctx.mode = effectiveMode

      // DEFECT C: sem/hybrid IGNORE channels and always route to ck. Over the raw
      // by-session tree (surface:"forensics" or channels:["raw"]) with NO scope,
      // resolveCkScopes hands ck the entire replay tree (hundreds of thousands of
      // files), which measured 30-34s timeouts returning ZERO rows. Refuse that
      // specific unbounded combination with an actionable error instead of hanging.
      // (Scoped sem/hybrid over raw is bounded to the named sessions and is allowed.)
      if ((effectiveMode === "sem" || effectiveMode === "hybrid") && channels.includes("raw") && scopeIds === "all") {
        fail(
          "BAD_ARGS",
          `${effectiveMode} semantic search over the raw replay tree is unbounded (the full by-session export is hundreds of thousands of files) and will time out returning nothing.`,
          "Scope it first (session_ids/project_id/agent/since_ms/until_ms), or use a curated surface (recall/debug_trace/tool_audit/code) instead of forensics/raw. For raw literal/regex recall use mode:'regex' (served by ripgrep).",
        )
      }

      // Choose a backend via the pure planner. Every environment fact is probed
      // once here and passed in; the planner does no I/O. NOTE: `ftsAvailable` MUST
      // be `ftsUsable()` (present AND complete/authoritative), NOT mere presence:
      // we only escalate off a backend on ZERO hits, so trusting a partial index
      // would silently return a fraction of the corpus. planSearch() may THROW
      // SessionsError("RG_NOT_FOUND") when a plan needs rg as primary and rg is
      // genuinely absent; that throw propagates to runWithEnvelope which renders it
      // as {ok:false,error:{code:"RG_NOT_FOUND"}} (verified against envelope.ts).
      const ftsAvail = ftsUsable(root)
      const ftsCov = ftsCovers(channels)
      const rgAvail = rgAvailable()
      const plan = planSearch({
        mode: effectiveMode,
        q: args.q,
        fixedString: args.fixed_string,
        surface,
        channels,
        ftsAvailable: ftsAvail,
        ftsCoversChannels: ftsCov,
        rgAvailable: rgAvail,
      })

      // Empty scope short-circuit: no sessions matched the pre-filter at all. This
      // is a DB-level emptiness independent of any backend or the file tree.
      if (scopeIds !== "all" && scopeIds.length === 0) {
        return emptyResult(args, surface, channels, groupBySession, plan, scopeTruncated)
      }
      if (scopeIds === "all" && (surface === "forensics" || channels.includes("raw"))) {
        ctx.warnings.push("raw unscoped forensic search can take 10-30s. Add session_ids/project_id/agent/since_ms to narrow.")
      }

      // Index-health / graceful-degradation warning: a literal (incl. lex) query
      // that is NOT being served by fts is slower for a reason — say why, and name
      // the build command. Only probe ftsStats() on this already-slow path (its
      // COUNT is ~150ms), never on the fts happy path.
      if (plan.literal && plan.backend !== "fts" && effectiveMode !== "sem" && effectiveMode !== "hybrid") {
        const stats = ftsStats(root)
        if (!stats.present) {
          ctx.warnings.push(`FTS index not built — literal search is using ${plan.backend}. Build it once for millisecond literal search: run the opencode-sessions-explorer-fts-build command.`)
        } else if (!stats.complete || stats.failedParts > 0 || stats.deadLetters > 0) {
          ctx.warnings.push(`FTS index is present but not authoritative (complete=${stats.complete}, failed_parts=${stats.failedParts}, dead_letters=${stats.deadLetters}) — literal search is using ${plan.backend} instead and is slower. Rebuild/refresh with the opencode-sessions-explorer-fts-build command.`)
        }
      }

      // Delta-sync is done lazily per backend inside runSearch (sync-on-demand),
      // each bounded by the remaining budget: the fts backend only syncs the SQLite
      // sidecar (`syncFts`), while rg/ck sync the file-tree export (`runExport` +
      // applyExportProgress/lock_skipped). Deferring the sync to the engine that
      // actually runs keeps the fts happy path off the file tree AND still syncs the
      // file tree correctly when a zero-hit fts query escalates to rg.

      // When group_by_session is true, fetch MORE hits so each session's hit_count is
      // accurate. Output size is bounded by `limit` (number of SESSIONS); a backend
      // may return many parts per session.
      const topk = groupBySession
        ? Math.min(Math.max(args.limit * 20, 100), 500)
        : Math.min(args.limit * (effectiveMode === "regex" ? 2 : 3), 150)

      // Staged recall applies ONLY to the file-tree backends (rg/ck): for the
      // unscoped, default (non-overridden), session-first, role=any recall path,
      // session-summary is a tiny curated tree (~one file per session) while unscoped
      // conversation is the giant by-channel/conversation tree. Search session-summary
      // first; only skip the expensive conversation scope when the export is complete
      // AND the summary pass covers enough distinct sessions (see
      // executeFileTreeStrategy for the exact gate). The fts backend is a single
      // indexed query (sub-10ms) and never uses this — it is bypassed there.
      const stagedRecall =
        !(args.channels?.length) &&
        surface === "recall" &&
        scopeIds === "all" &&
        args.role === "any" &&
        groupBySession &&
        channels.includes("session-summary") &&
        channels.includes("conversation")

      return await runSearch({
        args,
        plan,
        effectiveMode,
        ctx,
        root,
        channels,
        surface,
        groupBySession,
        scopeIds,
        topk,
        stagedRecall,
        deadline,
        scopeTruncated,
      })
    })
  },
})

/** Cap on metadata-filtered scope resolution. A larger project/time window is
 *  silently incomplete beyond this; callers are warned via `scope_truncated`. */
const SCOPE_CAP = 5000

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
  // Cap at SCOPE_CAP so a since/until_ms or other filter doesn't accidentally
  // exclude older sessions where the search term may legitimately live. When the
  // cap is hit the caller is warned (DEFECT E) via `scope_truncated`.
  const sql = `SELECT id FROM session WHERE ${where.join(" AND ")} ORDER BY time_updated DESC LIMIT ${SCOPE_CAP}`
  const rows = stmt(sql).all(...params) as { id: string }[]
  return rows.map((r) => r.id)
}

function normalizeChannels(channels: SearchChannel[]): SearchChannel[] {
  return Array.from(new Set(channels.length ? channels : ["conversation", "session-summary"]))
}

/** Interpret a file-tree export delta-sync result. When the export lock is held by
 *  another process the sync is skipped and results may use stale/partial data. */
function applyExportProgress(ctx: any, progress: { lock_skipped: boolean }): "fresh" | "stale" {
  if (progress.lock_skipped) {
    ctx.warnings.push("delta sync skipped: export lock is held by another process; results may use stale/partial export data.")
    ctx.indexStatus = "stale"
    return "stale"
  }
  ctx.indexStatus = "fresh"
  return "fresh"
}

/** Combine the file-tree export status with ck's own index status. A missing/partial
 *  ck index dominates; otherwise a stale export downgrades an otherwise-fresh index. */
function combineExportAndCkStatus(exportStatus: "fresh" | "stale", ckStatus: CkIndexStatus): CkIndexStatus {
  if (ckStatus === "missing" || ckStatus === "partial") return ckStatus
  if (exportStatus === "stale") return "stale"
  return ckStatus
}

/** Re-probe ck index freshness after a sem/hybrid search (ck may have lazily built
 *  or refreshed its index during the run) and reflect it in the envelope status.
 *  DEFECT 2: the probe is bounded by `probeTimeoutMs` (the remaining budget) so it
 *  cannot push total wall time past the caller's timeout_ms. `preSearchFreshness`
 *  may be null when the pre-search probe was itself skipped for budget. */
async function refreshCkStatusAfterSearch(ctx: any, root: string, exportStatus: "fresh" | "stale", preSearchFreshness: CkIndexFreshness | null, probeTimeoutMs: number): Promise<void> {
  try {
    const postSearchFreshness = await ckIndexFreshness(root, probeTimeoutMs)
    ctx.indexStatus = combineExportAndCkStatus(exportStatus, postSearchFreshness.status)
    if (postSearchFreshness.status !== "fresh") {
      ctx.warnings.push(postSearchFreshness.warning ?? preSearchFreshness?.warning ?? "ck semantic index freshness is not verified after search; results may be partial.")
    }
  } catch (e) {
    if (preSearchFreshness) ctx.indexStatus = combineExportAndCkStatus(exportStatus, preSearchFreshness.status)
    ctx.warnings.push(preSearchFreshness?.warning ?? `ck semantic index freshness recheck failed after search: ${(e as Error).message}`)
  }
}

/** Warn when ck's multi-scope fan-out stopped early and left scopes unsearched. */
function warnOnPartialScopeCoverage(ctx: any, coverage: CkScopeCoverage, timeoutMs: number): void {
  if (!coverage.truncated) return
  ctx.warnings.push(
    `ck searched ${coverage.searched_scopes}/${coverage.total_scopes} scopes before stopping; results are partial and ${coverage.omitted_scopes} scopes were not searched. ` +
    `Narrow session_ids/project_id/since_ms or raise timeout_ms (current ${timeoutMs}ms).`,
  )
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

/**
 * Backend-neutral hit shape. Each backend (fts / rg / ck) is adapted into this so
 * the downstream metadata enrichment + grouping code stays single-path.
 *   - relevance feeds the existing `ckScore` slot in scoreHit (higher = better).
 *   - lineStart/lineEnd are null for fts (no line concept in an indexed doc).
 */
type NormHit = {
  sessionId: string | null
  partId: string | null
  channel: SearchChannel
  snippet: string
  relevance: number | null
  lineStart: number | null
  lineEnd: number | null
}

/** Result of running one backend (possibly multi-stage for the file-tree engines). */
type BackendRun = {
  hits: NormHit[]
  durationMs: number
  timedOut: boolean
  strategy: string
  rc?: number
  stderr?: string
  /** File-tree scope coverage (ck fan-out OR rg single-process). Undefined for the
   *  fts backend, which never reads the file tree. Surfaced as ck_scope_coverage. */
  scopeCoverage?: CkScopeCoverage
  /** DEFECT B: fts stopped at its time/row bound before scanning the full candidate
   *  set, so `hits` are a non-authoritative partial window. Triggers escalation and
   *  a `partial` signal. Undefined/false for a complete run. */
  interrupted?: boolean
}

/** Uniform result of one file-tree engine (rg or ck) invocation over a scope set. */
type FileRunResult = { hits: NormHit[]; rc: number; stderr: string; durationMs: number; timedOut: boolean; scopeCoverage?: CkScopeCoverage }
type FileRunner = (scopes: string[], timeoutMs: number, topk: number) => Promise<FileRunResult>

function ckHitToNorm(h: CkHit): NormHit {
  const { sessionId, partId, channel } = parsePath(h.path)
  return { sessionId, partId, channel, snippet: h.snippet ?? "", relevance: h.score ?? null, lineStart: h.span?.line_start ?? null, lineEnd: h.span?.line_end ?? null }
}

function rgHitToNorm(h: RgHit): NormHit {
  const { sessionId, partId, channel } = parsePath(h.path)
  return { sessionId, partId, channel, snippet: h.line_text ?? "", relevance: null, lineStart: h.line_number, lineEnd: h.line_number }
}

function ftsHitToNorm(h: FtsHit): NormHit {
  return { sessionId: h.session_id, partId: h.part_id, channel: h.channel, snippet: h.snippet ?? "", relevance: h.score, lineStart: null, lineEnd: null }
}

function makeCkRunner(args: any, mode: "regex" | "lex" | "sem" | "hybrid"): FileRunner {
  return async (scopes, timeoutMs, topk) => {
    if (scopes.length === 0) return { hits: [], rc: 1, stderr: "", durationMs: 0, timedOut: false }
    const res = await runCk({ mode, query: args.q, threshold: args.threshold, caseSensitive: args.case_sensitive, fixedString: args.fixed_string, scopes, topk, timeoutMs })
    return { hits: res.hits.map(ckHitToNorm), rc: res.rc, stderr: res.stderr, durationMs: res.durationMs, timedOut: res.timedOut, scopeCoverage: res.scopeCoverage }
  }
}

function makeRgRunner(args: any, treatAsFixedString: boolean): FileRunner {
  return async (scopes, timeoutMs, topk) => {
    // runRg throws on an empty scope set; a file-tree backend with nothing to
    // search is simply an empty result, not an error.
    if (scopes.length === 0) {
      return { hits: [], rc: 1, stderr: "", durationMs: 0, timedOut: false, scopeCoverage: emptyScopeCoverage() }
    }
    // Unlike ck's per-scope fan-out, rg accepts every scope path in ONE process,
    // so it either searches them all or the whole process times out. Coverage is
    // therefore all-or-nothing: searched == total unless the process timed out.
    // `fixedString` MUST come from the planner's `treatAsFixedString`, not from
    // args.fixed_string / metacharacter re-derivation: a `lex` query like `C++` or
    // `v1.2.3` is full of regex metacharacters but must be matched literally when
    // it falls back to rg, never evaluated as a regular expression.
    const res = await runRg({ query: args.q, scopes, fixedString: treatAsFixedString, caseSensitive: args.case_sensitive, topk, timeoutMs })
    return {
      hits: res.hits.map(rgHitToNorm),
      rc: res.rc,
      stderr: res.stderr,
      durationMs: res.durationMs,
      timedOut: res.timedOut,
      scopeCoverage: rgScopeCoverage(scopes.length, res.timedOut),
    }
  }
}

/** Coverage for an empty file-tree scope set (nothing to search). */
function emptyScopeCoverage(): CkScopeCoverage {
  return { strategy: "single", searched_scopes: 0, total_scopes: 0, omitted_scopes: 0, truncated: false, timed_out: false }
}

/** Adapt an rg single-process run into upstream's CkScopeCoverage shape. rg passes
 *  all scope paths to one process, so it searches every scope unless that process
 *  timed out — in which case the results are partial (truncated). */
function rgScopeCoverage(totalScopes: number, timedOut: boolean): CkScopeCoverage {
  return {
    strategy: "single",
    searched_scopes: timedOut ? 0 : totalScopes,
    total_scopes: totalScopes,
    omitted_scopes: timedOut ? totalScopes : 0,
    truncated: timedOut,
    timed_out: timedOut,
  }
}

/** Minimum remaining budget (ms) worth escalating to a fallback backend. Below this
 *  the chain stops rather than launching an engine that cannot realistically finish
 *  inside the caller's timeout_ms. */
const MIN_ESCALATION_BUDGET_MS = 300

type RunSearchParams = {
  args: any
  plan: QueryPlan
  effectiveMode: "regex" | "lex" | "sem" | "hybrid"
  ctx: any
  root: string
  channels: SearchChannel[]
  surface: SearchSurface
  groupBySession: boolean
  scopeIds: "all" | string[]
  topk: number
  stagedRecall: boolean
  /** Absolute wall-clock deadline (Date.now()+timeout_ms) for the WHOLE chain. */
  deadline: number
  scopeTruncated: boolean
}

/** Don't START a sync with less than this much budget left — it would eat the
 *  whole remaining budget and starve the actual search. */
const MIN_SYNC_BUDGET_MS = 200
/** Don't START a backend engine with less than this much budget left. */
const MIN_BACKEND_BUDGET_MS = 150
/** Don't START a ck index-freshness probe with less than this much budget left —
 *  skip it and report the status as unverified rather than overshooting (DEFECT 2). */
const MIN_PROBE_BUDGET_MS = 200
/** Upper bound (ms) for a ck freshness probe; also ck.ts's own default. The probe
 *  is additionally capped at a fraction of the remaining budget. */
const CK_PROBE_BUDGET_MS = 1500

async function runSearch(p: RunSearchParams) {
  const { args, plan, effectiveMode, ctx, root, channels, surface, groupBySession, scopeIds, topk, stagedRecall, deadline, scopeTruncated } = p
  const sessionCount = scopeIds === "all" ? null : scopeIds.length
  const chainStart = Date.now()
  const remainingBudget = (): number => deadline - Date.now()

  // Resolve file-tree scopes lazily: on the fts happy path we never touch the file
  // tree, so we also avoid emitting its (irrelevant) export-completeness warnings.
  let _scopes: string[] | null = null
  const getScopes = (): string[] => {
    if (_scopes === null) _scopes = resolveCkScopes(root, scopeIds, channels, ctx)
    return _scopes
  }

  // Sync-on-demand, keyed to the engine that actually runs, and BOUNDED by the
  // remaining budget (DEFECT A). The fts backend reads straight from SQLite so it
  // only syncs the sidecar; rg/ck read the file tree, so they sync the export. Each
  // sync runs at most once and never consumes more than half the remaining budget,
  // so the actual search always keeps budget. A sync that cannot fit is skipped
  // with a warning rather than overshooting the caller's timeout_ms.
  let ftsSynced = false
  let exportSynced = false
  let exportStatus: "fresh" | "stale" = "fresh"
  let fileTreeEmptyWarned = false
  const syncBudget = (configured: number): number => Math.min(configured, Math.floor(remainingBudget() / 2))
  // Bounded timeout for a ck freshness probe: capped at CK_PROBE_BUDGET_MS and a
  // QUARTER of the remaining budget, but always >= 1ms so the probe is NEVER skipped
  // (the reported status always comes from a real ckIndexFreshness() observation).
  // The cheap manifest-absent "missing" path is free regardless; only the expensive
  // ck `--status-json` spawn is time-boxed, and it degrades honestly to "partial"
  // if it cannot attest in time. Taking only a fraction (not the whole remaining)
  // leaves budget for the actual ck search AND headroom for the child-process kill
  // latency (killing a ck busy over a multi-GB index is not instant), so the two
  // probes plus the search stay within the caller's timeout_ms rather than the
  // pre-probe alone consuming — and overshooting — the entire budget.
  const probeTimeoutMs = (): number => Math.max(1, Math.min(CK_PROBE_BUDGET_MS, Math.floor(remainingBudget() / 4)))
  const ensureFtsSync = async (): Promise<void> => {
    if (ftsSynced) return
    ftsSynced = true
    const budgetMs = syncBudget(1500)
    if (budgetMs < MIN_SYNC_BUDGET_MS) {
      ctx.warnings.push(`fts delta sync skipped: only ${Math.max(0, remainingBudget())}ms of the ${args.timeout_ms}ms budget left; serving the index as-is (may be slightly stale).`)
      ctx.indexStatus = "stale"
      return
    }
    try {
      await syncFts({ budgetMs })
      ctx.indexStatus = "fresh"
    } catch (e) {
      ctx.warnings.push(`fts delta sync skipped: ${(e as Error).message}`)
      ctx.indexStatus = "stale"
    }
  }
  const ensureExportSync = async (): Promise<void> => {
    if (exportSynced) return
    exportSynced = true
    const budgetMs = syncBudget(4000)
    if (budgetMs < MIN_SYNC_BUDGET_MS) {
      ctx.warnings.push(`export delta sync skipped: only ${Math.max(0, remainingBudget())}ms of the ${args.timeout_ms}ms budget left; searching possibly-stale export data.`)
      ctx.indexStatus = "stale"
      exportStatus = "stale"
      return
    }
    try {
      exportStatus = applyExportProgress(ctx, await runExport({ budgetMs }))
    } catch (e) {
      ctx.warnings.push(`delta sync skipped: ${(e as Error).message}`)
      ctx.indexStatus = "stale"
      exportStatus = "stale"
    }
  }

  // For sem/hybrid, probe ck index freshness once (before the ck run) and recheck
  // once after — ck lazily builds/refreshes its own index during the search. Both
  // probes are budget-bounded (DEFECT 2); `ckProbed` marks that a sem/hybrid ck run
  // happened so the post-search recheck fires even if the pre-probe was budget-skipped.
  let preSearchFreshness: CkIndexFreshness | null = null
  let ckProbed = false
  // True only once the ck SEARCH actually executed (not skipped for empty scope or
  // no budget). Gates the post-search re-probe: with no search there was no lazy
  // index build to re-observe, so re-probing would only add child-process kill
  // latency past the deadline for a status the pre-probe already established.
  let ckSearchRan = false

  // Engine over-fetch for the role filter: file-tree backends (rg/ck) apply `role`
  // in JS AFTER their topk cut (DEFECT D — fts applies it in SQL), so a role-scoped
  // file-tree search fetches a wider candidate window to reduce how often
  // requested-role hits fall outside the cut. Tracked so we can also make residual
  // truncation VISIBLE below.
  const fileTreeTopk = args.role !== "any" ? Math.min(topk * 5, 750) : topk

  const runBackend = async (backend: SearchBackend): Promise<BackendRun> => {
    if (backend === "fts") {
      await ensureFtsSync()
      const remaining = remainingBudget()
      if (remaining <= MIN_BACKEND_BUDGET_MS) {
        ctx.warnings.push(`fts search skipped: only ${Math.max(0, remaining)}ms of the ${args.timeout_ms}ms budget left after sync.`)
        return { hits: [], durationMs: 0, timedOut: true, strategy: "fts-no-budget", interrupted: true }
      }
      // `lex` mode wants BM25 ranking (MATCH), not trigram-substring; every other
      // literal query uses the substring path. A metacharacter query never reaches
      // fts (the planner routes it to rg), so plan.literal is the right default.
      const ftsLiteral = effectiveMode === "lex" ? false : plan.literal
      const res = queryFts({
        query: args.q,
        literal: ftsLiteral,
        channels,
        sessionIds: scopeIds === "all" ? undefined : scopeIds,
        role: args.role,
        limit: topk,
        caseSensitive: args.case_sensitive,
        timeoutMs: remaining,
      })
      return { hits: res.hits.map(ftsHitToNorm), durationMs: res.durationMs, timedOut: false, strategy: "fts", interrupted: res.interrupted }
    }

    // File-tree backend (rg or ck): sync the export tree, then resolve scopes.
    await ensureExportSync()
    const scopes = getScopes()

    // DEFECT 1 (resolved-scope guard): the requested-channels guard in execute()
    // only sees the REQUESTED channels, but resolveCkScopes() can independently
    // substitute the raw root — an UNSCOPED curated-channel query falls back to
    // `[rawRoot]`/`[root]` (the 328k-file by-session tree) whenever the curated
    // export is partial/missing or the export sync was skipped. Handing THAT to ck
    // is the exact 30-34s zero-row pathology, reached sideways. Refuse it on the
    // RESOLVED scope. (Scoped ck runs resolve to bounded per-session dirs, never
    // the raw root, so this never fires for them. The partial-export warning that
    // resolveCkScopes already pushed is preserved.)
    if (backend === "ck" && scopeIds === "all") {
      const rawRoot = join(root, "by-session")
      if (scopes.some((s) => s === rawRoot || s === root)) {
        fail(
          "BAD_ARGS",
          `${effectiveMode} semantic search resolved onto the unbounded raw replay tree (the curated channel export is incomplete, so an unscoped ${effectiveMode} query fell back to the full by-session tree of hundreds of thousands of files). ck would time out returning nothing.`,
          "Finish the curated export (opencode-sessions-explorer-bulk-export --reset), scope the query (session_ids/project_id/agent/since_ms/until_ms), or use mode:'regex' (served by ripgrep, which handles the raw tree).",
        )
      }
    }

    // File-tree empty-scope guard: the export tree carries no scope for the
    // requested sessions (stale/partial export). This guard is file-tree specific —
    // it must NOT fire for fts, which answers from SQLite regardless of the tree.
    if (scopeIds !== "all" && scopes.length === 0) {
      if (!fileTreeEmptyWarned) {
        ctx.warnings.push(`export scope missing after delta sync for ${scopeIds.length} DB session(s); returning empty results from stale/partial export data.`)
        fileTreeEmptyWarned = true
      }
      return { hits: [], durationMs: 0, timedOut: false, strategy: "empty-scope" }
    }

    // DEFECT 2: pre-search ck freshness probe. We ALWAYS call ckIndexFreshness()
    // and NEVER fabricate a status: the reported index_status must come from a real
    // observation. This is both correct and cheap — ckIndexFreshness() reads
    // <root>/.ck/manifest.json and returns "missing" immediately when it is absent
    // (a filesystem stat, no child process); it only spawns ck (readStatusJson)
    // when the manifest EXISTS, and THAT is exactly what `timeoutMs` bounds. So we
    // derive timeoutMs from the remaining budget to keep the deadline discipline
    // (a tiny budget yields a tiny timeoutMs and the manifest-present path degrades
    // honestly to "partial" via ck.ts's own logic), while the manifest-absent
    // "missing" determination stays free and DETERMINISTIC (no load-dependent skip).
    if (backend === "ck" && (effectiveMode === "sem" || effectiveMode === "hybrid") && !ckProbed) {
      ckProbed = true
      const probeTimeout = probeTimeoutMs()
      if (remainingBudget() < MIN_PROBE_BUDGET_MS) {
        ctx.warnings.push(`ck index freshness probe is time-boxed to ${probeTimeout}ms (low remaining budget); if a semantic index exists but ck cannot attest in time its status honestly degrades to 'partial'.`)
      }
      preSearchFreshness = await ckIndexFreshness(root, probeTimeout)
      ctx.indexStatus = combineExportAndCkStatus(exportStatus, preSearchFreshness.status)
    }

    const remaining = remainingBudget()
    if (remaining <= MIN_BACKEND_BUDGET_MS) {
      ctx.warnings.push(`${backend} search skipped: only ${Math.max(0, remaining)}ms of the ${args.timeout_ms}ms budget left after sync.`)
      return { hits: [], durationMs: 0, timedOut: true, strategy: `${backend}-no-budget`, interrupted: true, scopeCoverage: emptyScopeCoverage() }
    }

    const runner: FileRunner = backend === "rg" ? makeRgRunner(args, plan.treatAsFixedString) : makeCkRunner(args, effectiveMode)
    if (backend === "ck") ckSearchRan = true
    return await executeFileTreeStrategy(args, scopes, runner, fileTreeTopk, stagedRecall, root, remaining)
  }

  // Primary backend, then escalate through plan.fallbacks. Escalation fires when the
  // primary is NON-AUTHORITATIVE: zero hits (nothing found) OR interrupted/timed out
  // (DEFECT B — a non-empty interrupted result is incomplete by construction and must
  // not be trusted as final). The whole chain is bounded by the shared deadline.
  const needsMore = (r: BackendRun): boolean => r.hits.length === 0 || r.interrupted === true || r.timedOut === true
  const backendsTried: SearchBackend[] = [plan.backend]
  let produced = await runBackend(plan.backend)
  let producingBackend: SearchBackend = plan.backend
  if (needsMore(produced)) {
    for (const fb of plan.fallbacks) {
      const remaining = remainingBudget()
      if (remaining < MIN_ESCALATION_BUDGET_MS) {
        ctx.warnings.push(`escalation to ${fb} skipped: only ${Math.max(0, remaining)}ms of the ${args.timeout_ms}ms budget left; returning partial results.`)
        break
      }
      backendsTried.push(fb)
      const fbRun = await runBackend(fb)
      // Prefer an authoritative non-empty fallback; otherwise keep the richer of the
      // two so we never discard the primary's partial hits for an emptier fallback.
      if (!needsMore(fbRun)) { produced = fbRun; producingBackend = fb; break }
      if (fbRun.hits.length > produced.hits.length) { produced = fbRun; producingBackend = fb }
    }
  }
  // sem/hybrid: recheck ck index freshness after the (lazy-indexing) ck run so the
  // envelope's index_status reflects whatever ck did during the search. DEFECT 2:
  // re-probe whenever the ck SEARCH actually ran (ckSearchRan) — ck may have lazily
  // built/refreshed its index, so the post-search status is a fresh observation, not
  // a fabrication. The probe is bounded by a timeoutMs derived from the remaining
  // budget (manifest-absent path is free; only the ck spawn is time-boxed, degrading
  // honestly) and runs BEFORE search_duration_ms so the self-report includes it (the
  // probe used to escape both the deadline AND the duration accounting). When the ck
  // search was skipped (no budget / empty scope), the pre-probe status stands as the
  // last real observation — re-probing then would only add kill latency for no new info.
  if (ckSearchRan) {
    await refreshCkStatusAfterSearch(ctx, root, exportStatus, preSearchFreshness, probeTimeoutMs())
  }
  const searchDurationMs = Date.now() - chainStart

  ctx.warnings.push(`recall_strategy=${produced.strategy}`)
  if (produced.timedOut) ctx.warnings.push(`${producingBackend} timed out within the ${args.timeout_ms}ms budget`)
  if (produced.rc != null && produced.rc !== 0 && produced.rc !== 1) {
    ctx.warnings.push(`${producingBackend} rc=${produced.rc} stderr=${truncateString(produced.stderr ?? "", 256).value}`)
  }
  // Scope coverage is a property of the FILE-TREE tier (rg OR ck), not of ck
  // specifically — surface it (and its partial-coverage warning) whenever a
  // file-tree engine ran. The fts backend never reads the file tree, so it leaves
  // scopeCoverage undefined and the field is omitted. The response key stays named
  // `ck_scope_coverage` for backward compatibility with existing consumers.
  if (produced.scopeCoverage) {
    warnOnPartialScopeCoverage(ctx, produced.scopeCoverage, args.timeout_ms)
  }
  // DEFECT B: a still-interrupted producing backend means the result is a partial
  // window, not "no more results". Make that explicit.
  if (produced.interrupted) {
    ctx.warnings.push(`${producingBackend} results are PARTIAL — the query stopped at its time/row bound before scanning the full candidate set. Narrow the scope or raise timeout_ms, or the missing matches will stay hidden.`)
  }

  // DEFECT D: file-tree engines (rg/ck) apply the role filter AFTER their topk cut
  // (fts applies it in SQL). When role != any and the engine returned a full batch,
  // some requested-role hits may have been truncated before filtering — make it
  // visible instead of silently returning a wrong-looking (possibly empty) set.
  const roleFilterTruncated =
    args.role !== "any" &&
    producingBackend !== "fts" &&
    produced.hits.length >= fileTreeTopk
  if (roleFilterTruncated) {
    ctx.warnings.push(`role='${args.role}' filter was applied AFTER the ${producingBackend} backend hit its ${fileTreeTopk}-candidate cap, so some ${args.role} matches may be missing. Narrow with session_ids/since_ms, raise limit, or drop the role filter to see all matches.`)
  }

  // DEFECT A/B: a single machine-readable partiality signal for callers.
  const partial = (produced.interrupted ?? false) || produced.timedOut || (produced.scopeCoverage?.truncated ?? false) || roleFilterTruncated || scopeTruncated

  const debug = {
    backend: producingBackend,
    backends_tried: backendsTried,
    plan_reason: plan.reason,
    literal: plan.literal,
    search_duration_ms: searchDurationMs,
    ck_duration_ms: produced.durationMs,
    ck_timed_out: produced.timedOut,
    ...(produced.scopeCoverage ? { ck_scope_coverage: produced.scopeCoverage } : {}),
    recall_strategy: produced.strategy,
    partial,
    interrupted: produced.interrupted ?? false,
    role_filter_truncated: roleFilterTruncated,
    scope_truncated: scopeTruncated,
  }

  // ---- single-path enrichment (identical across backends) ----
  const hitsIn = produced.hits

  // Batch-fetch part metadata (one query for all part_ids)
  const partIds = hitsIn.map((h) => h.partId).filter((x): x is string => !!x)
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
  const sessIds = Array.from(new Set(hitsIn.map((h) => h.sessionId).filter((x): x is string => !!x)))
  const sessInfo = new Map<string, any>()
  if (sessIds.length > 0) {
    const placeholders = sessIds.map(() => "?").join(",")
    const rows = stmt(`SELECT id, title, project_id, directory, agent, model, time_archived, time_updated FROM session WHERE id IN (${placeholders})`).all(...sessIds) as any[]
    for (const r of rows) sessInfo.set(r.id, r)
  }

  // Build hits + apply role filter
  const allHits = hitsIn.map((h) => {
    const session = h.sessionId ? sessInfo.get(h.sessionId) : null
    const part = h.partId ? partInfo.get(h.partId) : null
    const role = part ? (roleByMsg.get(part.message_id) ?? null) : null
    let snippet = centerSnippet(h.snippet ?? "", args.q)
    if (args.redact) snippet = redactSecrets(snippet)
    const score = scoreHit({ channel: h.channel, role, ckScore: h.relevance, title: session?.title ?? "", q: args.q })
    return {
      session_id: h.sessionId,
      channel: h.channel,
      part_id: h.partId,
      part_type: part?.type ?? null,
      message_id: part?.message_id ?? null,
      role,
      ts: part?.time_created ?? session?.time_updated ?? null,
      score,
      raw_score: h.relevance,
      line_start: h.lineStart,
      line_end: h.lineEnd,
      snippet: truncateString(snippet, 400).value,
      source: effectiveMode,
      raw_ref: h.partId
        ? { tool: "opencode-sessions-explorer-get-part", part_id: h.partId }
        : h.channel === "session-summary" && h.sessionId
          ? { tool: "opencode-sessions-explorer-session-summary", session_id: h.sessionId }
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
      mode: effectiveMode,
      surface,
      channels,
      scope_session_count: sessionCount,
      ...debug,
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
    mode: effectiveMode,
    surface,
    channels,
    scope_session_count: sessionCount,
    ...debug,
    role_filter: args.role,
    suppressed: { ...emptySuppressed(channels), duplicate_hits: duplicateCount },
  }
}

/** Minimum ms of remaining budget worth spawning a second `ck` process for. Below
 * this, stage 2 is skipped rather than launched with an unrealistically tiny
 * timeout that would just overshoot the caller's budget for no benefit. */
const MIN_STAGE2_BUDGET_MS = 300

/**
 * Runs a file-tree engine (rg or ck) via `runner`, applying the staged-recall
 * strategy when eligible. Behaviour is identical to the previous ck-only path —
 * only the engine that actually reads the files is abstracted, so the fts backend
 * (which never touches the file tree) can bypass this entirely.
 *
 * For the staged recall path (unscoped, default, session-first, role=any):
 *   1. Search only the `session-summary` channel scope first (tiny — one file per
 *      session). Used as a cheap first pass whenever its channel root exists on disk,
 *      even if the curated export backfill is only partial.
 *   2. Early-return summary-only (skipping the unscoped `conversation` scope) ONLY when:
 *        - the curated channel export is complete (a partial export cannot prove
 *          absence, so it must never by itself suppress the fallback), AND
 *        - stage 1 covers at least `args.limit` DISTINCT sessions, AND
 *        - stage 1 did not time out.
 *   3. Otherwise fall back to a stage 2 search of the remaining scopes, but only if
 *      there is enough of the budget left; the combined wall-clock across both stages
 *      never exceeds `budgetMs`. If stage 1 exhausted the budget, stage 2 is skipped
 *      and the (possibly incomplete) stage 1 result is returned marked timed out.
 *
 * All other cases (scoped session_ids/project/agent, explicit `channels` override,
 * forensics/raw, role=user/assistant, non-grouped, or no session-summary channel root
 * on disk) go straight to a direct single (possibly multi-scope) call.
 */
async function executeFileTreeStrategy(
  args: any,
  scopes: string[],
  runner: FileRunner,
  topk: number,
  stagedRecall: boolean,
  root: string,
  budgetMs: number,
): Promise<BackendRun> {
  if (stagedRecall) {
    // `scopes` is only split per-channel when resolveCkScopes() found a complete
    // curated export; if the export was partial it collapsed to a single raw-fallback
    // path and neither of these filters will match anything below.
    const summaryScopesFromResolved = scopes.filter((s) => s.includes("/by-channel/session-summary/"))
    const conversationScopesFromResolved = scopes.filter((s) => s.includes("/by-channel/conversation/"))
    const exportComplete = channelExportComplete(root)
    const usingResolvedChannelScopes = summaryScopesFromResolved.length > 0 && conversationScopesFromResolved.length > 0

    const summaryRoot = join(root, "by-channel", "session-summary", "by-session")
    const summaryScopes = usingResolvedChannelScopes ? summaryScopesFromResolved : (existsSync(summaryRoot) ? [summaryRoot] : [])
    const stage2Scopes = usingResolvedChannelScopes ? scopes.filter((s) => !summaryScopesFromResolved.includes(s)) : scopes

    if (summaryScopes.length > 0) {
      const totalBudgetMs = budgetMs
      const stage1TimeoutMs = Math.min(totalBudgetMs, Math.max(300, Math.round(totalBudgetMs * 0.3)))
      const stage1Start = Date.now()
      const stage1 = await runner(summaryScopes, stage1TimeoutMs, topk)
      const stage1ElapsedMs = Date.now() - stage1Start

      const distinctSessionCoverage = countDistinctSessionIds(stage1.hits)
      const sufficientCoverage = distinctSessionCoverage >= args.limit

      if (usingResolvedChannelScopes && exportComplete && sufficientCoverage && !stage1.timedOut) {
        return { hits: stage1.hits, durationMs: stage1.durationMs, timedOut: stage1.timedOut, rc: stage1.rc, stderr: stage1.stderr, strategy: "session-summary-only", scopeCoverage: stage1.scopeCoverage }
      }

      const remainingMs = totalBudgetMs - stage1ElapsedMs
      if (remainingMs < MIN_STAGE2_BUDGET_MS) {
        // No meaningful budget left — return the (possibly incomplete) stage 1
        // evidence marked timed out rather than overshooting the caller's budget.
        return { hits: stage1.hits, durationMs: stage1.durationMs, timedOut: true, rc: stage1.rc, stderr: stage1.stderr, strategy: "session-summary-partial-no-budget", scopeCoverage: stage1.scopeCoverage }
      }

      const stage2 = await runner(stage2Scopes, remainingMs, topk)
      const merged = [...stage1.hits, ...stage2.hits].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0)).slice(0, topk)
      return {
        hits: merged,
        durationMs: stage1ElapsedMs + stage2.durationMs,
        timedOut: stage1.timedOut || stage2.timedOut,
        rc: stage2.rc === 0 || stage1.rc === 0 ? 0 : stage2.rc,
        stderr: [stage1.stderr, stage2.stderr].filter(Boolean).join("\n"),
        strategy: "session-summary-then-conversation",
        scopeCoverage: stage2.scopeCoverage ?? stage1.scopeCoverage,
      }
    }
  }

  const res = await runner(scopes, budgetMs, topk)
  return { hits: res.hits, durationMs: res.durationMs, timedOut: res.timedOut, rc: res.rc, stderr: res.stderr, strategy: "direct", scopeCoverage: res.scopeCoverage }
}

/** Distinct session_id count over normalized hits — used to judge whether the
 * session-summary stage found enough DISTINCT sessions to satisfy the requested
 * grouped result limit, rather than being fooled by many hit lines in one summary. */
function countDistinctSessionIds(hits: NormHit[]): number {
  const ids = new Set<string>()
  for (const h of hits) if (h.sessionId) ids.add(h.sessionId)
  return ids.size
}

/** Shape-stable empty response for the "no sessions matched the pre-filter" case.
 * Mirrors the grouped/flat envelopes so the wire shape is identical to a real hit. */
function emptyResult(args: any, surface: SearchSurface, channels: SearchChannel[], groupBySession: boolean, plan: QueryPlan, scopeTruncated: boolean) {
  const debug = {
    backend: plan.backend,
    backends_tried: [] as SearchBackend[],
    plan_reason: plan.reason,
    literal: plan.literal,
    search_duration_ms: 0,
    ck_duration_ms: 0,
    ck_timed_out: false,
    recall_strategy: "empty-scope",
    partial: scopeTruncated,
    interrupted: false,
    role_filter_truncated: false,
    scope_truncated: scopeTruncated,
  }
  return groupBySession
    ? { sessions: table([]), hits_total: 0, mode: args.mode, surface, channels, scope_session_count: 0, ...debug, role_filter: args.role, suppressed: emptySuppressed(channels) }
    : { hits: table([]), mode: args.mode, surface, channels, scope_session_count: 0, ...debug, role_filter: args.role }
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
