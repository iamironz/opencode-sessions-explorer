/**
 * SQLite FTS5 sidecar index for fast literal + BM25 search.
 *
 * Replaces the pathologically slow `ck` CLI path for `lex` + literal queries
 * over the 9.2 GB / ~889k-file export tree. Documents are derived from SQLite
 * (the source of truth) via the same channel-view logic as the filesystem
 * exporter (`src/lib/export.ts`), NOT from the file tree.
 *
 * Two FTS5 tables hold the same document set for two jobs:
 *   - docs_sub  tokenize='trigram'                 -> literal / substring (body LIKE '%q%')
 *   - docs_lex  tokenize="unicode61 tokenchars '-_'" -> BM25-ranked lex (docs_lex MATCH ?)
 *
 * The trigram tokenizer makes `body LIKE ?` use the FTS index and gives
 * ASCII-case-insensitive substring matching. Over fully-indexed channels this
 * is equivalent-or-superset versus `rg -F` (fixed-string, case-insensitive),
 * with three DOCUMENTED gaps where the exhaustive (rg) tier can find a match
 * the fast (fts) tier misses:
 *   1. `tool-output` bodies are excerpted to head+tail (see FTS_EXCERPT_POLICY),
 *      so a match ONLY in the elided middle is not found in the index;
 *   2. case folding is ASCII-only (see FTS_CASE_FOLDING_ASCII_ONLY) — an indexed
 *      `ÄBC` is matched by `ÄBC`/`Äbc` but NOT by `äbc`, whereas ripgrep's `-i`
 *      is Unicode-aware;
 *   3. channels excluded from the substring subset (see ftsSubstringChannels)
 *      are absent from the trigram table entirely (still searchable via BM25/lex).
 * The unicode61 tokenizer keeps identifiers like `MP-4493` / `ses_xxx` as single
 * tokens for word-level ranking.
 *
 * Metadata columns (part_id, session_id, message_id, channel, role, ts) are
 * stored UNINDEXED. A plain `doc_map` table maps a part/summary to its FTS
 * rowids so re-indexing deletes by rowid (efficient) instead of scanning the
 * UNINDEXED part_id column (which would be O(n) per part -> O(n^2) on a build).
 *
 * The sidecar is a SEPARATE writable SQLite file. The shared `lib/db.js` handle
 * to opencode.db stays read-only and is never written here.
 *
 * FTS cursor vs upstream `SyncState` (export-state.ts) / tombstones:
 * This module keeps its OWN cursor (`fts_state.cursor`) instead of sharing
 * upstream's v3 `SyncState`. That is deliberate, not an oversight: the FTS
 * sidecar reads straight from SQLite (the source of truth) and never touches
 * the filesystem export tree, so upstream's export LOCK, insert-cursor
 * rewind window, per-part failed/dead-letter bookkeeping, and dirty-session
 * hints are all concerned with a problem this module doesn't have (safely
 * writing hundreds of thousands of files without racing another exporter
 * process). Sharing `SyncState` would couple this module's lifecycle to a
 * lock and a cursor shape designed for a different writer.
 *
 * That said, sharing NO state with the tombstone mechanism would be a real
 * correctness gap: `export-tombstones.ts` proves upstream itself needed to
 * hard-remove exported files for parts/sessions that later disappear from
 * SQLite entirely (hard delete, e.g. a deleted session or a compaction that
 * rewrites history) — the forward-only `p.time_updated > cursor` scan below
 * NEVER revisits a row that stops existing, so a naive port of only the
 * insert/update path would leave those docs permanently and silently stale
 * in the FTS index (ghost search hits for content that no longer exists,
 * including content from a session the user explicitly deleted). This is
 * fixed by `reconcileFtsTombstones()` below: on every UNBUDGETED `syncFts()`
 * call (mirroring `runExport()`'s own `if (!opts.budgetMs)` gate for its
 * filesystem tombstone reconcile), every part_id/session_id still present in
 * `doc_map` is checked against SQLite and removed if its part row or owning
 * session no longer exists. It is intentionally NOT run on the small budgeted
 * per-search delta-sync (`syncFts({ budgetMs: 1500 })` in search-text.ts) —
 * that call must stay cheap — so a value deleted moments ago can remain
 * searchable until the next full `fts-build` run or scheduled maintenance;
 * that latency window (not permanent staleness) is the accepted trade-off.
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { stmt } from "./db.js"
import {
  exportRoot,
  buildChannelDocuments,
  buildSessionSummaryDocument,
  type SessionInfo,
  type ChannelDocument,
} from "./export.js"
// Import the cursor type from its actual home (export-state.ts) rather than
// export.ts's re-export — export.ts no longer defines `ExportCursor` itself
// (it moved to export-state.ts alongside the rest of the v3 SyncState shape).
import type { ExportCursor, FailedPartState } from "./export-state.js"
import { CHANNELS, type SearchChannel } from "./channel.js"

/** Bump when the on-disk table shape or default channel/substring semantics
 *  change; a mismatch drops + rebuilds rather than silently serving a
 *  partial/stale-shaped corpus. v2: default channel set now covers every
 *  derived channel except `raw` (tool-output included, excerpted — see
 *  FTS_EXCERPT_POLICY), and doc_map.sub_rowid is nullable (a doc may be
 *  lex-only when its channel is outside ftsSubstringChannels()). */
const SCHEMA_VERSION = 2

/** Default indexed channel set: every derived channel except `raw` (the full
 *  by-session replay, which would duplicate all the other channels).
 *  tool-output is included but excerpted per FTS_EXCERPT_POLICY — at full
 *  size it is 876.1 MB of text; excerpted to 4KB head + 4KB tail it drops to
 *  ~512.7 MB while keeping 135k/168k docs (~80%) unexcerpted entirely. */
export const FTS_CHANNELS: SearchChannel[] = [
  "conversation",
  "session-summary",
  "tool-error",
  "tool-input-summary",
  "code-touch",
  "patch-summary",
  "reasoning",
  "file",
  "tool-output",
]

const LIMIT_DEFAULT = 100
const LIMIT_CAP = 1000
/** `total` counts are bounded at this cap for cheapness; a returned total equal
 *  to this value means "this many or more". */
const COUNT_CAP = 10_000
const SNIPPET_RADIUS = 200 // chars each side for the literal-path centered snippet
const SNIPPET_HARD_CAP = 600

/** Minimum contiguous literal (non-wildcard) characters a query needs before the
 *  `docs_sub` trigram index can accelerate a `body LIKE '%q%'`. Below this the
 *  operator degrades to a full content scan (see queryFts / DEFECT 3). The
 *  trigram tokenizer keys on 3-codepoint sequences, so 3 is the hard floor. */
const TRIGRAM_MIN = 3

/** Wall-clock ceiling for a trigram-UNusable literal scan when the caller passes
 *  no explicit `timeoutMs`. A run<TRIGRAM_MIN query would otherwise be a full
 *  scan of the whole content table (measured on the real 5GB / 566k-doc index:
 *  `%th%` ~0.5-12s depending on cache); this guarantees such a query can never
 *  run unbounded even if the planner forgets to route it to ripgrep. */
const DEGRADED_SCAN_DEFAULT_MS = 750

/** Hard cap on candidate rows collected on the degraded (trigram-unusable)
 *  bounded scan before it stops early. Keeps a very common short token (e.g.
 *  `th`, which matches tens of thousands of docs) from pulling an unbounded
 *  result set into JS memory. A degraded scan is best-effort by construction
 *  (marked `interrupted`), so a partial candidate window is acceptable. */
const DEGRADED_SCAN_ROW_CAP = 5_000

/** Max retry attempts for a part whose document build throws before it is moved
 *  to the dead-letter set (mirrors export.ts's MAX_FAILED_ATTEMPTS exactly, so
 *  the two sync paths bound retries the same way). */
const MAX_FAILED_ATTEMPTS = 5

/** TTL for the cached source-corpus high-water mark. `part` has no index on
 *  `time_updated`, so `SELECT MAX(time_updated) FROM part` is a full scan
 *  (~150ms on 514k rows — measured). Completeness/usability is authoritatively
 *  driven by the persisted `sync_complete` flag ALONE (see indexComplete);
 *  the high-water is used ONLY for the informational lag diagnostics in
 *  FtsStats (indexedHighWater / sourceHighWater / atSource / lagMs), NEVER to
 *  gate ftsUsable(). It is therefore off the hot per-search path entirely;
 *  caching it per-process for a short window keeps the diagnostic cheap. */
const SOURCE_HW_TTL_MS = 5_000

/**
 * KNOWN LIMITATION — non-ASCII case folding is NOT at parity with ripgrep.
 *
 * The `docs_sub` trigram tokenizer's case-insensitivity is ASCII-only: it folds
 * A-Z<->a-z but NOT accented / non-Latin letters. Verified on this bun/SQLite
 * build: an indexed body `ÄBC` is matched by a literal query `ÄBC` or `Äbc`
 * (the ASCII `bc` folds, `Ä` matches itself) but is NOT matched by `äbc`
 * (`Ä`<->`ä` is a non-ASCII fold the tokenizer does not perform). ripgrep's `-i`
 * IS Unicode-aware, so the exhaustive (rg) tier can find such a match that the
 * fast (fts) tier misses. Surfaced as `FtsStats.caseFoldingAsciiOnly` so callers
 * and docs can state this precisely instead of implying Unicode-case parity.
 */
export const FTS_CASE_FOLDING_ASCII_ONLY = true

// ---------------------------------------------------------------------------
// Path / channel resolution
// ---------------------------------------------------------------------------

export function ftsDbPath(root?: string): string {
  const env = process.env.OPENCODE_SESSIONS_EXPLORER_FTS_DB
  if (env) return env
  return join(root ?? exportRoot(), "fts-index.sqlite")
}

/** Env-aware resolved indexed channel set (comma-separated override). */
export function ftsChannels(): SearchChannel[] {
  const env = process.env.OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS
  if (!env || !env.trim()) return FTS_CHANNELS
  const valid = new Set<string>(CHANNELS)
  const out: SearchChannel[] = []
  for (const raw of env.split(",")) {
    const c = raw.trim()
    if (c && valid.has(c) && !out.includes(c as SearchChannel)) out.push(c as SearchChannel)
  }
  return out.length ? out : FTS_CHANNELS
}

