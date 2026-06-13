#!/usr/bin/env bun
/**
 * dedupe-export — one-shot maintenance script. Removes duplicate part files
 * (same part_id, different seq prefix) caused by an early bug in the
 * cursor-schema migration. Keeps the LOWEST-seq file per part_id and
 * deletes the others.
 *
 * Usage:
 *   opencode-sessions-explorer-dedupe-export         # dry run
 *   opencode-sessions-explorer-dedupe-export --apply # actually delete
 */
import { readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { exportRoot } from "../lib/export.js"

const argv = process.argv.slice(2)
const apply = argv.includes("--apply")
const root = join(exportRoot(), "by-session")

console.log(`[dedupe-export] root: ${root}`)
console.log(`[dedupe-export] mode: ${apply ? "APPLY (will delete)" : "DRY-RUN (just report)"}`)

const sessions = readdirSync(root).filter((f) => f.startsWith("ses_"))
console.log(`[dedupe-export] scanning ${sessions.length} session dirs...`)

let totalDups = 0
let totalBytesFreed = 0
let dirsAffected = 0

for (const ses of sessions) {
  const dir = join(root, ses)
  let files: string[]
  try { files = readdirSync(dir) } catch { continue }
  // Group by part_id; track all seq variants
  const byPartId = new Map<string, { seq: number; filename: string }[]>()
  for (const f of files) {
    const m = /^(\d{5})-(prt_[A-Za-z0-9_-]+)\.txt$/.exec(f)
    if (!m) continue
    const seq = Number(m[1])
    const partId = m[2]
    if (!byPartId.has(partId)) byPartId.set(partId, [])
    byPartId.get(partId)!.push({ seq, filename: f })
  }

  let dirDups = 0
  for (const [partId, variants] of byPartId) {
    if (variants.length <= 1) continue
    // Sort by seq ascending → keep first, delete the rest
    variants.sort((a, b) => a.seq - b.seq)
    const keep = variants[0]!
    const deletables = variants.slice(1)
    for (const d of deletables) {
      const path = join(dir, d.filename)
      const sz = statSync(path).size
      totalBytesFreed += sz
      totalDups++
      dirDups++
      if (apply) {
        try { unlinkSync(path) } catch (e) { console.error(`  failed to delete ${path}: ${(e as Error).message}`) }
      }
    }
  }
  if (dirDups > 0) dirsAffected++
}

console.log(`[dedupe-export] DONE`)
console.log(`[dedupe-export]   duplicate files ${apply ? "deleted" : "to delete"}: ${totalDups}`)
console.log(`[dedupe-export]   sessions affected:                     ${dirsAffected}`)
console.log(`[dedupe-export]   disk ${apply ? "freed" : "to free"}: ${(totalBytesFreed / 1024 / 1024).toFixed(1)} MB`)
if (!apply) console.log(`[dedupe-export]   re-run with --apply to actually delete.`)
