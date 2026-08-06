#!/usr/bin/env bun
/**
 * FTS sidecar build — full/resumable build of the SQLite FTS5 index that backs
 * fast literal + BM25 search (replaces the slow `ck` path).
 *
 * Reads documents from the OpenCode SQLite DB (read-only source of truth) and
 * writes the sidecar at <exportRoot()>/fts-index.sqlite (override via
 * $OPENCODE_SESSIONS_EXPLORER_FTS_DB). Idempotent + resumable: the cursor lives
 * inside the sidecar's fts_state table.
 *
 * Usage:
 *   opencode-sessions-explorer-fts-build                 # incremental (resume)
 *   opencode-sessions-explorer-fts-build --reset         # rebuild from cursor zero
 *   opencode-sessions-explorer-fts-build --budget-ms N   # stop after N ms
 */
import { syncFts, ftsDbPath, ftsChannels, ftsStats, type FtsSyncResult } from "../lib/fts.js"

const argv = process.argv.slice(2)
const reset = argv.includes("--reset")
const budgetIdx = argv.indexOf("--budget-ms")
const budgetMs = budgetIdx >= 0 ? Number(argv[budgetIdx + 1]) : undefined

const path = ftsDbPath()
console.log(`[fts-build] sidecar: ${path}`)
console.log(`[fts-build] channels: ${ftsChannels().join(", ")}`)
if (budgetMs != null && Number.isFinite(budgetMs)) console.log(`[fts-build] budget: ${budgetMs}ms`)
if (reset) console.log(`[fts-build] --reset: rebuilding from cursor zero`)

const start = Date.now()
let lastReport = start

const p: FtsSyncResult = await syncFts({
  fromCursor: reset ? null : undefined,
  budgetMs: budgetMs != null && Number.isFinite(budgetMs) ? budgetMs : undefined,
  batchSize: 2000,
  onProgress: (pg) => {
    const now = Date.now()
    if (now - lastReport >= 2000) {
      const elapsed = ((now - start) / 1000).toFixed(1)
      const rate = (pg.indexed / Math.max(1, (now - start) / 1000)).toFixed(0)
      console.log(
        `[fts-build] indexed=${pg.indexed} deleted=${pg.deleted} skipped=${pg.skipped} ` +
          `elapsed=${elapsed}s rate=${rate}/s cursor=${JSON.stringify(pg.last_cursor)}`,
      )
      lastReport = now
    }
  },
})

const elapsed = ((Date.now() - start) / 1000).toFixed(1)
const stats = ftsStats()
console.log(`[fts-build] DONE (this run ${p.completed ? "drained the source" : "stopped early on budget"})`)
console.log(`[fts-build]   indexed        = ${p.indexed}`)
console.log(`[fts-build]   deleted        = ${p.deleted}`)
console.log(`[fts-build]   skipped        = ${p.skipped}`)
console.log(`[fts-build]   failed         = ${p.failed} (retried ${p.retried}, dead-lettered ${p.dead_lettered})`)
console.log(`[fts-build]   outstanding    = ${p.failed_outstanding} failed, ${p.dead_letter_outstanding} dead-lettered`)
console.log(`[fts-build]   tombstones     = ${p.tombstones_removed_parts} parts, ${p.tombstones_removed_sessions} summaries` + (budgetMs != null ? " (skipped — budgeted run)" : ""))
console.log(`[fts-build]   last_cursor    = ${JSON.stringify(p.last_cursor)}`)
console.log(`[fts-build]   elapsed        = ${elapsed}s`)
console.log(`[fts-build]   index docs     = ${stats.docs}`)
console.log(`[fts-build]   index bytes    = ${stats.bytes}`)

// DEFECT 1: state completeness unambiguously. The persisted `complete` flag is
// what `ftsUsable()` / search-text gate the fast tier on — NOT merely that the
// tables exist, and NOT how fresh the index is. "Complete" ("has a full pass
// drained the whole corpus at least once, with no unresolved failures?") is a
// DURABLE property, distinct from "freshness"/lag (how far the index trails the
// live source right now). Only completeness gates the fast tier; lag never does.
console.log(`[fts-build]   COMPLETE       = ${p.complete}  (durable "fully built at least once" flag — this gates the fast tier)`)
const lagStr = stats.lagMs == null
  ? "unknown"
  : stats.atSource
    ? "caught up"
    : `${(stats.lagMs / 60000).toFixed(1)} min behind`
console.log(
  `[fts-build]   freshness      = indexed ${JSON.stringify(stats.indexedHighWater)} ` +
    `vs source ${JSON.stringify(stats.sourceHighWater)} — ${lagStr}`,
)
console.log(`[fts-build]                  (informational only; lag NEVER disables the fast tier — OpenCode writes continuously, so being a few minutes behind is normal and the per-search delta-sync narrows it)`)
if (!p.complete) {
  const why = p.failed_outstanding > 0
    ? `${p.failed_outstanding} part(s) still fail to build`
    : "this build stopped before draining the whole source corpus at least once"
  console.log("")
  console.log(`[fts-build] ⚠  INDEX IS NOT YET AUTHORITATIVE — ${why}.`)
  console.log(`[fts-build] ⚠  Literal/lex search will NOT use this index as authoritative`)
  console.log(`[fts-build] ⚠  (it would silently truncate results); it falls back to ripgrep`)
  console.log(`[fts-build] ⚠  until a FULL (unbudgeted) build drains the source once. Re-run`)
  console.log(`[fts-build] ⚠  WITHOUT --budget-ms:`)
  console.log(`[fts-build] ⚠      opencode-sessions-explorer-fts-build`)
} else {
  console.log(`[fts-build] ✓  Index is COMPLETE — fast literal/lex search is authoritative`)
  console.log(`[fts-build] ✓  (even while it lags the live source; that lag is expected and`)
  console.log(`[fts-build] ✓  never disables the fast tier). A plain run like this one sets the`)
  console.log(`[fts-build] ✓  durable flag — so an older index built before completeness tracking`)
  console.log(`[fts-build] ✓  existed is promoted to authoritative by exactly this command.`)
}