export function ftsCovers(channels: SearchChannel[]): boolean {
  const set = new Set(ftsChannels())
  return channels.every((c) => set.has(c))
}

/**
 * Channels that get a `docs_sub` (trigram) row, in addition to always getting
 * a `docs_lex` (unicode61) row. Defaults to every indexed channel. Trimmable
 * via env because trigram is ~4.6x the text size on disk vs ~1.65x for
 * unicode61 — if the log-heavy channels (tool-output, tool-input-summary,
 * code-touch) turn out too heavy for the substring index, they can be
 * dropped from it without a code change. Docs for channels outside this set
 * are still indexed into `docs_lex` (still searchable in BM25/lex mode) —
 * they just skip the substring table. Always a subset of `ftsChannels()`:
 * an env entry naming a channel that isn't indexed at all is ignored.
 */
export function ftsSubstringChannels(): SearchChannel[] {
  const indexed = ftsChannels()
  const env = process.env.OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS
  if (!env || !env.trim()) return indexed
  const indexedSet = new Set(indexed)
  const out: SearchChannel[] = []
  for (const raw of env.split(",")) {
    const c = raw.trim()
    if (c && indexedSet.has(c as SearchChannel) && !out.includes(c as SearchChannel)) out.push(c as SearchChannel)
  }
  return out.length ? out : indexed
}

// ---------------------------------------------------------------------------
// Handle management (cached per-process, keyed by path)
// ---------------------------------------------------------------------------

let _fts: Database | null = null
let _ftsPath: string | null = null

/**
 * Last error observed by `ftsPresent()` / `ftsStats()`, or `null` if the
 * most recent check succeeded (or the sidecar is genuinely absent, which is
 * not an error). Exposed via `FtsStats.lastError` so a future silent-disable
 * is diagnosable instead of invisible (see the bug this fixed: `ftsPresent()`
 * used a `readonly: true` connection, which throws SQLITE_CANTOPEN against a
 * WAL-mode db whose `-shm` file is absent — e.g. right after
 * `PRAGMA wal_checkpoint(TRUNCATE)` — and the swallowed throw silently
 * disabled the whole FTS backend with no diagnostic trace).
 */
let _lastFtsError: string | null = null

