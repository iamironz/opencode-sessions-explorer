/**
 * Tests for the SQLite FTS5 sidecar (src/lib/fts.ts).
 *
 * Hermetic: uses a TEMP sidecar DB via $OPENCODE_SESSIONS_EXPLORER_FTS_DB inside
 * an mkdtemp dir, so the user's real index is never touched. Documents are
 * inserted directly through the module's own upsert path (_indexDocsForTest)
 * rather than syncing the real 510k-part source DB. The one optional syncFts
 * smoke test is hard-bounded by budgetMs and tolerates a missing source DB.
 */
import { test, describe, expect, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FTS_CHANNELS,
  FTS_EXCERPT_POLICY,
  FTS_CASE_FOLDING_ASCII_ONLY,
  ftsDbPath,
  ftsPresent,
  ftsUsable,
  ftsChannels,
  ftsCovers,
  ftsSubstringChannels,
  ftsStats,
  queryFts,
  syncFts,
  excerptDocument,
  buildLiteralPredicate,
  maxLiteralRun,
  _indexDocsForTest,
  _closeFtsForTest,
  _setCompleteForTest,
  _setCursorForTest,
  _clearSyncCompleteFlagForTest,
  _recordFailedPartsForTest,
  _readFailureStateForTest,
  _readSyncCompleteFlagForTest,
  _readCursorForTest,
  _resetSourceHighWaterCacheForTest,
  _setSourceHighWaterForTest,
  type _FtsTestDoc,
} from "../src/lib/fts.ts"

let dir: string
let counter = 0

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ose-fts-"))
})

