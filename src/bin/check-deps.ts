#!/usr/bin/env bun
/**
 * check-deps — diagnostic CLI for `opencode-sessions-explorer` plugin install health.
 *
 * Probes:
 *   - OpenCode SQLite DB reachable
 *   - json1 extension available
 *   - busy_timeout honoured
 *   - schema head + drift
 *   - Sessions-export tree present + size
 *   - ck binary present + version + index status
 *   - Disk space
 *
 * Exit codes:
 *   0 — all green
 *   1 — soft warning (plugin works, but some optional pieces missing)
 *   2 — hard fail (plugin won't work)
 *
 * Usage:
 *   opencode-sessions-explorer-check-deps
 *   opencode-sessions-explorer-check-deps --json   # machine-readable
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { locateDb } from "../lib/db.js"
import { getSchemaState } from "../lib/schema.js"
import { channelExportComplete, exportRoot } from "../lib/export.js"
import { locateCk, ckIndexPresent } from "../lib/ck.js"

const json = process.argv.includes("--json")
type Status = "ok" | "warn" | "fail"
type Check = { name: string; status: Status; detail: string; fix?: string }
const checks: Check[] = []

function pass(name: string, detail: string) { checks.push({ name, status: "ok", detail }) }
function warn(name: string, detail: string, fix?: string) { checks.push({ name, status: "warn", detail, fix }) }
function fail(name: string, detail: string, fix?: string) { checks.push({ name, status: "fail", detail, fix }) }

// 1. DB reachable
let dbPath: string | null = null
try {
  dbPath = locateDb()
  pass("OpenCode DB", `${dbPath} (${(statSync(dbPath).size / 1024 / 1024).toFixed(1)} MB)`)
} catch (e) {
  fail("OpenCode DB", (e as Error).message, "Set $OPENCODE_SESSIONS_EXPLORER_DB to the absolute path of opencode.db, or install OpenCode and run it at least once.")
}

// 2. Schema state (only if DB reachable)
if (dbPath) {
  try {
    const s = getSchemaState()
    if (s.hard_drift.length > 0) {
      fail("Schema", `hard drift: ${s.hard_drift.join("; ")}`, "Upgrade @opencode-ai/plugin or downgrade your OpenCode install to a compatible schema version.")
    } else if (s.drift_warnings.length > 0) {
      warn("Schema", `migration ${s.migrations_head} (soft warnings: ${s.drift_warnings.join("; ")})`)
    } else {
      pass("Schema", `migration ${s.migrations_head}; session=${s.table_counts.session} message=${s.table_counts.message} part=${s.table_counts.part}`)
    }
    if (s.json1_ok) pass("SQLite json1", "available")
    else fail("SQLite json1", "extension missing", "bun:sqlite ships json1 by default; this should never happen.")
    if (s.busy_timeout_ms >= 5000) pass("busy_timeout", `${s.busy_timeout_ms} ms`)
    else warn("busy_timeout", `${s.busy_timeout_ms} ms (<5000)`, "Concurrent OpenCode writers may cause SQLITE_BUSY errors.")
  } catch (e) {
    fail("Schema", `probe failed: ${(e as Error).message}`)
  }
}

// 3. Export tree
const root = exportRoot()
if (existsSync(root)) {
  const bySession = join(root, "by-session")
  if (existsSync(bySession)) {
    const sessionDirs = readdirSync(bySession).filter((f) => f.startsWith("ses_")).length
    pass("Export tree", `${root} (${sessionDirs} session dirs)`)
    const byChannel = join(root, "by-channel")
    if (existsSync(byChannel)) {
      const channels = readdirSync(byChannel).filter((f) => !f.startsWith(".")).length
      if (channelExportComplete(root)) pass("Channel views", `${channels} channel dirs (complete)`)
      else warn("Channel views", `${channels} channel dirs (partial)`, "Run `opencode-sessions-explorer-bulk-export --reset` once to backfill all curated recall channels.")
    } else {
      warn("Channel views", "not built", "Run `opencode-sessions-explorer-bulk-export --reset` once to backfill curated recall channels.")
    }
  } else {
    warn("Export tree", `${root} exists but no by-session/ yet`, "Run `opencode-sessions-explorer-bulk-export` to populate.")
  }
} else {
  warn("Export tree", `${root} not yet built`, "Run `opencode-sessions-explorer-bulk-export` to populate. Text search will return empty until then.")
}

// 4. ck binary
try {
  const ckBin = locateCk()
  const r = spawnSync(ckBin, ["--version"], { encoding: "utf8" })
  if (r.status === 0) {
    const ver = (r.stdout ?? "").trim()
    pass("ck CLI", `${ckBin} (${ver})`)
    // ck index status
    if (existsSync(root)) {
      const idx = ckIndexPresent(root)
      if (idx.present) pass("ck index", idx.embedded_chunks != null ? `present (${idx.embedded_chunks} embedded chunks)` : "present")
      else warn("ck index", "not built", "Semantic search will ask ck to lazily build the index; optionally prewarm with `cd " + root + " && ck --index .`.")
    }
  } else {
    warn("ck CLI", `${ckBin} returned ${r.status}: ${(r.stderr ?? "").slice(0, 120)}`, "Reinstall via `cargo install ck-search`.")
  }
} catch {
  warn("ck CLI", "not found in $PATH or common locations", "Install with `cargo install ck-search` for search-text + grep-session tools. Other 16 tools work without ck.")
}

// 5. tool-output dir (for get-part dereference)
const toolOutputDir = (() => {
  if (process.env.OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR) return process.env.OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR
  const home = process.env.HOME ?? ""
  return join(home, ".local/share/opencode/tool-output")
})()
if (existsSync(toolOutputDir)) pass("tool-output dir", toolOutputDir)
else warn("tool-output dir", `${toolOutputDir} not yet created`, "Will be auto-created by OpenCode when needed.")

// Print
const okCount = checks.filter((c) => c.status === "ok").length
const warnCount = checks.filter((c) => c.status === "warn").length
const failCount = checks.filter((c) => c.status === "fail").length

if (json) {
  console.log(JSON.stringify({ checks, summary: { ok: okCount, warn: warnCount, fail: failCount } }, null, 2))
} else {
  for (const c of checks) {
    const sym = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"
    console.log(`${sym} ${c.name.padEnd(20)} ${c.detail}`)
    if (c.fix) console.log(`   → ${c.fix}`)
  }
  console.log("")
  console.log(`${okCount} OK · ${warnCount} warn · ${failCount} fail`)
}

process.exit(failCount > 0 ? 2 : (warnCount > 0 ? 1 : 0))