function fmtFtsError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function hasTable(dbh: Database, name: string): boolean {
  return !!dbh
    .query(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
    .get(name)
}

/** The FTS content/mapping tables that form ONE coupled set with `fts_state`'s
 *  completeness/cursor bookkeeping. A sidecar is only trustworthy when ALL of
 *  these exist together at the current schema version — see ensureSchema. */
const COUPLED_TABLES = ["docs_sub", "docs_lex", "doc_map"] as const

function ensureSchema(dbh: Database): void {
  dbh.exec(`CREATE TABLE IF NOT EXISTS fts_state (key TEXT PRIMARY KEY, value TEXT)`)
  const verRow = dbh.query(`SELECT value FROM fts_state WHERE key = 'schema_version'`).get() as
    | { value: string }
    | null
  const allTablesExist = COUPLED_TABLES.every((t) => hasTable(dbh, t))
  const versionMatches = verRow?.value === String(SCHEMA_VERSION)

  // Trustworthy iff EVERY coupled table exists AND the version matches. Anything
  // else — a version mismatch, a fresh file, OR (DEFECT 1) a corrupt sidecar
  // where the version matches but some coupled table was dropped/lost — forces a
  // full rebuild of the whole coupled set. We must NEVER silently patch a
  // missing subset: recreating just the dropped `docs_sub` while leaving
  // `sync_complete=1` and the cursor intact made ftsUsable() report an all-zero
  // index as authoritative, silently truncating every literal search with no way
  // for the user to tell. Treating docs_sub/docs_lex/doc_map/fts_state as one
  // coupled set and clearing completeness/cursor/failure state makes the index
  // honestly "not built" until a real build drains the source again.
  if (allTablesExist && versionMatches) return

  dbh.exec(`DROP TABLE IF EXISTS docs_sub`)
  dbh.exec(`DROP TABLE IF EXISTS docs_lex`)
  dbh.exec(`DROP TABLE IF EXISTS doc_map`)
  dbh.exec(
    `DELETE FROM fts_state WHERE key IN ('cursor', 'sync_complete', 'failed_parts', 'dead_letters')`,
  )
  dbh.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS docs_sub USING fts5(` +
      `part_id UNINDEXED, session_id UNINDEXED, message_id UNINDEXED, ` +
      `channel UNINDEXED, role UNINDEXED, ts UNINDEXED, body, ` +
      `tokenize='trigram')`,
  )
  dbh.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS docs_lex USING fts5(` +
      `part_id UNINDEXED, session_id UNINDEXED, message_id UNINDEXED, ` +
      `channel UNINDEXED, role UNINDEXED, ts UNINDEXED, body, ` +
      `tokenize="unicode61 tokenchars '-_'")`,
  )
  dbh.exec(
    `CREATE TABLE IF NOT EXISTS doc_map (` +
      `part_id TEXT, session_id TEXT, channel TEXT, sub_rowid INTEGER, lex_rowid INTEGER)`,
  )
  dbh.exec(`CREATE INDEX IF NOT EXISTS idx_doc_map_part ON doc_map(part_id)`)
  dbh.exec(`CREATE INDEX IF NOT EXISTS idx_doc_map_sess ON doc_map(session_id, channel)`)
  dbh.exec(
    `INSERT INTO fts_state(key, value) VALUES('schema_version', '${SCHEMA_VERSION}') ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
}

/**
 * Open (or return the cached) READ-WRITE handle to OUR OWN sidecar file. This
 * is the ONE open path the whole module uses — for writes (syncFts) and for
 * reads (queryFts, ftsPresent, ftsStats) alike. The sidecar is a separate file
 * we exclusively own and write, so read-write is correct here, unlike the
 * genuinely-shared, genuinely-read-only `lib/db.ts` handle onto OpenCode's own
 * `opencode.db` (that rule is untouched — see the module doc comment).
 *
 * A `readonly: true` bun:sqlite connection to a WAL-mode db throws
 * SQLITE_CANTOPEN whenever it needs to create the `-shm`/`-wal` files and
 * can't (e.g. right after `PRAGMA wal_checkpoint(TRUNCATE)` removed them) —
 * this is exactly what silently disabled the whole FTS backend before this
 * fix. Never open this sidecar readonly.
 *
 * On a failed open/pragma/schema step, any partially-opened handle is closed
 * before the error propagates, so repeated failing calls (e.g. `ftsPresent()`
 * being polled once per search against a genuinely corrupt file) cannot leak
 * native sqlite handles — `_fts` is left `null` either way.
 */
function openFts(path: string): Database {
  if (_fts && _ftsPath === path) return _fts
  if (_fts) {
    try { _fts.close() } catch { /* ignore */ }
    _fts = null
    _ftsPath = null
  }
  mkdirSync(dirname(path), { recursive: true })
  let dbh: Database | undefined
  try {
    dbh = new Database(path, { create: true })
    dbh.exec("PRAGMA journal_mode=WAL;")
    dbh.exec("PRAGMA synchronous=NORMAL;")
    dbh.exec("PRAGMA temp_store=MEMORY;")
    dbh.exec("PRAGMA cache_size=-64000;")
    ensureSchema(dbh)
  } catch (e) {
    if (dbh) { try { dbh.close() } catch { /* ignore */ } }
    throw e
  }
  _fts = dbh
  _ftsPath = path
  return dbh
}

/**
 * True iff the sidecar file exists AND carries the expected tables. Never
 * throws (genuine corruption/unreadable-file yields false so callers can
 * fall back). Routes through the SAME cached read-write handle the rest of
 * the module uses (`openFts`) — NOT a `readonly: true` connection, which is
 * what caused the original bug (see `openFts`'s doc comment). Calling this
 * repeatedly (once per search, as callers do) does not leak handles: the
 * underlying `openFts` either returns the already-cached handle or closes
 * any partial handle before a failure propagates.
 *
 * On failure, records a diagnostic in the module-level last-error slot,
 * surfaced via `FtsStats.lastError` — so a future silent disable is
 * observable instead of invisible.
 */
export function ftsPresent(root?: string): boolean {
  const path = ftsDbPath(root)
  if (!existsSync(path)) {
    _lastFtsError = null // genuine absence is not an error
    return false
  }
  try {
    const dbh = openFts(path)
    const ok = hasTable(dbh, "docs_sub") && hasTable(dbh, "docs_lex")
    _lastFtsError = ok ? null : "sidecar file exists but expected FTS tables (docs_sub/docs_lex) are missing"
    return ok
  } catch (e) {
    _lastFtsError = fmtFtsError(e)
    return false
  }
}

export function _closeFtsForTest(): void {
  if (_fts) {
    try { _fts.close() } catch { /* ignore */ }
  }
  _fts = null
  _ftsPath = null
  _lastFtsError = null
  _srcHwCache = null
}

// ---------------------------------------------------------------------------
// Cursor persistence (fts_state)
// ---------------------------------------------------------------------------

function readCursor(dbh: Database): ExportCursor | null {
  const row = dbh.query(`SELECT value FROM fts_state WHERE key = 'cursor'`).get() as
    | { value: string }
    | null
  if (!row?.value) return null
  try {
    const o = JSON.parse(row.value)
    if (o && typeof o.ts === "number" && typeof o.id === "string") return { ts: o.ts, id: o.id }
  } catch { /* ignore */ }
  return null
}

function writeCursor(dbh: Database, c: ExportCursor | null): void {
  if (!c) {
    dbh.exec(`DELETE FROM fts_state WHERE key = 'cursor'`)
    return
  }
  dbh
    .query(
      `INSERT INTO fts_state(key, value) VALUES('cursor', ?) ` +
        `ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(JSON.stringify(c))
}

// ---------------------------------------------------------------------------
// Completeness ("built") vs freshness ("lag") — two DISTINCT properties.
//
// DEFECT 1: a sidecar whose tables merely exist is NOT proof it covers the
// source corpus. `sync_complete` is the AUTHORITATIVE, durable, monotonic
// signal that some UNBUDGETED sync drained the whole source `part` table at
// least once. It is set true only when a sync exhausts the source with no
// unresolved failures, and cleared ONLY on `--reset` / schema-version rebuild.
//
// CRITICAL (the second-bug fix): completeness ("has a full pass ever walked the
// whole corpus?") is SEPARATE from freshness ("how far behind the live source
// is the index right now?"). Only completeness gates usability. Freshness/lag
// is informational ONLY. On a live system OpenCode writes new parts
// continuously, so the indexed cursor is essentially ALWAYS a little behind the
// source high-water; gating usability on "caught up to source" (the original
// mistake) is UNSATISFIABLE on any active machine — it kept ftsUsable() false
// forever and routed every literal search to a ~15s ripgrep scan instead of the
// ~20ms indexed query. The indexed cursor (indexed high-water) is compared
// against the live source high-water PURELY as a diagnostic (indexedHighWater /
// sourceHighWater / atSource / lagMs in FtsStats); that comparison never feeds
// indexComplete() / ftsUsable(). Delta staleness is expected and is exactly what
// the budgeted per-search `syncFts` continuously narrows.
// ---------------------------------------------------------------------------

function readStateString(dbh: Database, key: string): string | null {
  const row = dbh.query(`SELECT value FROM fts_state WHERE key = ?`).get(key) as { value: string } | null
  return row?.value ?? null
}

function writeStateString(dbh: Database, key: string, value: string): void {
  dbh
    .query(`INSERT INTO fts_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value)
}

function readSyncComplete(dbh: Database): boolean {
  return readStateString(dbh, "sync_complete") === "1"
}

function writeSyncComplete(dbh: Database, complete: boolean): void {
  writeStateString(dbh, "sync_complete", complete ? "1" : "0")
}

function readFailedMap(dbh: Database, key: "failed_parts" | "dead_letters"): Record<string, FailedPartState> {
  const raw = readStateString(dbh, key)
  if (!raw) return {}
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, FailedPartState>
  } catch { /* ignore malformed */ }
  return {}
}

function writeFailedMap(dbh: Database, key: "failed_parts" | "dead_letters", map: Record<string, FailedPartState>): void {
  writeStateString(dbh, key, JSON.stringify(map))
}

// Per-process cache for the source-corpus high-water mark (see SOURCE_HW_TTL_MS).
let _srcHwCache: { at: number; hw: ExportCursor | null } | null = null

/**
 * Cheapest available high-water of the source `part` table as `{ts,id}`, cached
 * per-process for SOURCE_HW_TTL_MS. Returns null when the source DB is absent
 * (hermetic tests / uninstalled OpenCode) so callers degrade gracefully rather
 * than throwing. `part` has no `time_updated` index, so this is a scan — hence
 * the cache and the fact that it is NEVER on the hot literal-query path.
 */
function sourceHighWater(): ExportCursor | null {
  const now = Date.now()
  if (_srcHwCache && now - _srcHwCache.at < SOURCE_HW_TTL_MS) return _srcHwCache.hw
  let hw: ExportCursor | null = null
  try {
    const row = stmt(
      `SELECT time_updated AS ts, id FROM part ORDER BY time_updated DESC, id DESC LIMIT 1`,
    ).get() as { ts: number; id: string } | null
    if (row && typeof row.ts === "number" && typeof row.id === "string") hw = { ts: row.ts, id: row.id }
  } catch {
    hw = null // DB_NOT_FOUND or similar — treat as "unknown"
  }
  _srcHwCache = { at: now, hw }
  return hw
}

/** Test-only: drop the source high-water cache so a freshly-seeded fixture is
 *  observed immediately. Not part of the runtime surface. */
export function _resetSourceHighWaterCacheForTest(): void {
  _srcHwCache = null
}

/** Test-only: pin the source high-water the next `ftsStats()`/diagnostics read,
 *  so a lag scenario (indexed cursor strictly behind a KNOWN moving source) can
 *  be constructed deterministically without a real, growing `opencode.db`. Used
 *  to prove lag is reported (atSource/lagMs) but never gates ftsUsable(). Pass
 *  null to clear. Not part of the runtime surface. */
export function _setSourceHighWaterForTest(hw: ExportCursor | null): void {
  _srcHwCache = { at: Date.now(), hw }
}

/** True iff the indexed cursor has reached (or passed) the source high-water.
 *  DIAGNOSTIC ONLY — never gates completeness/usability (see indexComplete). */
function cursorAtSource(cursor: ExportCursor | null, src: ExportCursor | null): boolean {
  if (!cursor || !src) return false
  return cursor.ts > src.ts || (cursor.ts === src.ts && cursor.id >= src.id)
}

/** Milliseconds the indexed high-water lags the source high-water (>= 0), or
 *  null when either is unknown. Informational lag diagnostic, never a gate. */
function computeLagMs(cursor: ExportCursor | null, src: ExportCursor | null): number | null {
  if (!cursor || !src) return null
  return Math.max(0, src.ts - cursor.ts)
}

/**
 * Whether the index is COMPLETE ENOUGH to be treated as authoritative. This is
 * a DURABLE, MONOTONIC fact — NOT a freshness/lag check:
 *   - there are NO unresolved (retriable) failed parts (DEFECT 2), AND
 *   - the persisted `sync_complete` flag is set (some prior UNBUDGETED sync
 *     drained the entire source `part` table at least once).
 *
 * It DELIBERATELY does not consider how far the index currently lags the live
 * source high-water. On a live system OpenCode writes new parts constantly, so
 * the indexed cursor is essentially always slightly behind; gating on "caught
 * up" would make this return false forever and disable the whole fast tier (the
 * exact second bug this fixes). Lag is surfaced (atSource / lagMs) but never
 * gates.
 *
 * Legacy migration: an ABSENT flag means "unknown / not yet proven drained",
 * treated as NOT complete. The flag is set the first time an unbudgeted
 * `syncFts` drains the source — so a single `opencode-sessions-explorer-fts-build`
 * run (no `--reset`) promotes an already-populated legacy index. This is
 * intentionally conservative: we never guess that a genuinely partial build is
 * complete (that was the original blocking defect's mirror image). The prior
 * `cursor >= sourceHighWater` legacy heuristic is gone precisely because it was
 * BOTH unsatisfiable on a live system AND capable of mislabelling a partial
 * build as complete.
 *
 * Dead-lettered parts do NOT block completeness — they have exhausted retries
 * and would otherwise brick the fast tier forever for a single un-buildable
 * part; they are surfaced in FtsStats instead so the partialness stays visible.
 *
 * Point 4 (a later budgeted delta-sync must NOT flip a complete index back to
 * incomplete) is satisfied structurally: `sync_complete` is only ever cleared by
 * a reset/rebuild, never by a budget-stopped delta run.
 */
function indexComplete(dbh: Database): boolean {
  if (Object.keys(readFailedMap(dbh, "failed_parts")).length > 0) return false
  return readSyncComplete(dbh)
}

/**
 * DEFECT 1 CONTRACT: true only when the sidecar is PRESENT and COMPLETE enough
 * to be treated as authoritative (see `indexComplete`). `search-text.ts` gates
 * the fast tier on this instead of the weaker `ftsPresent()` — a partial index
 * (e.g. after `fts-build --budget-ms 5000`, or immediately after a schema
 * rebuild) returns false here, so literal search escalates to ripgrep rather
 * than silently serving a few-percent result set. Never throws. Do NOT rename:
 * this exact name/signature is the contract search-text.ts is coded against.
 */
export function ftsUsable(root?: string): boolean {
  if (!ftsPresent(root)) return false
  try {
    const dbh = openFts(ftsDbPath(root))
    return indexComplete(dbh)
  } catch (e) {
    _lastFtsError = fmtFtsError(e)
    return false
  }
}

// ---------------------------------------------------------------------------
// Prepared write statements + idempotent upsert helpers
// ---------------------------------------------------------------------------

type WriteStmts = {
  insSub: ReturnType<Database["query"]>
  insLex: ReturnType<Database["query"]>
  insMap: ReturnType<Database["query"]>
  delSubRow: ReturnType<Database["query"]>
  delLexRow: ReturnType<Database["query"]>
  selMapPart: ReturnType<Database["query"]>
  delMapPart: ReturnType<Database["query"]>
  selMapSummary: ReturnType<Database["query"]>
  delMapSummary: ReturnType<Database["query"]>
}

function prepWrites(dbh: Database): WriteStmts {
  const cols = `part_id, session_id, message_id, channel, role, ts, body`
  const vals = `?, ?, ?, ?, ?, ?, ?`
  return {
    insSub: dbh.query(`INSERT INTO docs_sub(${cols}) VALUES(${vals})`),
    insLex: dbh.query(`INSERT INTO docs_lex(${cols}) VALUES(${vals})`),
    insMap: dbh.query(`INSERT INTO doc_map(part_id, session_id, channel, sub_rowid, lex_rowid) VALUES(?, ?, ?, ?, ?)`),
    delSubRow: dbh.query(`DELETE FROM docs_sub WHERE rowid = ?`),
    delLexRow: dbh.query(`DELETE FROM docs_lex WHERE rowid = ?`),
    selMapPart: dbh.query(`SELECT sub_rowid, lex_rowid FROM doc_map WHERE part_id = ?`),
    delMapPart: dbh.query(`DELETE FROM doc_map WHERE part_id = ?`),
    selMapSummary: dbh.query(`SELECT sub_rowid, lex_rowid FROM doc_map WHERE session_id = ? AND channel = 'session-summary'`),
    delMapSummary: dbh.query(`DELETE FROM doc_map WHERE session_id = ? AND channel = 'session-summary'`),
  }
}

type DocRow = {
  part_id: string | null
  session_id: string | null
  message_id: string | null
  channel: SearchChannel
  role: string | null
  ts: number | null
  body: string
}

/** Delete every doc row previously indexed for a part (both tables, if present)
 *  by rowid. `sub_rowid` is null for docs whose channel was outside the
 *  substring set at insert time (lex-only). */
function deletePart(w: WriteStmts, partId: string): number {
  const maps = w.selMapPart.all(partId) as { sub_rowid: number | null; lex_rowid: number }[]
  for (const m of maps) {
    if (m.sub_rowid != null) w.delSubRow.run(m.sub_rowid)
    w.delLexRow.run(m.lex_rowid)
  }
  if (maps.length) w.delMapPart.run(partId)
  return maps.length
}

/** Delete the session-summary doc for a session (both tables, if present) by rowid. */
function deleteSummary(w: WriteStmts, sessionId: string): number {
  const maps = w.selMapSummary.all(sessionId) as { sub_rowid: number | null; lex_rowid: number }[]
  for (const m of maps) {
    if (m.sub_rowid != null) w.delSubRow.run(m.sub_rowid)
    w.delLexRow.run(m.lex_rowid)
  }
  if (maps.length) w.delMapSummary.run(sessionId)
  return maps.length
}

const TOMBSTONE_BATCH = 500

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Remove FTS docs whose part (or owning session) no longer exists in SQLite.
 * Fixes the correctness gap described in the module doc comment: the
 * forward-only `p.time_updated > cursor` scan in `syncFts` never revisits a
 * part_id/session_id that disappears from SQLite entirely (hard delete), so
 * without this the stale doc would sit in the index forever.
 *
 * A part is only considered "live" if BOTH its own row exists in `part` AND
 * its `session_id` still exists in `session` — matching the semantics of
 * `export-tombstones.ts`, which wholesale-removes an exported session
 * directory the moment its session row disappears, even if some of that
 * session's part rows happened to still be present. Session-summary docs
 * (keyed by session_id, part_id null) are checked against `session` alone.
 *
 * Batches the SQLite existence check (IN-list of `TOMBSTONE_BATCH` ids at a
 * time) so a large index doesn't build one enormous query. Runs only when
 * the caller opts in (unbudgeted `syncFts` calls) — see the module doc
 * comment for why this must never run on the small per-search delta-sync.
 */
function reconcileFtsTombstones(dbh: Database, w: WriteStmts): { removedParts: number; removedSessions: number } {
  let removedParts = 0
  let removedSessions = 0

  const partIds = (
    dbh.query(`SELECT DISTINCT part_id FROM doc_map WHERE part_id IS NOT NULL`).all() as { part_id: string }[]
  ).map((r) => r.part_id)
  for (const batch of chunk(partIds, TOMBSTONE_BATCH)) {
    const placeholders = batch.map(() => "?").join(",")
    const live = new Set(
      (
        stmt(
          `SELECT p.id AS id FROM part p JOIN session s ON s.id = p.session_id WHERE p.id IN (${placeholders})`,
        ).all(...batch) as { id: string }[]
      ).map((r) => r.id),
    )
    for (const id of batch) {
      if (!live.has(id)) removedParts += deletePart(w, id)
    }
  }

  const summarySessionIds = (
    dbh
      .query(`SELECT DISTINCT session_id FROM doc_map WHERE channel = 'session-summary' AND session_id IS NOT NULL`)
      .all() as { session_id: string }[]
  ).map((r) => r.session_id)
  for (const batch of chunk(summarySessionIds, TOMBSTONE_BATCH)) {
    const placeholders = batch.map(() => "?").join(",")
    const live = new Set(
      (stmt(`SELECT id FROM session WHERE id IN (${placeholders})`).all(...batch) as { id: string }[]).map(
        (r) => r.id,
      ),
    )
    for (const id of batch) {
      if (!live.has(id)) removedSessions += deleteSummary(w, id)
    }
  }

  return { removedParts, removedSessions }
}

/** Insert one doc into `docs_lex` always, and into `docs_sub` only if its
 *  channel is in `substringChannels` (defaults to every indexed channel). */
function insertDoc(w: WriteStmts, d: DocRow, substringChannels: Set<SearchChannel>): void {
  let subRowid: number | null = null
  if (substringChannels.has(d.channel)) {
    const rs = w.insSub.run(d.part_id, d.session_id, d.message_id, d.channel, d.role, d.ts, d.body)
    subRowid = Number(rs.lastInsertRowid)
  }
  const rl = w.insLex.run(d.part_id, d.session_id, d.message_id, d.channel, d.role, d.ts, d.body)
  w.insMap.run(d.part_id, d.session_id, d.channel, subRowid, Number(rl.lastInsertRowid))
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export type FtsStats = {
  present: boolean
  docs: number
  bytes: number
  cursor: ExportCursor | null
  channels: SearchChannel[]
  /** DEFECT 1: true only when the index is complete enough to be authoritative
   *  (same predicate as `ftsUsable()`). A present-but-partial index is `true`
   *  for `present` and `false` here. */
  complete: boolean
  /** Highest `(ts,id)` actually indexed (== `cursor`) — the indexed high-water. */
  indexedHighWater: ExportCursor | null
  /** Highest `(ts,id)` currently in the source `part` table, or null when the
   *  source DB is unavailable. Compared against `indexedHighWater` to diagnose
   *  HOW far behind a partial index is. */
  sourceHighWater: ExportCursor | null
  /** True when `indexedHighWater` has caught up to `sourceHighWater`. When
   *  false the index is behind recent source rows. INFORMATIONAL ONLY — this
   *  is a freshness signal and NEVER gates `complete`/`ftsUsable()` (see
   *  indexComplete): on a live system it is almost always false and that is
   *  normal. */
  atSource: boolean
  /** Milliseconds the indexed high-water lags the source high-water
   *  (`sourceHighWater.ts - indexedHighWater.ts`, clamped >= 0), or null when
   *  either is unknown. Purely informational — never gates usability. Lets a
   *  diagnostic say "N minutes behind" precisely instead of just a boolean. */
  lagMs: number | null
  /** Count of parts whose document build threw and are still in the retriable
   *  hot set. Non-zero withholds `complete` (DEFECT 2). */
  failedParts: number
  /** Count of parts that exhausted `MAX_FAILED_ATTEMPTS` retries and were moved
   *  to the dead-letter set. These do NOT block `complete`, but they DO mean the
   *  index is permanently missing that content until the source part changes. */
  deadLetters: number
  /** DEFECT / audit note: the trigram literal path folds case for ASCII only,
   *  unlike ripgrep's Unicode-aware `-i`. See FTS_CASE_FOLDING_ASCII_ONLY. */
  caseFoldingAsciiOnly: boolean
  /** Diagnostic for the most recent `ftsPresent()`/`ftsStats()` failure, or
   *  `null` on success (including genuine absence, which is not an error).
   *  Makes a future silent backend-disable observable instead of invisible. */
  lastError: string | null
}

function emptyStats(channels: SearchChannel[], lastError: string | null): FtsStats {
  return {
    present: false,
    docs: 0,
    bytes: 0,
    cursor: null,
    channels,
    complete: false,
    indexedHighWater: null,
    sourceHighWater: null,
    atSource: false,
    lagMs: null,
    failedParts: 0,
    deadLetters: 0,
    caseFoldingAsciiOnly: FTS_CASE_FOLDING_ASCII_ONLY,
    lastError,
  }
}

export function ftsStats(root?: string): FtsStats {
  const channels = ftsChannels()
  if (!ftsPresent(root)) return emptyStats(channels, _lastFtsError)
  const path = ftsDbPath(root)
  try {
    const dbh = openFts(path)
    const docs = Number((dbh.query(`SELECT COUNT(*) AS c FROM docs_sub`).get() as { c: number }).c)
    let bytes = 0
    for (const suffix of ["", "-wal", "-shm"]) {
      try { bytes += statSync(path + suffix).size } catch { /* ignore */ }
    }
    const cursor = readCursor(dbh)
    const srcHw = sourceHighWater()
    _lastFtsError = null
    return {
      present: true,
      docs,
      bytes,
      cursor,
      channels,
      complete: indexComplete(dbh),
      indexedHighWater: cursor,
      sourceHighWater: srcHw,
      atSource: cursorAtSource(cursor, srcHw),
      lagMs: computeLagMs(cursor, srcHw),
      failedParts: Object.keys(readFailedMap(dbh, "failed_parts")).length,
      deadLetters: Object.keys(readFailedMap(dbh, "dead_letters")).length,
      caseFoldingAsciiOnly: FTS_CASE_FOLDING_ASCII_ONLY,
      lastError: null,
    }
  } catch (e) {
    _lastFtsError = fmtFtsError(e)
    return emptyStats(channels, _lastFtsError)
  }
}

// ---------------------------------------------------------------------------
// Per-channel excerpt policy (indexing-path only — never touches the
// filesystem export tree or export.ts's own 256KB capBody).
// ---------------------------------------------------------------------------

/**
 * Per-channel head+tail excerpt policy applied only when building FTS
 * documents. `tool-output` is the one channel big enough to matter (measured:
 * 168,261 docs / 876.1 MB; 33,218 docs are >8KB). Data-driven so it can be
 * tuned/observed without touching the excerpting logic itself.
 */
export const FTS_EXCERPT_POLICY: Partial<Record<SearchChannel, { headBytes: number; tailBytes: number }>> = {
  "tool-output": { headBytes: 4096, tailBytes: 4096 },
}

/** Exact separator `buildChannelDocuments` / `buildPartFile` join headers and
 *  body with (see export.ts: `[...headers, "---BODY---", body].join("\n")`). */
const BODY_SEPARATOR = "\n---BODY---\n"

/**
 * Excerpt a document's BODY (never the header lines) per FTS_EXCERPT_POLICY.
 * Pure and directly unit-testable. Header lines (PART_ID, SESSION_ID,
 * MESSAGE_ID, ROLE, TYPE, ARCHIVED, CHANNEL, TOOL, STATUS, ...) plus the
 * `---BODY---` separator are always preserved verbatim; only the text after
 * the separator is subject to excerpting.
 *
 * If there is no policy for the channel, or the body already fits within
 * headBytes+tailBytes, the content is returned unchanged (no marker). If
 * excerpted, a single middle marker is inserted between head and tail naming
 * the real total body size and the part_id to dereference for the full text.
 * All cuts are on UTF-8 byte boundaries, mirroring capBody's non-fatal-decode
 * + replacement-char-strip technique (trailing for the head cut, leading for
 * the tail cut, since the cut can land mid multibyte character on either side).
 */
export function excerptDocument(channel: SearchChannel, content: string, partId: string | null): string {
  const policy = FTS_EXCERPT_POLICY[channel]
  if (!policy) return content
  const sepIdx = content.indexOf(BODY_SEPARATOR)
  if (sepIdx < 0) return content // no recognizable separator — leave unchanged, don't risk cutting headers

  const headerPart = content.slice(0, sepIdx + BODY_SEPARATOR.length)
  const body = content.slice(sepIdx + BODY_SEPARATOR.length)

  const enc = new TextEncoder()
  const bodyBytes = enc.encode(body)
  const totalBytes = bodyBytes.length
  if (totalBytes <= policy.headBytes + policy.tailBytes) return content // fits — no truncation needed

  const dec = new TextDecoder("utf-8", { fatal: false })
  const headStr = dec.decode(bodyBytes.slice(0, policy.headBytes)).replace(/\uFFFD+$/, "")
  const tailStr = dec.decode(bodyBytes.slice(totalBytes - policy.tailBytes)).replace(/^\uFFFD+/, "")
  const marker =
    `\n...[middle truncated; ${totalBytes} bytes total; ` +
    `call opencode-sessions-explorer-get-part('${partId ?? "?"}') for the full output]\n`

  return headerPart + headStr + marker + tailStr
}

// ---------------------------------------------------------------------------
// Sync (incremental build from SQLite)
// ---------------------------------------------------------------------------

export type FtsSyncResult = {
  indexed: number
  deleted: number
  skipped: number
  last_cursor: ExportCursor | null
  durationMs: number
  /** True iff THIS run drained the source `part` table (reached the end) rather
   *  than stopping on a budget. Distinct from the persisted `complete` below. */
  completed: boolean
  /** DEFECT 1: the persisted authoritative completeness state AFTER this run —
   *  i.e. what `ftsUsable()` will report. A budget-stopped run on an
   *  already-complete index keeps this true; a budget-stopped first build leaves
   *  it false; unresolved failed parts hold it false even after a full drain. */
  complete: boolean
  /** DEFECT 2: parts whose document build threw during THIS run and were
   *  recorded for retry (newly-failed + re-failed on retry). A "complete" index
   *  is never reported while any such part remains unresolved. */
  failed: number
  /** DEFECT 2: parts moved to the dead-letter set this run (exhausted
   *  MAX_FAILED_ATTEMPTS). Content for these is permanently missing until the
   *  source part changes; surfaced so it is counted and reported, never silent. */
  dead_lettered: number
  /** DEFECT 2: previously-failed parts retried during THIS run (unbudgeted
   *  runs only — see retryFailedFtsParts). */
  retried: number
  /** Total unresolved (retriable) failed parts persisted AFTER this run. */
  failed_outstanding: number
  /** Total dead-lettered parts persisted AFTER this run. */
  dead_letter_outstanding: number
  /** Docs removed by `reconcileFtsTombstones` because their part no longer
   *  exists in SQLite (or its owning session was deleted). Only non-zero on
   *  an unbudgeted call — see the module doc comment. */
  tombstones_removed_parts: number
  /** Session-summary docs removed because their session no longer exists.
   *  Only non-zero on an unbudgeted call. */
  tombstones_removed_sessions: number
}

/** Load one part row (with its message role) by id — used by the failed-part
 *  retry pass. Mirrors the column shape the main sync scan selects. */
const PART_BY_ID_SQL =
  `SELECT p.id, p.session_id, p.message_id, p.time_updated, p.data, ` +
  `json_extract(m.data,'$.role') AS role ` +
  `FROM part p LEFT JOIN message m ON m.id = p.message_id WHERE p.id = ?`

/** Record (or re-record) a failed part in the persisted maps, dead-lettering it
 *  once it exceeds MAX_FAILED_ATTEMPTS. Mirrors export.ts's markPartFailure so
 *  both sync paths bound retries identically. Mutates `failed`/`dead` in place
 *  and returns whether the part was dead-lettered this call. */
function recordFtsFailure(
  failed: Record<string, FailedPartState>,
  dead: Record<string, FailedPartState>,
  partId: string,
  message: string,
): boolean {
  if (dead[partId]) return false // already given up on
  const now = Date.now()
  const existing = failed[partId]
  const failure: FailedPartState = {
    id: partId,
    attempts: (existing?.attempts ?? 0) + 1,
    first_failed_at: existing?.first_failed_at ?? now,
    last_failed_at: now,
    last_error: message,
  }
  if (failure.attempts >= MAX_FAILED_ATTEMPTS) {
    dead[partId] = failure
    delete failed[partId]
    return true
  }
  failed[partId] = failure
  return false
}

/** Forget a part's failure state (both maps) — called when it re-indexes cleanly
 *  or when its source row has disappeared entirely. */
function clearFtsFailure(
  failed: Record<string, FailedPartState>,
  dead: Record<string, FailedPartState>,
  key: string,
): void {
  delete failed[key]
  delete dead[key]
}

/** doc_map/failed key for a session-summary build failure (summaries are keyed
 *  by session, not part, so they cannot collide with a real `prt_` id). */
function summaryFailKey(sessionId: string): string {
  return `summary:${sessionId}`
}

const SESSION_SQL =
  `SELECT id, title, project_id, directory, agent, model, cost, ` +
  `time_created, time_updated, time_archived, parent_id FROM session WHERE id = ?`

/**
 * DEFECT 2 retry pass (mirrors export.ts's retryFailedParts). Runs only on
 * unbudgeted syncs. For each persisted failure it reloads the source row and
 * re-attempts the build:
 *   - a part/summary whose source row is gone is cleared (the content is truly
 *     absent now, not a build failure);
 *   - a clean rebuild clears the failure;
 *   - a repeat throw re-records it (dead-lettering at MAX_FAILED_ATTEMPTS).
 * Bounded by the same MAX_FAILED_ATTEMPTS ceiling so a poison part cannot be
 * retried forever.
 */
function retryFailedFtsParts(
  dbh: Database,
  w: WriteStmts,
  failed: Record<string, FailedPartState>,
  dead: Record<string, FailedPartState>,
  channelSet: Set<SearchChannel>,
  substringSet: Set<SearchChannel>,
  getSess: (id: string) => SessionInfo | null,
  result: FtsSyncResult,
  // DEFECT 3: persist the (mutated) failure/dead-letter state + cursor atomically
  // with each retry's document change, INSIDE that same transaction.
  persistState: () => void,
): void {
  for (const key of Object.keys(failed).sort()) {
    result.retried++
    if (key.startsWith("summary:")) {
      const sid = key.slice("summary:".length)
      const s = getSess(sid)
      if (!s) {
        clearFtsFailure(failed, dead, key)
        dbh.transaction(() => persistState())()
        continue
      }
      try {
        const tx = dbh.transaction(() => {
          deleteSummary(w, sid)
          const body = buildSessionSummaryDocument(s)
          insertDoc(w, {
            part_id: null, session_id: sid, message_id: null,
            channel: "session-summary", role: null, ts: s.time_updated, body,
          }, substringSet)
          result.indexed++
          clearFtsFailure(failed, dead, key)
          persistState()
        })
        tx()
      } catch (e) {
        if (recordFtsFailure(failed, dead, key, fmtFtsError(e))) result.dead_lettered++
        result.failed++
        dbh.transaction(() => persistState())()
      }
      continue
    }
    const r = stmt(PART_BY_ID_SQL).get(key) as any
    if (!r) {
      clearFtsFailure(failed, dead, key) // source row gone
      dbh.transaction(() => persistState())()
      continue
    }
    try {
      const tx = dbh.transaction(() => {
        deletePart(w, r.id)
        const s = getSess(r.session_id)
        const archived = s?.time_archived != null
        const docs = buildChannelDocuments(r.id, r.session_id, r.message_id, r.data, archived, r.role ?? null, s?.directory)
        for (const d of docs) {
          if (!channelSet.has(d.channel)) { result.skipped++; continue }
          insertDoc(w, {
            part_id: r.id, session_id: r.session_id, message_id: r.message_id,
            channel: d.channel, role: r.role ?? null, ts: r.time_updated,
            body: excerptDocument(d.channel, d.content, r.id),
          }, substringSet)
          result.indexed++
        }
        clearFtsFailure(failed, dead, key)
        persistState()
      })
      tx()
    } catch (e) {
      if (recordFtsFailure(failed, dead, key, fmtFtsError(e))) result.dead_lettered++
      result.failed++
      dbh.transaction(() => persistState())()
    }
  }
}

export async function syncFts(
  opts: {
    root?: string
    fromCursor?: ExportCursor | null
    budgetMs?: number
    batchSize?: number
    onProgress?: (p: FtsSyncResult) => void
  } = {},
): Promise<FtsSyncResult> {
  const start = Date.now()
  const path = ftsDbPath(opts.root)
  const dbh = openFts(path)
  const w = prepWrites(dbh)
  const channelSet = new Set<SearchChannel>(ftsChannels())
  const substringSet = new Set<SearchChannel>(ftsSubstringChannels())
  const wantSummary = channelSet.has("session-summary")
  const batchSize = opts.batchSize ?? 1000
  const isReset = opts.fromCursor === null // explicit --reset (start from cursor zero)

  // DEFECT 2: a --reset rewrites the ENTIRE corpus, so the existing index is
  // partial for the whole duration of that rewrite. Durably clear completeness,
  // the cursor, and the failure/dead-letter state in ONE transaction BEFORE any
  // rewrite mutation begins — never only at the end. Otherwise a concurrent
  // search-text call, or a reset process killed midway, keeps treating a
  // half-rewritten index as authoritative. Completeness is set again only after
  // the rebuild genuinely drains the source (see finalize, below).
  if (isReset) {
    const clearForReset = dbh.transaction(() => {
      writeSyncComplete(dbh, false)
      writeCursor(dbh, null)
      writeFailedMap(dbh, "failed_parts", {})
      writeFailedMap(dbh, "dead_letters", {})
    })
    clearForReset()
  }

  const cursor = opts.fromCursor !== undefined ? opts.fromCursor : readCursor(dbh)

  // point-4: remember whether the index was already complete BEFORE this run so a
  // NON-DRAINING delta-sync on an already-complete index does not flip it back to
  // incomplete. DEFECT 2 (retry accounting): load the durable failed/dead-letter
  // maps so failures are counted, retried, and block completeness across runs. A
  // --reset just durably cleared everything above, so it starts from empty.
  const wasComplete = !isReset && readSyncComplete(dbh)
  const failed: Record<string, FailedPartState> = isReset ? {} : readFailedMap(dbh, "failed_parts")
  const dead: Record<string, FailedPartState> = isReset ? {} : readFailedMap(dbh, "dead_letters")

  const result: FtsSyncResult = {
    indexed: 0,
    deleted: 0,
    skipped: 0,
    last_cursor: cursor,
    durationMs: 0,
    completed: false,
    complete: false,
    failed: 0,
    dead_lettered: 0,
    retried: 0,
    failed_outstanding: 0,
    dead_letter_outstanding: 0,
    tombstones_removed_parts: 0,
    tombstones_removed_sessions: 0,
  }

  const noteFailure = (key: string, e: unknown): void => {
    if (recordFtsFailure(failed, dead, key, fmtFtsError(e))) result.dead_lettered++
    result.failed++
  }

  // DEFECT 3: persist the cursor AND the failure/dead-letter maps together, and
  // durably invalidate completeness the instant a hot failure exists. ALWAYS
  // called INSIDE the same transaction as the document mutations it accompanies,
  // so a crash can never (a) leave the cursor advanced past a part whose build
  // failure was not recorded, nor (b) leave a stale `sync_complete=1` alongside a
  // freshly-recorded failure. Completeness is only ever set back to true by the
  // drain-based finalize step below.
  const persistState = (): void => {
    if (result.last_cursor) writeCursor(dbh, result.last_cursor)
    writeFailedMap(dbh, "failed_parts", failed)
    writeFailedMap(dbh, "dead_letters", dead)
    if (Object.keys(failed).length > 0) writeSyncComplete(dbh, false)
  }

  const sessionCache = new Map<string, SessionInfo | null>()
  const getSess = (id: string): SessionInfo | null => {
    if (sessionCache.has(id)) return sessionCache.get(id)!
    const row = (stmt(SESSION_SQL).get(id) as SessionInfo | null) ?? null
    sessionCache.set(id, row)
    return row
  }

  let where = ""
  const params: any[] = []
  if (cursor) {
    where = "WHERE (p.time_updated > ? OR (p.time_updated = ? AND p.id > ?))"
    params.push(cursor.ts, cursor.ts, cursor.id)
  }

  const touched = new Set<string>()
  let budgetHit = false

  while (true) {
    if (opts.budgetMs && Date.now() - start > opts.budgetMs) { budgetHit = true; break }
    const rows = stmt(
      `SELECT p.id, p.session_id, p.message_id, p.time_updated, p.data, ` +
        `json_extract(m.data,'$.role') AS role ` +
        `FROM part p LEFT JOIN message m ON m.id = p.message_id ` +
        `${where} ORDER BY p.time_updated ASC, p.id ASC LIMIT ?`,
    ).all(...params, batchSize) as any[]
    if (rows.length === 0) { result.completed = true; break }

    const tx = dbh.transaction(() => {
      for (const r of rows) {
        if (opts.budgetMs && Date.now() - start > opts.budgetMs) { budgetHit = true; break }
        const s = getSess(r.session_id)
        const archived = s?.time_archived != null
        result.deleted += deletePart(w, r.id)
        // DEFECT 2: a build exception must NOT be silently swallowed while the
        // cursor advances past the part (permanent, uncounted content loss).
        // Record it for retry; the cursor still advances (the failed part is
        // tracked out-of-band, exactly like export.ts), and completeness is
        // withheld until it succeeds or is dead-lettered.
        let docs: ChannelDocument[]
        try {
          docs = buildChannelDocuments(r.id, r.session_id, r.message_id, r.data, archived, r.role ?? null, s?.directory)
          clearFtsFailure(failed, dead, r.id) // clean build supersedes any prior failure
        } catch (e) {
          noteFailure(r.id, e)
          docs = []
        }
        for (const d of docs) {
          if (!channelSet.has(d.channel)) { result.skipped++; continue }
          insertDoc(w, {
            part_id: r.id,
            session_id: r.session_id,
            message_id: r.message_id,
            channel: d.channel,
            role: r.role ?? null,
            ts: r.time_updated,
            body: excerptDocument(d.channel, d.content, r.id),
          }, substringSet)
          result.indexed++
        }
        touched.add(r.session_id)
        result.last_cursor = { ts: r.time_updated, id: r.id }
      }
      // DEFECT 3: commit this batch's document changes, the advanced cursor, and
      // the failure/dead-letter state as ONE atomic unit.
      persistState()
    })
    tx()

    if (opts.onProgress) {
      result.durationMs = Date.now() - start
      opts.onProgress({ ...result })
    }

    if (budgetHit) break
    const last = rows[rows.length - 1]
    where = "WHERE (p.time_updated > ? OR (p.time_updated = ? AND p.id > ?))"
    params.length = 0
    params.push(last.time_updated, last.time_updated, last.id)
    if (rows.length < batchSize) { result.completed = true; break }
  }

  // Rewrite each touched session's session-summary doc (mirrors runExport).
  // DEFECT 2: a summary build failure is tracked (keyed by session) rather than
  // silently dropped, so it too withholds completeness and is retried.
  if (wantSummary && touched.size) {
    const tx = dbh.transaction(() => {
      for (const sid of touched) {
        const s = getSess(sid)
        if (!s) continue
        result.deleted += deleteSummary(w, sid)
        let body: string
        try {
          body = buildSessionSummaryDocument(s)
          clearFtsFailure(failed, dead, summaryFailKey(sid))
        } catch (e) {
          noteFailure(summaryFailKey(sid), e)
          continue
        }
        insertDoc(w, {
          part_id: null,
          session_id: sid,
          message_id: null,
          channel: "session-summary",
          role: null,
          ts: s.time_updated,
          body,
        }, substringSet)
        result.indexed++
      }
      // DEFECT 3: summary doc changes commit atomically with any failure state
      // they recorded (a summary build can throw and be tracked via noteFailure).
      persistState()
    })
    tx()
  }

  // Retry previously-failed parts + tombstone reconciliation — only on unbudgeted
  // calls (full `fts-build` runs or scheduled maintenance), never on the small
  // per-search delta-sync. See the module doc comment. Each retry mutation is
  // itself atomic with its failure-state persist (persistState, DEFECT 3).
  if (!opts.budgetMs) {
    retryFailedFtsParts(dbh, w, failed, dead, channelSet, substringSet, getSess, result, persistState)
    const gc = dbh.transaction(() => reconcileFtsTombstones(dbh, w))()
    result.tombstones_removed_parts = gc.removedParts
    result.tombstones_removed_sessions = gc.removedSessions
  }

  // Final DRAIN-BASED completeness decision + durable persist, committed as one
  // transaction. Contract (drain-based, NOT budget-based):
  //   - ANY unresolved (retriable) hot failure -> NOT complete.
  //   - else if THIS run DRAINED the source (reached the end of `part`) -> complete,
  //     REGARDLESS of whether a budget was set: a budgeted run that genuinely
  //     drains the whole corpus IS fully built, which is exactly what lets a small
  //     per-search delta-sync confirm completeness.
  //   - else if the index was ALREADY complete -> stays complete (a non-draining
  //     delta-sync must never demote a fully-built index).
  //   - else -> not complete (a non-draining first build, or a post-reset partial).
  const finalize = dbh.transaction(() => {
    if (result.last_cursor) writeCursor(dbh, result.last_cursor)
    writeFailedMap(dbh, "failed_parts", failed)
    writeFailedMap(dbh, "dead_letters", dead)
    const hasFailures = Object.keys(failed).length > 0
    const nowComplete = hasFailures ? false : result.completed || wasComplete
    writeSyncComplete(dbh, nowComplete)
    result.complete = nowComplete
  })
  finalize()

  result.failed_outstanding = Object.keys(failed).length
  result.dead_letter_outstanding = Object.keys(dead).length
  result.durationMs = Date.now() - start
  return result
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export type FtsHit = {
  part_id: string | null
  session_id: string | null
  message_id: string | null
  channel: SearchChannel
  role: string | null
  ts: number | null
  snippet: string
  score: number
}

export type FtsQueryOptions = {
  query: string
  literal: boolean
  channels?: SearchChannel[]
  sessionIds?: string[]
  role?: "user" | "assistant" | "any"
  limit?: number
  caseSensitive?: boolean
  /** DEFECT 3: hard wall-clock bound (ms) for this query. Enforced for real via
   *  the bounded row-iterator on the degraded (trigram-unusable) literal scan —
   *  the only path that can degrade to a full content scan. See queryFts's doc
   *  comment for the exact mechanism and its documented limitation. When omitted,
   *  a degraded scan still falls back to DEGRADED_SCAN_DEFAULT_MS so no query can
   *  ever run truly unbounded. */
  timeoutMs?: number
  /** DEFECT 4: compute `total` eagerly. Default false — `total` is otherwise
   *  lazily computed on first access (and never at all for the hot search path,
   *  which reads only `hits`/`durationMs`), removing a discarded COUNT per
   *  literal search. */
  withTotal?: boolean
}

export type FtsQueryResult = {
  hits: FtsHit[]
  durationMs: number
  /** Bounded match count (see COUNT_CAP). DEFECT 4: lazily computed on first
   *  access unless `withTotal` was set; on the degraded bounded path it is the
   *  number of candidates actually collected (a lower bound), never a second
   *  unbounded scan. */
  total: number
  /** DEFECT 3: true when the query hit its time/row bound before scanning the
   *  whole candidate set, so `hits` are a best-effort partial (and unordered)
   *  window. Callers treating fts as authoritative MUST escalate (e.g. to
   *  ripgrep) on an interrupted result rather than trust it as complete. */
  interrupted: boolean
}

/**
 * Longest run of contiguous LITERAL (non-`%`/`_`-wildcard) characters in a
 * query, counted by Unicode code point (so an emoji or CJK glyph counts as one).
 * The `docs_sub` trigram index can only accelerate a `body LIKE` when some
 * literal segment is >= TRIGRAM_MIN code points; below that the operator
 * degrades to a full content scan. Pure + exported for unit tests and for the
 * queryFts defensive routing (DEFECT 3).
 */
export function maxLiteralRun(q: string): number {
  let max = 0
  let cur = 0
  for (const ch of q) {
    if (ch === "%" || ch === "_") { cur = 0; continue }
    cur++
    if (cur > max) max = cur
  }
  return max
}

/**
 * The literal/substring predicate to run against `docs_sub` (trigram), plus
 * the position expression used both to center the snippet and — when
 * `needsExactFilter` is true — as an exact post-filter (`p > 0`) that drops
 * false positives introduced by treating `%`/`_` as LIKE wildcards.
 */
export type LiteralPredicate = {
  /** Always a bare `body LIKE ?` — see the perf invariant below. */
  likeSql: string
  likeParam: string
  posExpr: string
  posParam: string
  /** True when the LIKE pattern above is a widened superset (query contains
   *  literal `%`/`_`, or case-sensitive mode) that needs an exact post-filter
   *  before it can be trusted as a correctness-preserving result set. */
  needsExactFilter: boolean
}

/**
 * Build the literal/substring predicate for `docs_sub`.
 *
 * CRITICAL PERFORMANCE INVARIANT: this must ALWAYS emit a bare `body LIKE ?`
 * with NO `ESCAPE` clause and NO `GLOB`. Both disable SQLite's trigram-index
 * optimization for the operator entirely, forcing a full content scan of
 * every document — measured 88x slower on the real 565k-doc / 5GB index
 * (7.5ms index-accelerated vs 665ms full scan for the identical rows).
 *
 * Correctness for a query containing `%`/`_`, and for `caseSensitive`
 * matching, is handled WITHOUT ever escaping the LIKE pattern: those
 * characters are left in the pattern where they act as ordinary LIKE
 * wildcards. That widens the match set to a SAFE SUPERSET (never a subset —
 * a wildcard can only match more, not less, than the literal character it
 * stands in for) that is still fully index-accelerated. An exact `instr()`
 * post-filter (case-sensitive for `caseSensitive`, case-insensitive
 * otherwise) then drops the resulting false positives, so the query as a
 * whole still returns exactly the correct rows — never a superset.
 */
export function buildLiteralPredicate(q: string, caseSensitive: boolean): LiteralPredicate {
  const likeSql = "body LIKE ?"
  const likeParam = `%${q}%`
  if (caseSensitive) {
    // Narrow with a case-insensitive LIKE — a safe superset, since every
    // case-exact occurrence is necessarily also a case-insensitive one —
    // then an exact case-sensitive instr() post-filter for correctness.
    return { likeSql, likeParam, posExpr: "instr(body, ?)", posParam: q, needsExactFilter: true }
  }
  const hasWildcard = q.includes("%") || q.includes("_")
  if (!hasWildcard) {
    // The overwhelmingly common case (including every identifier query):
    // the plain LIKE pattern is already exactly correct — no post-filter.
    return { likeSql, likeParam, posExpr: "instr(lower(body), lower(?))", posParam: q, needsExactFilter: false }
  }
  return { likeSql, likeParam, posExpr: "instr(lower(body), lower(?))", posParam: q, needsExactFilter: true }
}

/** Build a syntactically safe FTS5 MATCH query: split on whitespace, wrap each
 *  token in double quotes (doubling internal quotes) so inputs like `MP-4493`
 *  (a bare hyphen is otherwise parsed as a column filter / NOT and throws) are
 *  treated as literal phrases. */
function buildMatchQuery(q: string): string {
  const tokens = q.split(/\s+/).filter(Boolean)
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ")
}

/** Build the shared filter fragment + params for channels/sessions/role. */
function buildFilters(opts: FtsQueryOptions): { sql: string; params: any[] } {
  const clauses: string[] = []
  const params: any[] = []
  if (opts.channels && opts.channels.length) {
    clauses.push(`channel IN (${opts.channels.map(() => "?").join(",")})`)
    params.push(...opts.channels)
  }
  if (opts.sessionIds && opts.sessionIds.length) {
    clauses.push(`session_id IN (${opts.sessionIds.map(() => "?").join(",")})`)
    params.push(...opts.sessionIds)
  }
  if (opts.role && opts.role !== "any") {
    clauses.push(`role = ?`)
    params.push(opts.role)
  }
  return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", params }
}

/** Build a lazily-computed FtsQueryResult (DEFECT 4). `total` runs `computeTotal`
 *  only on first access unless `eager` (then it is forced once here). The getter
 *  is non-enumerable so a plain read of the result never triggers the count. */
function makeResult(
  hits: FtsHit[],
  start: number,
  interrupted: boolean,
  computeTotal: () => number,
  eager: boolean,
): FtsQueryResult {
  const result = { hits, durationMs: Date.now() - start, interrupted } as FtsQueryResult
  let memo: number | undefined
  Object.defineProperty(result, "total", {
    enumerable: false,
    configurable: true,
    get() {
      if (memo === undefined) memo = computeTotal()
      return memo
    },
  })
  if (eager) void result.total
  return result
}

/**
 * DEFECT 3 — bounded, degraded literal scan for a trigram-UNUSABLE query
 * (maxLiteralRun(q) < TRIGRAM_MIN, e.g. `th`, a 2-char CJK query, or an emoji).
 * Such a query cannot use the `docs_sub` trigram index, so `body LIKE '%q%'`
 * degrades to a full content scan of the whole (multi-GB) table.
 *
 * bun:sqlite 1.3.8 exposes NO in-process interrupt facility — no
 * `sqlite3_interrupt`, no progress handler, and no user-defined-function hook
 * (verified: the Database/Statement prototypes carry none of them). A synchronous
 * `.all()` therefore cannot be cancelled mid-flight, and a JS timer cannot fire
 * while the main thread is blocked inside SQLite. The TIGHTEST bound actually
 * available is to drive the scan through the statement ITERATOR (which DOES yield
 * incrementally) with an explicit `ORDER BY`-free query — dropping the ORDER BY
 * removes the `USE TEMP B-TREE FOR ORDER BY` that would otherwise force full
 * materialization before the first row — and to check a wall-clock deadline
 * between yielded rows, stopping early and marking the result `interrupted`.
 *
 * DOCUMENTED LIMITATION: the deadline is only observed between YIELDED rows, so a
 * trigram-unusable pattern that is ALSO extremely rare (long gaps between
 * matches) can still block inside a single `.next()` past the deadline. In
 * practice the pathological cases are short common tokens (dense matches), which
 * this bounds well (measured: `%th%` capped to ~50ms vs ~0.5-12s unbounded).
 * The primary defense remains the planner routing such queries to ripgrep; this
 * is the belt-and-suspenders layer so queryFts is never itself unbounded.
 */
function degradedLiteralScan(
  dbh: Database,
  pred: LiteralPredicate,
  filtersSql: string,
  filtersParams: any[],
  q: string,
  caseSensitive: boolean,
  limit: number,
  deadlineMs: number,
  start: number,
): { hits: FtsHit[]; interrupted: boolean; scanned: number } {
  const sql = `SELECT part_id, session_id, message_id, channel, role, ts, body FROM docs_sub WHERE ${pred.likeSql}${filtersSql}`
  const s = dbh.prepare(sql) // uncached: an early-broken iterator must be finalized cleanly
  const needle = caseSensitive ? q : q.toLowerCase()
  const collected: any[] = []
  let interrupted = false
  let scanned = 0
  try {
    for (const r of s.iterate(pred.likeParam, ...filtersParams) as any) {
      scanned++
      // Exact post-filter mirrors the fast path's `instr(...) > 0`: only needed
      // when the LIKE was widened (literal `%`/`_` or case-sensitive mode).
      if (pred.needsExactFilter) {
        const body = String(r.body ?? "")
        if (!(caseSensitive ? body : body.toLowerCase()).includes(needle)) continue
      }
      collected.push(r)
      if (collected.length >= DEGRADED_SCAN_ROW_CAP) { interrupted = true; break }
      if (Date.now() - start >= deadlineMs) { interrupted = true; break }
    }
  } finally {
    try { s.finalize() } catch { /* ignore */ }
  }
  // Best-effort ordering: sort the bounded window by ts DESC in JS (the SQL
  // ORDER BY was intentionally omitted so the deadline could be honored).
  collected.sort((a, b) => (Number(b.ts ?? 0)) - (Number(a.ts ?? 0)))
  const hits = collected.slice(0, limit).map((r) => ({
    part_id: r.part_id ?? null,
    session_id: r.session_id ?? null,
    message_id: r.message_id ?? null,
    channel: r.channel as SearchChannel,
    role: r.role ?? null,
    ts: r.ts ?? null,
    snippet: degradedSnippet(String(r.body ?? ""), needle, caseSensitive),
    score: 1,
  }))
  return { hits, interrupted, scanned: collected.length }
}

/** Center a snippet around the first (case-folded, matching the query mode)
 *  occurrence of the needle in the body, mirroring the SQL substr() window. */
function degradedSnippet(body: string, needleFolded: string, caseSensitive: boolean): string {
  const hay = caseSensitive ? body : body.toLowerCase()
  const p = hay.indexOf(needleFolded)
  const from = p > SNIPPET_RADIUS ? p - SNIPPET_RADIUS : 0
  return body.slice(from, from + SNIPPET_RADIUS * 2).slice(0, SNIPPET_HARD_CAP)
}

export function queryFts(opts: FtsQueryOptions): FtsQueryResult {
  const start = Date.now()
  const q = opts.query ?? ""
  const limit = Math.min(Math.max(1, opts.limit ?? LIMIT_DEFAULT), LIMIT_CAP)
  const eager = opts.withTotal === true
  if (!q.trim()) return { hits: [], durationMs: Date.now() - start, total: 0, interrupted: false }

  const dbh = openFts(ftsDbPath())
  const filters = buildFilters(opts)

  if (opts.literal) {
    const caseSensitive = opts.caseSensitive === true
    const pred = buildLiteralPredicate(q, caseSensitive)

    // DEFECT 3: a trigram-unusable query would be a full content scan. Route it
    // through the bounded, interruptible iterator instead of an uninterruptible
    // ORDER BY .all(). Its `total` is the number of candidates actually
    // collected (never a second unbounded scan).
    if (maxLiteralRun(q) < TRIGRAM_MIN) {
      const deadlineMs = opts.timeoutMs != null ? Math.max(0, opts.timeoutMs) : DEGRADED_SCAN_DEFAULT_MS
      const scan = degradedLiteralScan(
        dbh, pred, filters.sql, filters.params, q, caseSensitive, limit, deadlineMs, start,
      )
      return makeResult(scan.hits, start, scan.interrupted, () => scan.scanned, eager)
    }

    // Trigram-usable fast path. `.all()` is uninterruptible in this bun build, so
    // the only bound we can apply is a pre-flight guard (a caller passing a
    // non-positive timeout wants no work done); the trigram index keeps this
    // path fast in practice (~7.5ms measured for a rare identifier).
    if (opts.timeoutMs != null && opts.timeoutMs <= 0) {
      return makeResult([], start, true, () => 0, eager)
    }
    const snippetExpr =
      `substr(body, CASE WHEN p > ${SNIPPET_RADIUS} THEN p - ${SNIPPET_RADIUS} ELSE 1 END, ${SNIPPET_RADIUS * 2})`

    let sql: string
    let bindArgs: any[]
    if (!pred.needsExactFilter) {
      // Fast path — the exact shape measured at ~7.5ms on the real
      // 565k-doc index: plain `body LIKE ?`, no ESCAPE, trigram-accelerated.
      sql =
        `SELECT part_id, session_id, message_id, channel, role, ts, ${snippetExpr} AS snippet ` +
        `FROM (SELECT part_id, session_id, message_id, channel, role, ts, body, ${pred.posExpr} AS p ` +
        `FROM docs_sub WHERE ${pred.likeSql}${filters.sql} ORDER BY ts DESC LIMIT ?)`
      bindArgs = [pred.posParam, pred.likeParam, ...filters.params, limit]
    } else {
      // Wildcard/case-sensitive path: LIKE narrows via a safe (still
      // index-accelerated) superset; an exact instr() post-filter (`p > 0`)
      // drops the false positives BEFORE the LIMIT, so the result is exactly
      // correct — never a superset — while still returning up to `limit`
      // real matches when they exist.
      sql =
        `SELECT part_id, session_id, message_id, channel, role, ts, ${snippetExpr} AS snippet ` +
        `FROM (SELECT part_id, session_id, message_id, channel, role, ts, body, p ` +
        `FROM (SELECT part_id, session_id, message_id, channel, role, ts, body, ${pred.posExpr} AS p ` +
        `FROM docs_sub WHERE ${pred.likeSql}${filters.sql}) ` +
        `WHERE p > 0 ORDER BY ts DESC LIMIT ?)`
      bindArgs = [pred.posParam, pred.likeParam, ...filters.params, limit]
    }
    const rows = dbh.query(sql).all(...bindArgs) as any[]
    const hits: FtsHit[] = rows.map((r) => ({
      part_id: r.part_id ?? null,
      session_id: r.session_id ?? null,
      message_id: r.message_id ?? null,
      channel: r.channel as SearchChannel,
      role: r.role ?? null,
      ts: r.ts ?? null,
      snippet: String(r.snippet ?? "").slice(0, SNIPPET_HARD_CAP),
      score: 1,
    }))

    const computeTotal = (): number => {
      let countSql: string
      let countArgs: any[]
      if (!pred.needsExactFilter) {
        countSql = `SELECT COUNT(*) AS c FROM (SELECT 1 FROM docs_sub WHERE ${pred.likeSql}${filters.sql} LIMIT ${COUNT_CAP})`
        countArgs = [pred.likeParam, ...filters.params]
      } else {
        countSql =
          `SELECT COUNT(*) AS c FROM (SELECT 1 FROM ` +
          `(SELECT ${pred.posExpr} AS p FROM docs_sub WHERE ${pred.likeSql}${filters.sql}) ` +
          `WHERE p > 0 LIMIT ${COUNT_CAP})`
        countArgs = [pred.posParam, pred.likeParam, ...filters.params]
      }
      return Number((dbh.query(countSql).get(...countArgs) as { c: number }).c)
    }
    return makeResult(hits, start, false, computeTotal, eager)
  }

  const match = buildMatchQuery(q)
  if (!match) return { hits: [], durationMs: Date.now() - start, total: 0, interrupted: false }
  if (opts.timeoutMs != null && opts.timeoutMs <= 0) {
    return makeResult([], start, true, () => 0, eager)
  }
  const sql =
    `SELECT part_id, session_id, message_id, channel, role, ts, ` +
    `snippet(docs_lex, 6, '', '', '…', 32) AS snippet, bm25(docs_lex) AS rank ` +
    `FROM docs_lex WHERE docs_lex MATCH ?${filters.sql} ORDER BY rank ASC LIMIT ?`
  const rows = dbh.query(sql).all(match, ...filters.params, limit) as any[]
  const hits: FtsHit[] = rows.map((r) => ({
    part_id: r.part_id ?? null,
    session_id: r.session_id ?? null,
    message_id: r.message_id ?? null,
    channel: r.channel as SearchChannel,
    role: r.role ?? null,
    ts: r.ts ?? null,
    snippet: String(r.snippet ?? "").slice(0, SNIPPET_HARD_CAP),
    score: -Number(r.rank ?? 0),
  }))
  const computeTotal = (): number => {
    const countSql =
      `SELECT COUNT(*) AS c FROM (SELECT 1 FROM docs_lex WHERE docs_lex MATCH ?${filters.sql} LIMIT ${COUNT_CAP})`
    return Number((dbh.query(countSql).get(match, ...filters.params) as { c: number }).c)
  }
  return makeResult(hits, start, false, computeTotal, eager)
}

// ---------------------------------------------------------------------------
// Test-only insert path (mirrors production upsert semantics: delete-by-rowid,
// channel filtering, session-summary keyed by session). Not part of the public
// runtime surface.
// ---------------------------------------------------------------------------

export type _FtsTestDoc = {
  part_id: string | null
  session_id: string
  message_id: string | null
  channel: SearchChannel
  role: string | null
  ts: number
  body: string
}

export function _indexDocsForTest(
  docs: _FtsTestDoc[],
  root?: string,
): { indexed: number; skipped: number; deleted: number } {
  const dbh = openFts(ftsDbPath(root))
  const w = prepWrites(dbh)
  const channelSet = new Set<SearchChannel>(ftsChannels())
  const substringSet = new Set<SearchChannel>(ftsSubstringChannels())
  const res = { indexed: 0, skipped: 0, deleted: 0 }

  const byPart = new Map<string, _FtsTestDoc[]>()
  const summaries: _FtsTestDoc[] = []
  for (const d of docs) {
    if (d.part_id == null) summaries.push(d)
    else {
      const arr = byPart.get(d.part_id) ?? []
      arr.push(d)
      byPart.set(d.part_id, arr)
    }
  }

  const tx = dbh.transaction(() => {
    for (const [pid, ds] of byPart) {
      res.deleted += deletePart(w, pid)
      for (const d of ds) {
        if (!channelSet.has(d.channel)) { res.skipped++; continue }
        insertDoc(w, d, substringSet)
        res.indexed++
      }
    }
    for (const d of summaries) {
      if (!channelSet.has(d.channel)) { res.skipped++; continue }
      if (d.channel === "session-summary") res.deleted += deleteSummary(w, d.session_id)
      insertDoc(w, d, substringSet)
      res.indexed++
    }
  })
  tx()
  return res
}

// ---------------------------------------------------------------------------
// Test-only completeness / failed-part manipulation (deterministic, no timing
// dependency). Not part of the public runtime surface.
// ---------------------------------------------------------------------------

/** Force the persisted `sync_complete` flag (DEFECT 1) for a temp sidecar. */
export function _setCompleteForTest(complete: boolean, root?: string): void {
  writeSyncComplete(openFts(ftsDbPath(root)), complete)
}

/** Force the persisted indexed cursor (== indexed high-water) for a temp
 *  sidecar, so a lag scenario can pair a known cursor with a pinned source
 *  high-water (`_setSourceHighWaterForTest`). Not part of the runtime surface. */
export function _setCursorForTest(cursor: ExportCursor | null, root?: string): void {
  writeCursor(openFts(ftsDbPath(root)), cursor)
}

/** Delete the persisted `sync_complete` key entirely, simulating an index built
 *  before completeness tracking existed (exercises the legacy backfill path). */
export function _clearSyncCompleteFlagForTest(root?: string): void {
  openFts(ftsDbPath(root)).exec(`DELETE FROM fts_state WHERE key = 'sync_complete'`)
}

/** Record synthetic failed part ids (DEFECT 2) into the persisted hot-retry map,
 *  optionally pre-loading their attempt count so a single more failure
 *  dead-letters them. Returns nothing; inspect via `ftsStats()`. */
export function _recordFailedPartsForTest(ids: string[], attempts = 1, root?: string): void {
  const dbh = openFts(ftsDbPath(root))
  const failed = readFailedMap(dbh, "failed_parts")
  const now = Date.now()
  for (const id of ids) {
    failed[id] = { id, attempts, first_failed_at: now, last_failed_at: now, last_error: "synthetic test failure" }
  }
  writeFailedMap(dbh, "failed_parts", failed)
}

/** Read persisted failed/dead-letter counts for a temp sidecar. */
export function _readFailureStateForTest(root?: string): { failed: number; dead: number } {
  const dbh = openFts(ftsDbPath(root))
  return {
    failed: Object.keys(readFailedMap(dbh, "failed_parts")).length,
    dead: Object.keys(readFailedMap(dbh, "dead_letters")).length,
  }
}

/** Read the RAW persisted `sync_complete` flag (distinct from `ftsStats().complete`
 *  / `indexComplete`, which additionally masks the flag when hot failures exist).
 *  Lets a test assert that the flag ITSELF was durably invalidated (DEFECT 2/3),
 *  not merely masked. Not part of the runtime surface. */
export function _readSyncCompleteFlagForTest(root?: string): boolean {
  return readSyncComplete(openFts(ftsDbPath(root)))
}

/** Read the persisted indexed cursor for a temp sidecar, to assert cursor/failure
 *  consistency and that a --reset durably cleared it. Not part of the runtime surface. */
export function _readCursorForTest(root?: string): ExportCursor | null {
  return readCursor(openFts(ftsDbPath(root)))
}
