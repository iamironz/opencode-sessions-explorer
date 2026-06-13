#!/usr/bin/env bun
/**
 * Bulk-export script — one-time (or resume-friendly) run that walks every
 * searchable part in the OpenCode DB and writes it to the filesystem export
 * tree (default ~/.local/share/opencode-sessions-explorer/, overridable via
 * $OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT).
 *
 * Idempotent: reads .last_sync to resume; advances cursor as it goes.
 *
 * Usage:
 *   opencode-sessions-explorer-bulk-export           # incremental
 *   opencode-sessions-explorer-bulk-export --reset   # start from beginning
 *   opencode-sessions-explorer-bulk-export --root /custom/path
 */
import { runExport, exportRoot, ensureRoot, markChannelExportComplete } from "../lib/export.js"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

const argv = process.argv.slice(2)
const reset = argv.includes("--reset")
const rootIdx = argv.indexOf("--root")
const root = rootIdx >= 0 ? argv[rootIdx + 1] : exportRoot()

console.log(`[bulk-export] root: ${root}`)
ensureRoot(root)

if (reset) {
  const lastSync = join(root, ".last_sync")
  if (existsSync(lastSync)) rmSync(lastSync)
  const channelRoot = join(root, "by-channel")
  if (existsSync(channelRoot)) rmSync(channelRoot, { recursive: true, force: true })
  const marker = join(root, ".channels_v1_complete")
  if (existsSync(marker)) rmSync(marker)
  console.log(`[bulk-export] --reset: removed .last_sync + by-channel/, starting from scratch`)
}

const start = Date.now()
let lastReport = start

const p = await runExport({
  root,
  batchSize: 2000,
  onProgress: (pg) => {
    const now = Date.now()
    if (now - lastReport >= 2000) {
      const elapsed = ((now - start) / 1000).toFixed(1)
      const rate = (pg.exported / Math.max(1, (now - start) / 1000)).toFixed(0)
      console.log(`[bulk-export] exported=${pg.exported} skipped_nontext=${pg.skipped_nontext} skipped_oversize=${pg.skipped_oversize} failed=${pg.failed} elapsed=${elapsed}s rate=${rate}/s`)
      lastReport = now
    }
  },
})

const elapsed = ((Date.now() - start) / 1000).toFixed(1)
if (reset && p.failed === 0) markChannelExportComplete(root)
console.log(`[bulk-export] DONE`)
console.log(`[bulk-export]   exported          = ${p.exported}`)
console.log(`[bulk-export]   skipped (non-text) = ${p.skipped_nontext}`)
console.log(`[bulk-export]   skipped (oversize) = ${p.skipped_oversize}`)
console.log(`[bulk-export]   failed             = ${p.failed}`)
console.log(`[bulk-export]   last_cursor       = ${JSON.stringify(p.last_cursor)}`)
console.log(`[bulk-export]   elapsed           = ${elapsed}s`)