afterAll(() => {
  _closeFtsForTest()
  delete process.env.OPENCODE_SESSIONS_EXPLORER_FTS_DB
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** Point the module at a brand-new empty sidecar file and reset the handle. */
function freshDb(): string {
  _closeFtsForTest()
  const p = join(dir, `idx-${counter++}.sqlite`)
  process.env.OPENCODE_SESSIONS_EXPLORER_FTS_DB = p
  return p
}

function doc(over: Partial<_FtsTestDoc> = {}): _FtsTestDoc {
  return {
    part_id: "prt_1",
    session_id: "ses_1",
    message_id: "msg_1",
    channel: "conversation",
    role: "user",
    ts: 1000,
    body: "hello world",
    ...over,
  }
}

describe("fts: schema + presence", () => {
  test("ftsPresent is false before any build, true after, and schema build is idempotent", () => {
    const p = freshDb()
    expect(ftsPresent()).toBe(false)

    _indexDocsForTest([doc({ part_id: "prt_a", body: "alpha content" })])
    expect(ftsPresent()).toBe(true)
    expect(ftsDbPath()).toBe(p)

    // Re-open + re-build schema (ensureSchema runs again) — must not throw or wipe.
    _closeFtsForTest()
    _indexDocsForTest([doc({ part_id: "prt_b", body: "beta content" })])
    const s = ftsStats()
    expect(s.present).toBe(true)
    expect(s.docs).toBeGreaterThanOrEqual(2)
    expect(s.channels).toEqual(FTS_CHANNELS)
  })

  test("ftsPresent returns false (no throw) on a corrupt sidecar file, and records a diagnosable lastError", () => {
    const p = freshDb()
    writeFileSync(p, "this is not a sqlite database")
    expect(ftsPresent()).toBe(false)
    expect(ftsStats().lastError).toBeTruthy()
  })
})

describe("fts: regression — read-write open survives a checkpoint-truncated WAL", () => {
  /**
   * Regression for the live-benchmarking bug: `ftsPresent()` used to open the
   * sidecar with `readonly: true`. bun:sqlite's readonly connections cannot
   * create the `-shm` shared-memory file a WAL-mode db needs, so as soon as
   * `-wal`/`-shm` are absent (e.g. right after `PRAGMA wal_checkpoint(TRUNCATE)`,
   * which is exactly what happened during the real 5GB-index benchmark run),
   * the readonly open throws SQLITE_CANTOPEN — swallowed silently — and
   * `ftsPresent()` returned `false` even though the index was fully present
   * and fine, disabling the entire FTS fast path in favor of ripgrep.
   *
   * This test reproduces that exact on-disk state (valid index built via a
   * `dbh.transaction()`-based writer — same as production `syncFts` — then
   * `-wal`/`-shm` physically absent because of a truncating checkpoint) and
   * verifies from a genuinely FRESH bun process (matching how this really
   * happens: a new OpenCode process/tool invocation opening a pre-built,
   * already-checkpointed index it never previously held a handle to) that
   * `ftsPresent()` and `queryFts()` both still work.
   *
   * Deliberately uses a subprocess for the verification step rather than
   * checking in-process: a single bun process that both wrote via
   * `dbh.transaction()` *and* later reopens the same path after an external
   * checkpoint+delete can hit an unrelated same-process SQLite/macOS
   * zombie-connection artifact (stale vnode lock state) that a genuinely
   * separate process does not — and a genuinely separate process is exactly
   * what happens for real, since nothing in production ever closes and
   * reopens the cached `_fts` handle mid-process.
   */
  test("ftsPresent() and queryFts() still work after -wal/-shm are removed via wal_checkpoint(TRUNCATE), from a fresh process", () => {
    const p = freshDb()
    _indexDocsForTest([doc({ part_id: "prt_wal", body: "wal_checkpoint_marker_123" })])
    expect(ftsPresent()).toBe(true)
    _closeFtsForTest() // release our handle so the external checkpoint below is the sole writer

    // Checkpoint-truncate + physically remove -wal/-shm from a genuinely
    // separate process — mirrors a maintenance script / the sqlite3 CLI
    // truncating the WAL, exactly what triggered the real bug.
    const ckptScript = [
      `import { Database } from "bun:sqlite"`,
      `import { rmSync } from "node:fs"`,
      `const raw = new Database(${JSON.stringify(p)}, { readwrite: true })`,
      `raw.exec("PRAGMA wal_checkpoint(TRUNCATE);")`,
      `raw.close()`,
      `try { rmSync(${JSON.stringify(p)} + "-wal") } catch {}`,
      `try { rmSync(${JSON.stringify(p)} + "-shm") } catch {}`,
    ].join("\n")
    const ckpt = Bun.spawnSync(["bun", "-e", ckptScript])
    if (ckpt.exitCode !== 0) throw new Error(`checkpoint subprocess failed: ${ckpt.stderr.toString()}`)
    expect(existsSync(p + "-wal")).toBe(false)
    expect(existsSync(p + "-shm")).toBe(false)

    // Verify from a FRESH process — this is the exact assertion that would
    // have caught the original bug: a readonly-based ftsPresent() throws
    // SQLITE_CANTOPEN here and (with the swallowed catch) incorrectly
    // reports the index as absent.
    const ftsModulePath = new URL("../src/lib/fts.ts", import.meta.url).pathname
    const checkScript = [
      `import { ftsPresent, ftsStats, queryFts } from ${JSON.stringify(ftsModulePath)}`,
      `console.log(JSON.stringify({`,
      `  present: ftsPresent(),`,
      `  lastError: ftsStats().lastError,`,
      `  litHits: queryFts({ query: "wal_checkpoint_marker_123", literal: true }).hits.length,`,
      `  lexHits: queryFts({ query: "wal_checkpoint_marker_123", literal: false }).hits.length,`,
      `}))`,
    ].join("\n")
    const check = Bun.spawnSync(["bun", "-e", checkScript], {
      env: { ...process.env, OPENCODE_SESSIONS_EXPLORER_FTS_DB: p },
    })
    if (check.exitCode !== 0) throw new Error(`check subprocess failed: ${check.stderr.toString()}`)
    const out = JSON.parse(check.stdout.toString().trim())

    expect(out.present).toBe(true)
    expect(out.lastError).toBeNull()
    expect(out.litHits).toBe(1)
    expect(out.lexHits).toBe(1)
  })
})

describe("fts: literal / substring queries (docs_sub, trigram)", () => {
  test("finds an identifier and is case-insensitive", () => {
    freshDb()
    _indexDocsForTest([doc({ part_id: "prt_x", body: "resolved ticket MP-4493 in prod" })])

    const upper = queryFts({ query: "MP-4493", literal: true })
    expect(upper.hits.length).toBe(1)
    expect(upper.hits[0].part_id).toBe("prt_x")
    expect(upper.hits[0].snippet).toContain("MP-4493")

    const lower = queryFts({ query: "mp-4493", literal: true })
    expect(lower.hits.length).toBe(1)
    expect(lower.hits[0].part_id).toBe("prt_x")
  })

  test("caseSensitive:true only matches exact case (index-accelerated LIKE narrow + exact instr() post-filter, never GLOB)", () => {
    freshDb()
    _indexDocsForTest([doc({ part_id: "prt_cs", body: "Token MixedCaseWord here" })])
    expect(queryFts({ query: "MixedCaseWord", literal: true, caseSensitive: true }).hits.length).toBe(1)
    expect(queryFts({ query: "mixedcaseword", literal: true, caseSensitive: true }).hits.length).toBe(0)
  })

  test("caseSensitive:true combined with a literal '%' still returns exact matches only (no superset)", () => {
    freshDb()
    _indexDocsForTest([
      doc({ part_id: "prt_csp1", body: "Discount: 50% Off" }),
      doc({ part_id: "prt_csp2", body: "discount: 50% off" }), // same text, wrong case
      doc({ part_id: "prt_csp3", body: "50XYZ Off should not match" }), // % wildcard trap
    ])
    const r = queryFts({ query: "50% Off", literal: true, caseSensitive: true })
    expect(r.hits.length).toBe(1)
    expect(r.hits[0].part_id).toBe("prt_csp1")
  })

  test("a query containing a literal '%' is NEVER treated via ESCAPE — the LIKE pattern is widened to a safe superset and an exact instr() post-filter removes false positives", () => {
    freshDb()
    _indexDocsForTest([
      doc({ part_id: "prt_pct1", body: "literal 50% off deal" }),
      // % as LIKE wildcard would match "50" + anything + " off" — this doc is
      // the superset trap that must be filtered back out.
      doc({ part_id: "prt_pct2", body: "50XYZ off should not match a percent query" }),
    ])
    const r = queryFts({ query: "50% off", literal: true })
    expect(r.hits.length).toBe(1)
    expect(r.hits[0].part_id).toBe("prt_pct1")
    expect(r.total).toBe(1) // the bounded COUNT must also be exact, not the widened superset count
  })

  test("a query containing a literal '_' is NEVER treated via ESCAPE — the LIKE pattern is widened to a safe superset and an exact instr() post-filter removes false positives", () => {
    freshDb()
    _indexDocsForTest([
      doc({ part_id: "prt_us1", body: "config key foo_bar_baz set" }),
      // _ as a LIKE wildcard (matches any single char) would match
      // "foo" + any-char + "bar_baz" — this doc is the superset trap.
      doc({ part_id: "prt_us2", body: "config key fooXbar_baz should not match" }),
    ])
    const r = queryFts({ query: "foo_bar_baz", literal: true })
    expect(r.hits.length).toBe(1)
    expect(r.hits[0].part_id).toBe("prt_us1")
    expect(r.total).toBe(1)
  })

  test("buildLiteralPredicate never emits an ESCAPE clause or GLOB, for any input shape", () => {
    const cases: Array<[string, boolean]> = [
      ["MP-4493", false],
      ["MP-4493", true],
      ["50%", false],
      ["50%", true],
      ["foo_bar", false],
      ["foo_bar", true],
      ["", false],
      ["100% done_deal", true],
    ]
    for (const [q, caseSensitive] of cases) {
      const pred = buildLiteralPredicate(q, caseSensitive)
      expect(pred.likeSql).toBe("body LIKE ?")
      expect(pred.likeSql.toUpperCase()).not.toContain("ESCAPE")
      expect(pred.likeSql.toUpperCase()).not.toContain("GLOB")
      expect(pred.likeParam).toBe(`%${q}%`)
    }
  })

  test("buildLiteralPredicate.needsExactFilter is set exactly when correctness requires a post-filter", () => {
    expect(buildLiteralPredicate("MP-4493", false).needsExactFilter).toBe(false) // fast path
    expect(buildLiteralPredicate("50%", false).needsExactFilter).toBe(true)
    expect(buildLiteralPredicate("foo_bar", false).needsExactFilter).toBe(true)
    expect(buildLiteralPredicate("MP-4493", true).needsExactFilter).toBe(true) // caseSensitive always needs it
    expect(buildLiteralPredicate("50%", true).needsExactFilter).toBe(true)
  })
})

describe("fts: BM25 / lex queries (docs_lex, unicode61)", () => {
  test("an FTS5-unsafe query like MP-4493 does not throw and matches", () => {
    freshDb()
    _indexDocsForTest([doc({ part_id: "prt_lex", body: "see MP-4493 for details" })])
    let res
    expect(() => { res = queryFts({ query: "MP-4493", literal: false }) }).not.toThrow()
    expect(res!.hits.length).toBeGreaterThanOrEqual(1)
    // score is negated bm25 => finite number, higher is better
    expect(Number.isFinite(res!.hits[0].score)).toBe(true)
  })

  test("multi-token unsafe query with quotes does not throw", () => {
    freshDb()
    _indexDocsForTest([doc({ part_id: "prt_q", body: `he said "MP-4493" and NOT done` })])
    expect(() => queryFts({ query: `"MP-4493" NOT done`, literal: false })).not.toThrow()
  })
})

describe("fts: idempotent re-index", () => {
  test("re-indexing the same part_id does not duplicate rows", () => {
    freshDb()
    _indexDocsForTest([doc({ part_id: "prt_dup", body: "original_marker_aaa" })])
    expect(queryFts({ query: "original_marker_aaa", literal: true }).hits.length).toBe(1)

    // Same part, updated body (e.g. tool pending -> completed).
    _indexDocsForTest([doc({ part_id: "prt_dup", body: "updated_marker_bbb" })])
    expect(queryFts({ query: "original_marker_aaa", literal: true }).hits.length).toBe(0)
    const upd = queryFts({ query: "updated_marker_bbb", literal: true })
    expect(upd.hits.length).toBe(1)
    expect(ftsStats().docs).toBe(1)
  })

  test("re-indexing a session-summary keyed by session_id does not duplicate", () => {
    freshDb()
    _indexDocsForTest([
      { part_id: null, session_id: "ses_sum", message_id: null, channel: "session-summary", role: null, ts: 5, body: "summary_one_ccc" },
    ])
    _indexDocsForTest([
      { part_id: null, session_id: "ses_sum", message_id: null, channel: "session-summary", role: null, ts: 6, body: "summary_two_ddd" },
    ])
    expect(queryFts({ query: "summary_one_ccc", literal: true }).hits.length).toBe(0)
    expect(queryFts({ query: "summary_two_ddd", literal: true }).hits.length).toBe(1)
    expect(ftsStats().docs).toBe(1)
  })
})

describe("fts: filters", () => {
  function seed() {
    freshDb()
    _indexDocsForTest([
      doc({ part_id: "p1", session_id: "sesA", role: "user", channel: "conversation", body: "shared_term filter one" }),
      doc({ part_id: "p2", session_id: "sesA", role: "assistant", channel: "conversation", body: "shared_term filter two" }),
      doc({ part_id: "p3", session_id: "sesB", role: "user", channel: "tool-error", body: "shared_term filter three" }),
    ])
  }

  test("channel filter", () => {
    seed()
    const r = queryFts({ query: "shared_term", literal: true, channels: ["tool-error"] })
    expect(r.hits.length).toBe(1)
    expect(r.hits[0].part_id).toBe("p3")
  })

  test("session filter", () => {
    seed()
    const r = queryFts({ query: "shared_term", literal: true, sessionIds: ["sesA"] })
    expect(r.hits.map((h) => h.part_id).sort()).toEqual(["p1", "p2"])
  })

  test("role filter (user vs assistant vs any)", () => {
    seed()
    expect(queryFts({ query: "shared_term", literal: true, role: "user" }).hits.map((h) => h.part_id).sort()).toEqual(["p1", "p3"])
    expect(queryFts({ query: "shared_term", literal: true, role: "assistant" }).hits.map((h) => h.part_id)).toEqual(["p2"])
    expect(queryFts({ query: "shared_term", literal: true, role: "any" }).hits.length).toBe(3)
    expect(queryFts({ query: "shared_term", literal: true }).hits.length).toBe(3)
  })

  test("filters apply on the BM25 path too", () => {
    seed()
    const r = queryFts({ query: "shared_term", literal: false, channels: ["conversation"], role: "assistant" })
    expect(r.hits.length).toBe(1)
    expect(r.hits[0].part_id).toBe("p2")
  })
})

describe("fts: channel-set gating", () => {
  test("the new default FTS_CHANNELS includes tool-output and excludes raw", () => {
    expect(FTS_CHANNELS).toContain("tool-output")
    expect(FTS_CHANNELS).not.toContain("raw")
    // every derived channel except raw
    expect(new Set(FTS_CHANNELS)).toEqual(
      new Set(["conversation", "session-summary", "tool-error", "tool-input-summary", "code-touch", "patch-summary", "reasoning", "file", "tool-output"]),
    )
  })

  test("a channel outside FTS_CHANNELS (raw) is skipped, not indexed", () => {
    freshDb()
    const res = _indexDocsForTest([
      doc({ part_id: "p_in", channel: "conversation", body: "indexed_conversation_xyz" }),
      doc({ part_id: "p_out", channel: "raw", body: "raw_should_be_skipped" }),
    ])
    expect(res.indexed).toBe(1)
    expect(res.skipped).toBe(1)
    expect(queryFts({ query: "raw_should_be_skipped", literal: true }).hits.length).toBe(0)
    expect(queryFts({ query: "indexed_conversation_xyz", literal: true }).hits.length).toBe(1)
  })

  test("ftsCovers reflects the resolved indexed set", () => {
    expect(ftsCovers(["conversation"])).toBe(true)
    expect(ftsCovers(["conversation", "file", "session-summary"])).toBe(true)
    expect(ftsCovers(["reasoning"])).toBe(true)
    expect(ftsCovers(["conversation", "tool-output"])).toBe(true)
    expect(ftsCovers(["raw"])).toBe(false)
    expect(ftsChannels()).toEqual(FTS_CHANNELS)
  })

  test("env override changes the resolved channel set", () => {
    const prev = process.env.OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS
    try {
      process.env.OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS = "conversation, reasoning , bogus"
      expect(ftsChannels()).toEqual(["conversation", "reasoning"])
      expect(ftsCovers(["reasoning"])).toBe(true)
      expect(ftsCovers(["tool-output"])).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS
      else process.env.OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS = prev
    }
  })
})

describe("fts: substring (trigram) channel coverage", () => {
  test("ftsSubstringChannels defaults to every indexed channel", () => {
    expect(ftsSubstringChannels()).toEqual(ftsChannels())
  })

  test("a channel in FTS_CHANNELS but excluded from the substring set is queryable in lex mode and absent from the substring path", () => {
    const prev = process.env.OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS
    try {
      freshDb()
      process.env.OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS = "conversation" // excludes tool-output (still indexed overall)
      expect(ftsSubstringChannels()).toEqual(["conversation"])

      _indexDocsForTest([doc({ part_id: "p_lexonly", channel: "tool-output", body: "lexonly_marker_qqq" })])

      // Still indexed overall (docs_lex) — lex/BM25 query finds it.
      const lex = queryFts({ query: "lexonly_marker_qqq", literal: false })
      expect(lex.hits.length).toBe(1)
      expect(lex.hits[0].part_id).toBe("p_lexonly")

      // Absent from the substring (docs_sub / literal) path.
      const lit = queryFts({ query: "lexonly_marker_qqq", literal: true })
      expect(lit.hits.length).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS
      else process.env.OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS = prev
    }
  })

  test("an env entry naming a channel outside the indexed set is ignored", () => {
    const prev = process.env.OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS
    try {
      process.env.OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS = "conversation,raw"
      expect(ftsSubstringChannels()).toEqual(["conversation"])
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS
      else process.env.OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS = prev
    }
  })
})

describe("fts: excerptDocument (tool-output head+tail policy)", () => {
  function makeContent(body: string, partId = "prt_exc"): string {
    return [
      `PART_ID: ${partId}`,
      `SESSION_ID: ses_1`,
      `MESSAGE_ID: msg_1`,
      `ROLE: assistant`,
      `TYPE: tool`,
      `ARCHIVED: false`,
      `CHANNEL: tool-output`,
      `TOOL: bash`,
      `STATUS: completed`,
      "---BODY---",
      body,
    ].join("\n")
  }

  test("keeps all header lines and the ---BODY--- separator", () => {
    const content = makeContent("small body")
    const out = excerptDocument("tool-output", content, "prt_exc")
    for (const h of ["PART_ID: prt_exc", "SESSION_ID: ses_1", "MESSAGE_ID: msg_1", "ROLE: assistant", "TYPE: tool", "ARCHIVED: false", "CHANNEL: tool-output", "TOOL: bash", "STATUS: completed", "---BODY---"]) {
      expect(out).toContain(h)
    }
  })

  test("a small tool-output body is unchanged with no truncation marker", () => {
    const content = makeContent("short output, well under the cap")
    const out = excerptDocument("tool-output", content, "prt_exc")
    expect(out).toBe(content)
    expect(out).not.toContain("middle truncated")
  })

  test("an oversized tool-output body yields head 4096 + marker with the real part_id + tail 4096, byte-bounded", () => {
    const head = "H".repeat(5000)
    const tail = "T".repeat(5000)
    const body = head + tail
    const content = makeContent(body, "prt_big123")
    const out = excerptDocument("tool-output", content, "prt_big123")

    expect(out).toContain("middle truncated")
    expect(out).toContain(`${body.length} bytes total`)
    expect(out).toContain("get-part('prt_big123')") // real part_id embedded in the dereference hint

    const bodyStart = out.indexOf("---BODY---") + "---BODY---".length + 1
    const excerptedBody = out.slice(bodyStart)
    const enc = new TextEncoder()

    // Head portion: first 4096 bytes of the encoded body, all 'H'.
    expect(excerptedBody.startsWith("H".repeat(4096))).toBe(true)
    expect(excerptedBody.startsWith("H".repeat(4097))).toBe(false)
    // Tail portion: last 4096 bytes, all 'T'.
    expect(excerptedBody.endsWith("T".repeat(4096))).toBe(true)
    expect(excerptedBody.endsWith("T".repeat(4097))).toBe(false)

    // The excerpted body must be much smaller than the original 10000-byte body.
    expect(enc.encode(excerptedBody).length).toBeLessThan(body.length)
  })

  test("a non-tool-output channel is not excerpted even if oversized", () => {
    const body = "Z".repeat(20_000)
    const content = [
      `PART_ID: prt_conv`, `SESSION_ID: ses_1`, `MESSAGE_ID: msg_1`, `ROLE: user`,
      `TYPE: text`, `ARCHIVED: false`, `CHANNEL: conversation`, "---BODY---", body,
    ].join("\n")
    const out = excerptDocument("conversation", content, "prt_conv")
    expect(out).toBe(content)
  })

  test("multibyte UTF-8 at the cut boundary does not produce broken characters", () => {
    // Multibyte filler (3-byte UTF-8 char "€") straddling the head/tail cut points.
    const filler = "€".repeat(3000) // 3000 * 3 = 9000 bytes, well over head+tail
    const content = makeContent(filler, "prt_mb")
    const out = excerptDocument("tool-output", content, "prt_mb")
    expect(out).toContain("middle truncated")
    // No replacement character should leak into the output.
    expect(out).not.toContain("\uFFFD")
    const bodyStart = out.indexOf("---BODY---") + "---BODY---".length + 1
    const excerptedBody = out.slice(bodyStart)
    // Every remaining char (aside from ascii marker text) should be a whole "€", never a fragment.
    const nonMarkerChars = excerptedBody.replace(/\n\.\.\.\[middle truncated;[^\]]*\]\n/, "")
    for (const ch of nonMarkerChars) {
      expect(ch === "€" || /[\x00-\x7f]/.test(ch)).toBe(true)
    }
  })

  test("returns content unchanged when the ---BODY--- separator is not found", () => {
    const weird = "no separator here at all"
    expect(excerptDocument("tool-output", weird, "prt_x")).toBe(weird)
  })

  test("FTS_EXCERPT_POLICY only has an entry for tool-output", () => {
    expect(FTS_EXCERPT_POLICY["tool-output"]).toEqual({ headBytes: 4096, tailBytes: 4096 })
    expect(FTS_EXCERPT_POLICY["conversation"]).toBeUndefined()
  })
})

describe("fts: limit + snippet bounds", () => {
  test("limit is respected and total is reported", () => {
    freshDb()
    const docs: _FtsTestDoc[] = []
    for (let i = 0; i < 5; i++) docs.push(doc({ part_id: `pl${i}`, body: `limitword occurrence ${i}` }))
    _indexDocsForTest(docs)
    const r = queryFts({ query: "limitword", literal: true, limit: 2 })
    expect(r.hits.length).toBe(2)
    expect(r.total).toBeGreaterThanOrEqual(2)
  })

  test("snippet is bounded even for a multi-MB body (literal + lex)", () => {
    freshDb()
    const huge = "x".repeat(60_000) + " NEEDLE_TOKEN_ZZZ " + "y".repeat(60_000)
    _indexDocsForTest([doc({ part_id: "p_big", body: huge })])

    const lit = queryFts({ query: "NEEDLE_TOKEN_ZZZ", literal: true })
    expect(lit.hits.length).toBe(1)
    expect(lit.hits[0].snippet.length).toBeLessThanOrEqual(600)
    expect(lit.hits[0].snippet).toContain("NEEDLE_TOKEN_ZZZ")

    const lex = queryFts({ query: "NEEDLE_TOKEN_ZZZ", literal: false })
    expect(lex.hits.length).toBe(1)
    expect(lex.hits[0].snippet.length).toBeLessThanOrEqual(600)
  })

  test("empty query returns no hits without touching the index", () => {
    freshDb()
    _indexDocsForTest([doc({ part_id: "pe", body: "anything" })])
    expect(queryFts({ query: "   ", literal: true }).hits.length).toBe(0)
    expect(queryFts({ query: "", literal: false }).total).toBe(0)
  })
})

describe("fts: syncFts smoke (bounded, tolerant of missing source DB)", () => {
  test("bounded sync writes to the temp sidecar and is resumable", async () => {
    freshDb()
    try {
      const r = await syncFts({ budgetMs: 30, batchSize: 25 })
      expect(typeof r.completed).toBe("boolean")
      expect(r.indexed).toBeGreaterThanOrEqual(0)
      expect(r.durationMs).toBeGreaterThanOrEqual(0)
      // Cursor persisted iff anything was indexed.
      if (r.indexed > 0) {
        expect(ftsStats().present).toBe(true)
        const stats = ftsStats()
        expect(stats.cursor === null || typeof stats.cursor.id === "string").toBe(true)
      }
    } catch (e: any) {
      // No populated source opencode.db on this machine — acceptable; the
      // deterministic behavior is covered by the _indexDocsForTest tests above.
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
    }
  })
})

// ===========================================================================
// DEFECT 1 — completeness is persisted and gates ftsUsable()
// ===========================================================================
describe("fts: completeness (DEFECT 1)", () => {
  test("a present-but-partial index is NOT usable; ftsUsable() gates on completeness, not mere presence", () => {
    freshDb()
    // _indexDocsForTest inserts docs WITHOUT running a source-draining sync, so
    // it represents exactly the partial state `fts-build --budget-ms N` leaves:
    // tables + rows exist, but the corpus was never proven drained.
    _indexDocsForTest([doc({ part_id: "prt_partial", body: "partial_marker" })])
    expect(ftsPresent()).toBe(true) // tables exist ...
    expect(ftsUsable()).toBe(false) // ... but it is NOT authoritative
    expect(ftsStats().complete).toBe(false)

    // Marking it complete (what a full drain does) flips usability on.
    _setCompleteForTest(true)
    expect(ftsUsable()).toBe(true)
    expect(ftsStats().complete).toBe(true)
  })

  test("a full (unbudgeted) syncFts drains the source, marks the index complete, and makes it usable", async () => {
    freshDb()
    let r
    try {
      r = await syncFts({}) // unbudgeted — drains the hermetic fixture
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    expect(r.completed).toBe(true) // this run reached the end of the source
    expect(r.complete).toBe(true) // persisted authoritative completeness
    expect(ftsUsable()).toBe(true)
    const s = ftsStats()
    expect(s.complete).toBe(true)
    expect(s.atSource).toBe(true) // indexed high-water caught up to source
  })

  test("completeness SURVIVES a later budget-stopped delta-sync (point 4)", async () => {
    freshDb()
    try {
      const full = await syncFts({})
      expect(full.complete).toBe(true)
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    // A tiny per-search delta-sync that stops on budget must NOT demote a
    // fully-built index back to partial just because it ran out of time.
    const delta = await syncFts({ budgetMs: -1 }) // -1 => stop immediately (budget-stopped)
    expect(delta.completed).toBe(false) // this run did NOT drain
    expect(delta.complete).toBe(true) // ... yet the index stays complete
    expect(ftsUsable()).toBe(true)
  })

  // -------------------------------------------------------------------------
  // THE SECOND-BUG FIX: "built" (complete) vs "fresh" (lag) are separate, and
  // only completeness gates usability. Lag NEVER does.
  // -------------------------------------------------------------------------

  test("a COMPLETE index is usable EVEN WHEN it lags a moving source (lag is reported, never gated)", () => {
    freshDb()
    _indexDocsForTest([doc({ part_id: "prt_lag", ts: 1000, body: "lagging_marker" })])
    _setCursorForTest({ ts: 1000, id: "prt_lag" }) // indexed high-water at ts=1000
    // A full drain happened at some earlier point (durable flag set) ...
    _setCompleteForTest(true)
    // ... but the live source has since moved 71 minutes ahead (OpenCode kept
    // writing) — the EXACT scenario that was permanently `usable=false` before
    // the fix. Pin the source high-water last so ftsStats() observes it.
    _setSourceHighWaterForTest({ ts: 1000 + 71 * 60_000, id: "prt_way_ahead" })

    const s = ftsStats()
    // The lag is real and REPORTED ...
    expect(s.atSource).toBe(false)
    expect(s.lagMs).toBe(71 * 60_000)
    // ... but it does NOT disable the fast tier.
    expect(s.complete).toBe(true)
    expect(ftsUsable()).toBe(true)
  })

  test("a budget-stopped FIRST build is neither complete nor usable EVEN IF caught up to source (point 5; freshness is not completeness)", () => {
    freshDb()
    // Partial build: rows exist, cursor advanced, but no unbudgeted drain ever
    // set the durable flag.
    _indexDocsForTest([doc({ part_id: "prt_first_partial", ts: 500, body: "first_partial" })])
    _setCursorForTest({ ts: 500, id: "prt_first_partial" })
    // Pin the source high-water EXACTLY at the cursor: the index is "caught up".
    // The OLD code would mislabel this complete (flag-absent + atSource); the
    // fix must not — freshness must never substitute for a real drain.
    _setSourceHighWaterForTest({ ts: 500, id: "prt_first_partial" })
    const s = ftsStats()
    expect(s.atSource).toBe(true) // caught up ...
    expect(s.lagMs).toBe(0)
    expect(s.complete).toBe(false) // ... yet still NOT complete (never drained)
    expect(ftsUsable()).toBe(false)
  })

  test("legacy index (sync_complete flag absent) is NOT usable via a lag/coverage heuristic — an absent flag means 'unknown', promoted only by an unbudgeted drain", async () => {
    freshDb()
    _indexDocsForTest([doc({ part_id: "prt_legacy", ts: 2000, body: "legacy_marker" })])
    // Simulate an index built before completeness tracking existed.
    _clearSyncCompleteFlagForTest()
    // Old (buggy) backfill would have marked this complete because the cursor
    // "reached" the source high-water. That heuristic is GONE: it was both
    // unsatisfiable on a live system AND able to mislabel a partial build.
    _setSourceHighWaterForTest({ ts: 2000, id: "prt_legacy" }) // cursor == source
    _closeFtsForTest() // force re-read of persisted (flag-absent) state
    expect(ftsStats().complete).toBe(false)
    expect(ftsUsable()).toBe(false)

    // The documented remedy — a single unbudgeted syncFts (== one `fts-build`
    // run, no --reset) — drains the source and sets the durable flag.
    let r
    try {
      r = await syncFts({})
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    expect(r.complete).toBe(true)
    expect(ftsUsable()).toBe(true)
  })
})

// ===========================================================================
// DEFECT 2 — swallowed document-build errors are counted, retried, and
// withhold completeness (dead-letter tracking)
// ===========================================================================
describe("fts: failed-part accounting (DEFECT 2)", () => {
  test("an outstanding failed part is surfaced in stats and withholds completeness", async () => {
    freshDb()
    try {
      const r = await syncFts({})
      expect(r.complete).toBe(true)
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    expect(ftsUsable()).toBe(true)

    // A build failure was recorded (equivalent to buildChannelDocuments throwing).
    _recordFailedPartsForTest(["prt_build_failure_1"])
    _closeFtsForTest() // force re-read of persisted state
    _resetSourceHighWaterCacheForTest()
    const s = ftsStats()
    expect(s.failedParts).toBe(1)
    expect(s.complete).toBe(false) // completeness withheld while a failure remains
    expect(ftsUsable()).toBe(false)
    expect(_readFailureStateForTest().failed).toBe(1)
  })

  test("the unbudgeted retry pass resolves a failed part whose source row is gone, restoring completeness", async () => {
    freshDb()
    try {
      await syncFts({})
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    _recordFailedPartsForTest(["prt_phantom_never_in_source"])
    _closeFtsForTest()
    _resetSourceHighWaterCacheForTest()
    expect(ftsUsable()).toBe(false)

    // A full sync retries the failed id; its source row does not exist, so the
    // retry pass clears it (the content is genuinely gone, not a build failure).
    const r = await syncFts({})
    expect(r.retried).toBeGreaterThanOrEqual(1)
    expect(r.failed_outstanding).toBe(0)
    expect(r.complete).toBe(true)
    expect(ftsUsable()).toBe(true)
    expect(_readFailureStateForTest().failed).toBe(0)
  })

  test("a budget-stopped delta-sync does NOT run the retry pass (keeps the per-search path cheap)", async () => {
    freshDb()
    try {
      await syncFts({})
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    _recordFailedPartsForTest(["prt_still_failing"])
    _closeFtsForTest()
    _resetSourceHighWaterCacheForTest()
    const delta = await syncFts({ budgetMs: 1500 })
    expect(delta.retried).toBe(0) // retry pass is unbudgeted-only
    expect(delta.failed_outstanding).toBe(1) // failure persists
    expect(ftsUsable()).toBe(false) // still withheld
  })
})

// ===========================================================================
// DEFECT 3 — a query with no usable trigram cannot run unbounded
// ===========================================================================
describe("fts: bounded queries (DEFECT 3)", () => {
  test("maxLiteralRun counts the longest contiguous non-wildcard code-point run", () => {
    expect(maxLiteralRun("th")).toBe(2) // trigram-unusable
    expect(maxLiteralRun("the")).toBe(3) // trigram-usable
    expect(maxLiteralRun("MP-4493")).toBe(7)
    expect(maxLiteralRun("a%b")).toBe(1) // wildcards break the run
    expect(maxLiteralRun("foo_bar_baz")).toBe(3)
    expect(maxLiteralRun("🚀")).toBe(1) // emoji = one code point
    expect(maxLiteralRun("日本")).toBe(2)
    expect(maxLiteralRun("日本語")).toBe(3)
  })

  function seedMany(n: number, body: (i: number) => string) {
    const docs: _FtsTestDoc[] = []
    for (let i = 0; i < n; i++) docs.push(doc({ part_id: `pb${i}`, ts: i, body: body(i) }))
    _indexDocsForTest(docs)
  }

  test("a trigram-unusable ('th', run<3) query is bounded by timeoutMs and flagged interrupted", () => {
    freshDb()
    seedMany(2000, (i) => `the quick th brown fox ${i}`)
    // timeoutMs:0 => the deadline trips on the first row, deterministically
    // bounding a would-be full content scan and flagging the partial result.
    const bounded = queryFts({ query: "th", literal: true, timeoutMs: 0 })
    expect(bounded.interrupted).toBe(true)
    expect(bounded.durationMs).toBeLessThan(500) // never the multi-second full scan
    // With a real budget the same query completes over the small hermetic corpus.
    const ok = queryFts({ query: "th", literal: true, timeoutMs: 5000, limit: 5 })
    expect(ok.interrupted).toBe(false)
    expect(ok.hits.length).toBe(5)
  })

  test("the degraded bounded scan still respects the exact filter for a run<3 wildcard query", () => {
    freshDb()
    _indexDocsForTest([
      doc({ part_id: "prt_g1", body: "value a%b literal here" }),
      // '%' as a LIKE wildcard would match "a" + anything + "b"; the JS exact
      // post-filter must drop this superset trap on the degraded path too.
      doc({ part_id: "prt_g2", body: "value aXXXb should not match" }),
    ])
    const r = queryFts({ query: "a%b", literal: true, timeoutMs: 5000 })
    expect(maxLiteralRun("a%b")).toBeLessThan(3) // confirms it takes the degraded path
    expect(r.hits.map((h) => h.part_id)).toEqual(["prt_g1"])
  })

  test("a trigram-usable identifier query is served on the fast path and never interrupted", () => {
    freshDb()
    _indexDocsForTest([doc({ part_id: "prt_fastid", body: "ticket MP-4493 resolved" })])
    const r = queryFts({ query: "MP-4493", literal: true, timeoutMs: 5000 })
    expect(r.interrupted).toBe(false)
    expect(r.hits.length).toBe(1)
  })
})

// ===========================================================================
// DEFECT 4 — the bounded COUNT is optional / lazily computed
// ===========================================================================
describe("fts: optional total (DEFECT 4)", () => {
  test("total is lazily computed on access and correct; withTotal forces it eagerly", () => {
    freshDb()
    const docs: _FtsTestDoc[] = []
    for (let i = 0; i < 4; i++) docs.push(doc({ part_id: `pt${i}`, body: `countword here ${i}` }))
    _indexDocsForTest(docs)

    // The hot path reads only hits/durationMs — total is not forced.
    const r = queryFts({ query: "countword", literal: true, limit: 2 })
    expect(r.hits.length).toBe(2)
    // Accessing it lazily yields the correct bounded count (all 4 match).
    expect(r.total).toBe(4)

    // Eager opt-in returns the same value.
    const eager = queryFts({ query: "countword", literal: true, limit: 2, withTotal: true })
    expect(eager.total).toBe(4)
  })
})

// ===========================================================================
// Non-ASCII case folding — trigram literal path is ASCII-fold only (audit note)
// ===========================================================================
describe("fts: non-ASCII case folding limitation", () => {
  test("ASCII case folds but non-ASCII (Ä<->ä) does NOT on the literal path; surfaced in stats", () => {
    freshDb()
    _indexDocsForTest([
      doc({ part_id: "prt_ascii", body: "prefix ABC suffix" }),
      doc({ part_id: "prt_nonascii", body: "prefix ÄBC suffix" }),
    ])
    // ASCII folds both directions.
    expect(queryFts({ query: "abc", literal: true }).hits.map((h) => h.part_id)).toContain("prt_ascii")
    expect(queryFts({ query: "ABC", literal: true }).hits.map((h) => h.part_id)).toContain("prt_ascii")
    // Non-ASCII: exact accented match works, but the lowercase fold does NOT —
    // documenting the divergence from ripgrep's Unicode-aware -i.
    expect(queryFts({ query: "ÄBC", literal: true }).hits.map((h) => h.part_id)).toContain("prt_nonascii")
    expect(queryFts({ query: "äbc", literal: true }).hits.map((h) => h.part_id)).not.toContain("prt_nonascii")
    // The limitation is advertised, not silently claimed as Unicode parity.
    expect(FTS_CASE_FOLDING_ASCII_ONLY).toBe(true)
    expect(ftsStats().caseFoldingAsciiOnly).toBe(true)
  })
})

// ===========================================================================
// Invariant 3 — literal path stays EXACT including the audit's %ab_c% example
// ===========================================================================
describe("fts: literal exactness invariant (%ab_c%)", () => {
  test("a query with both '%' and '_' narrows to exact matches via the instr() post-filter", () => {
    freshDb()
    _indexDocsForTest([
      doc({ part_id: "prt_exact", body: "token ab_c literal present" }),
      // '%'/'_' as LIKE wildcards widen to a superset; each of these is a trap
      // the exact post-filter must remove.
      doc({ part_id: "prt_trap1", body: "abXc has _ replaced" }),
      doc({ part_id: "prt_trap2", body: "abZZZc percent-wildcard trap" }),
    ])
    const r = queryFts({ query: "ab_c", literal: true })
    expect(r.hits.map((h) => h.part_id)).toEqual(["prt_exact"])
    expect(r.total).toBe(1)
  })
})

// ===========================================================================
// DEFECT 1 (audit) — a corrupt sidecar (missing coupled table) must NOT be
// reported complete/usable; it is honestly "not built" until a real rebuild.
// ===========================================================================
describe("fts: coupled-table integrity (audit DEFECT 1)", () => {
  /** Drop a single coupled table via a RAW connection (not through openFts, which
   *  would immediately rebuild), then force the module to reopen. */
  function dropTableRaw(path: string, table: string) {
    _closeFtsForTest() // release the module handle so the raw DDL can take the write lock
    const raw = new Database(path, { readwrite: true })
    try { raw.exec(`DROP TABLE IF EXISTS ${table}`) } finally { raw.close() }
    _closeFtsForTest() // ensure the next module call reopens fresh
  }

  for (const dropped of ["docs_sub", "docs_lex", "doc_map"]) {
    test(`a complete index with ${dropped} dropped is NOT usable/complete and honestly reports zero docs`, () => {
      const p = freshDb()
      _indexDocsForTest([doc({ part_id: "prt_corrupt", body: "corruptible_marker" })])
      _setCompleteForTest(true)
      // Baseline: genuinely complete + usable + has docs BEFORE the corruption.
      expect(ftsUsable()).toBe(true)
      expect(ftsStats().complete).toBe(true)
      expect(ftsStats().docs).toBeGreaterThan(0)

      dropTableRaw(p, dropped)

      // After reopen the coupled set was fully rebuilt EMPTY and every
      // completeness/cursor/failure marker durably cleared — never a silent
      // "complete with zero docs" (the worst-case DEFECT 1 failure).
      const s = ftsStats()
      expect(s.present).toBe(true) // tables were recreated ...
      expect(s.docs).toBe(0) // ... but empty (honest zero, not a hidden truncation)
      expect(s.complete).toBe(false)
      expect(_readSyncCompleteFlagForTest()).toBe(false) // the raw flag itself was cleared
      expect(_readCursorForTest()).toBeNull() // cursor cleared so a rebuild restarts from zero
      expect(ftsUsable()).toBe(false)
      // A query cannot silently succeed-with-nothing while claiming authority.
      expect(queryFts({ query: "corruptible_marker", literal: true }).hits.length).toBe(0)
    })
  }
})

// ===========================================================================
// DEFECT 2 (audit) — --reset clears completeness BEFORE the rewrite, restores
// it only after a genuine drain; an interrupted reset leaves it unusable.
// ===========================================================================
describe("fts: reset completeness ordering (audit DEFECT 2)", () => {
  test("--reset durably clears completeness BEFORE the rewrite and restores it only after draining", async () => {
    freshDb()
    let base
    try {
      base = await syncFts({})
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    expect(base.complete).toBe(true)
    expect(_readSyncCompleteFlagForTest()).toBe(true)

    // During the reset rewrite (observed via onProgress, which fires AFTER a
    // batch commit but BEFORE the final drain-based finalize), completeness must
    // already be cleared. Before the fix the stale flag stayed true here.
    let midRebuildComplete: boolean | null = null
    const r = await syncFts({
      fromCursor: null, // --reset
      onProgress: () => {
        if (midRebuildComplete === null) midRebuildComplete = _readSyncCompleteFlagForTest()
      },
    })
    if (midRebuildComplete !== null) expect(midRebuildComplete).toBe(false)
    // Restored only after the rewrite genuinely drained the source.
    expect(r.completed).toBe(true)
    expect(r.complete).toBe(true)
    expect(ftsUsable()).toBe(true)
  })

  test("an interrupted (non-draining) --reset leaves the index NOT usable and the cursor cleared", async () => {
    freshDb()
    try {
      const base = await syncFts({})
      expect(base.complete).toBe(true)
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    // budgetMs:-1 => reset clears state, then the loop stops immediately without
    // draining — simulating a reset process killed midway through the rewrite.
    const r = await syncFts({ fromCursor: null, budgetMs: -1 })
    expect(r.completed).toBe(false)
    expect(r.complete).toBe(false)
    expect(_readSyncCompleteFlagForTest()).toBe(false)
    expect(_readCursorForTest()).toBeNull() // reset cleared the cursor; it did not advance
    expect(ftsUsable()).toBe(false)
  })
})

// ===========================================================================
// Drain-based (NOT budget-based) completeness contract.
// ===========================================================================
describe("fts: drain-based completeness", () => {
  test("a run that DRAINS the source under a generous budget IS marked complete", async () => {
    freshDb()
    let r
    try {
      r = await syncFts({ budgetMs: 60_000 }) // budgeted, but drains the small hermetic corpus
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    expect(r.completed).toBe(true) // reached the end of `part` ...
    expect(r.complete).toBe(true) // ... so complete even though a budget was set
    expect(ftsUsable()).toBe(true)
  })

  test("a budget-stopped run that does NOT drain is NOT marked complete", async () => {
    freshDb()
    let r
    try {
      r = await syncFts({ budgetMs: -1 }) // stops immediately, drains nothing
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    expect(r.completed).toBe(false)
    expect(r.complete).toBe(false)
    expect(ftsUsable()).toBe(false)
  })
})

// ===========================================================================
// DEFECT 3 (audit) — cursor advancement and failure state commit atomically;
// a recorded failure withholds completeness durably at that moment.
// ===========================================================================
describe("fts: batch atomicity of cursor + failure state (audit DEFECT 3)", () => {
  test("a hot failure invalidates the completeness FLAG DURING the run (per-batch persistState), not only at end-of-run", async () => {
    freshDb()
    let base
    try {
      base = await syncFts({})
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    expect(base.complete).toBe(true)
    expect(_readSyncCompleteFlagForTest()).toBe(true)

    // Persist a hot failure, then rewind the cursor so the next sync re-scans the
    // corpus in real batches. The on-disk flag is still true at this point.
    _recordFailedPartsForTest(["prt_hot_phantom"])
    _setCursorForTest({ ts: 0, id: "" })
    _closeFtsForTest()
    _resetSourceHighWaterCacheForTest()
    expect(_readSyncCompleteFlagForTest()).toBe(true) // not yet invalidated

    // onProgress fires AFTER a batch commits but BEFORE the end-of-run finalize.
    // With the per-batch persistState fix, the failure has already flipped the
    // durable flag to false by then. Pre-fix, it stayed true until the very end.
    let midRunFlag: boolean | null = null
    const r = await syncFts({
      budgetMs: 60_000,
      onProgress: () => { if (midRunFlag === null) midRunFlag = _readSyncCompleteFlagForTest() },
    })
    if (midRunFlag !== null) expect(midRunFlag).toBe(false)
    // End state stays consistent: failure present -> not complete, cursor advanced.
    expect(r.failed_outstanding).toBe(1)
    expect(r.complete).toBe(false)
    expect(_readSyncCompleteFlagForTest()).toBe(false)
    expect(ftsUsable()).toBe(false)
  })

  test("a draining budgeted sync with a pre-existing (un-retried) failure keeps cursor advanced AND completeness withheld — consistently", async () => {
    freshDb()
    try {
      const base = await syncFts({})
      expect(base.complete).toBe(true)
    } catch (e: any) {
      expect(String(e?.code ?? e?.message ?? e)).toMatch(/DB_NOT_FOUND|not found|opencode\.db/i)
      return
    }
    const cursorAfterDrain = _readCursorForTest()

    // Inject a persisted hot failure, then run a BUDGETED sync (retry pass is
    // unbudgeted-only, so the failure is not resolved). The run drains but must
    // stay incomplete, and the persisted state must be internally consistent:
    // the cursor is still the drained high-water AND the failure is recorded AND
    // the flag is false — never "cursor advanced past an unrecorded failure".
    _recordFailedPartsForTest(["prt_pre_existing_failure"])
    _closeFtsForTest()
    _resetSourceHighWaterCacheForTest()

    const r = await syncFts({ budgetMs: 60_000 })
    expect(r.failed_outstanding).toBe(1)
    expect(r.complete).toBe(false)
    expect(_readSyncCompleteFlagForTest()).toBe(false)
    expect(_readFailureStateForTest().failed).toBe(1)
    expect(_readCursorForTest()).toEqual(cursorAfterDrain) // cursor consistent, not lost
    expect(ftsUsable()).toBe(false)
  })
})
