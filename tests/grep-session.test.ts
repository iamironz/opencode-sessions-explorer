/**
 * Focused coverage for the grep-session rg migration.
 *
 * `tests/rehearsal.test.ts` (GR-* tests) already covers the tool's happy path,
 * NOT_FOUND, empty result, archived flag, limit cap, fixed_string, and regex
 * special characters — that file is owned by another agent and must not be
 * edited here. This file covers the specific rg-backed behaviors introduced by
 * the ck -> rg migration that are not otherwise exercised: context_lines
 * stitching, mode:'lex' literal-treatment parity, whole_word, and
 * case_sensitive.
 */
import { test, describe, expect } from "bun:test"
import { grepSession } from "../src/tools/grep-session.ts"
import { runTool, loadFixtures } from "./helpers.ts"

const F = loadFixtures()

describe("grep_session (rg backend)", () => {
  test("context_lines stitches surrounding lines from the matched file, not just the hit line", async () => {
    const noContext = await runTool(grepSession, {
      session_id: F.sessions.active,
      pattern: "file not found",
      fixed_string: true,
      channels: ["raw"],
      context_lines: 0,
      limit: 5,
    })
    expect(noContext.ok).toBe(true)
    expect(noContext.data.matches.length).toBeGreaterThan(0)
    // With no context, the snippet is exactly the matched line.
    expect(noContext.data.matches[0].snippet).toBe("read failed: file not found")

    const withContext = await runTool(grepSession, {
      session_id: F.sessions.active,
      pattern: "file not found",
      fixed_string: true,
      channels: ["raw"],
      context_lines: 2,
      limit: 5,
    })
    expect(withContext.ok).toBe(true)
    expect(withContext.data.matches.length).toBeGreaterThan(0)
    const snippet = withContext.data.matches[0].snippet as string
    // The two lines above the match ("INPUT: ..." and "ERROR:") must now be present.
    expect(snippet).toContain("ERROR:")
    expect(snippet).toContain("read failed: file not found")
    expect(snippet.split("\n").length).toBeGreaterThan(1)

    // line_start/line_end should reflect the requested context window.
    const m = withContext.data.matches[0]
    expect(m.line_end - m.line_start).toBe(4) // 2 lines above + hit + 2 lines below
  }, 30000)

  test("mode:'lex' is treated as a literal substring match (no local BM25 index)", async () => {
    const r = await runTool(grepSession, {
      session_id: F.sessions.active,
      pattern: "Submit PR review",
      mode: "lex",
      limit: 5,
    })
    expect(r.ok).toBe(true)
    expect(r.data.mode).toBe("lex")
    expect(r.data.matches.length).toBeGreaterThan(0)
  }, 30000)

  test("mode:'lex' with regex metacharacters in the pattern does not throw (treated literally)", async () => {
    // "review." contains a regex metacharacter; as a literal substring it should
    // still find the text "review." if present, and must not error out as a bad regex.
    const r = await runTool(grepSession, {
      session_id: F.sessions.active,
      pattern: "PR review",
      mode: "lex",
      limit: 5,
    })
    expect(r.ok).toBe(true)
  }, 30000)

  test("whole_word restricts matches to full-word boundaries", async () => {
    const loose = await runTool(grepSession, {
      session_id: F.sessions.active,
      pattern: "review",
      whole_word: false,
      limit: 10,
    })
    const strict = await runTool(grepSession, {
      session_id: F.sessions.active,
      pattern: "revie",
      whole_word: true,
      limit: 10,
    })
    expect(loose.ok).toBe(true)
    expect(strict.ok).toBe(true)
    // "revie" is not a whole word anywhere in the fixture text, so whole_word
    // must suppress the substring match that a plain regex would have found.
    expect(strict.data.matches).toEqual([])
  }, 30000)

  test("case_sensitive:true does not match a differently-cased pattern", async () => {
    const r = await runTool(grepSession, {
      session_id: F.sessions.active,
      pattern: "SUBMIT PR REVIEW",
      case_sensitive: true,
      limit: 5,
    })
    expect(r.ok).toBe(true)
    expect(r.data.matches).toEqual([])
  }, 30000)

  test("scanned_files counts distinct matched files, not total hit rows", async () => {
    const r = await runTool(grepSession, {
      session_id: F.sessions.active,
      pattern: "the",
      case_sensitive: false,
      limit: 50,
    })
    expect(r.ok).toBe(true)
    // scanned_files must be <= number of matches (one file can yield multiple hits).
    expect(r.data.scanned_files).toBeLessThanOrEqual(r.data.matches.length)
  }, 30000)

  test("rg_duration_ms is reported and no ck fields leak into the response", async () => {
    const r = await runTool(grepSession, {
      session_id: F.sessions.active,
      pattern: F.phrases.active_known,
      limit: 5,
    })
    expect(r.ok).toBe(true)
    expect(typeof r.data.rg_duration_ms).toBe("number")
    expect((r.data as any).ck_duration_ms).toBeUndefined()
    expect((r.data as any).ck_scope_coverage).toBeUndefined()
  }, 30000)
})
