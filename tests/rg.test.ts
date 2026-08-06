/**
 * Unit tests for the ripgrep shell-out wrapper (src/lib/rg.ts).
 *
 * Hermetic: builds its own temp fixture tree under the OS tmpdir and never
 * touches the user's real ~/.local/share export tree. Requires a real `rg`
 * binary to be installed (ripgrep) — these are integration-style tests
 * against the actual CLI, matching the style of ck's own conventions.
 */
import { test, describe, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRg, locateRg, rgAvailable } from "../src/lib/rg.ts"
import { SessionsError } from "../src/lib/errors.ts"

const isWindows = process.platform === "win32"

describe("rg.ts", () => {
  let dir: string
  let subdir: string
  /** Present, regular, but deliberately NOT executable — the /etc/hosts repro. */
  let nonExecBin: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ose-rg-"))
    subdir = join(dir, "sub")
    mkdirSync(subdir)

    writeFileSync(
      join(dir, "a.txt"),
      ["hello world foo", "another Hello line", "nothing here", "hello-hyphenated"].join("\n") + "\n",
    )
    writeFileSync(
      join(dir, "b.txt"),
      ["line one", "regex.meta[chars](test)", "repeat repeat repeat repeat", "repeat repeat"].join("\n") + "\n",
    )
    writeFileSync(join(subdir, "c.txt"), ["scoped file content", "hello from subdir"].join("\n") + "\n")

    nonExecBin = join(dir, "not-executable-rg")
    writeFileSync(nonExecBin, "#!/bin/sh\necho fake rg\n")
    chmodSync(nonExecBin, 0o644) // regular file present, but no execute bit
  })

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort cleanup */
    }
  })

  test("rgAvailable() and locateRg() resolve to a usable binary", () => {
    expect(rgAvailable()).toBe(true)
    const p = locateRg()
    expect(typeof p).toBe("string")
    expect(p.length).toBeGreaterThan(0)
  })

  test("rgAvailable() reports false for a bogus absolute OPENCODE_SESSIONS_EXPLORER_RG_BIN", () => {
    const prev = process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
    process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = "/definitely/does/not/exist/rg-binary-xyz"
    try {
      expect(rgAvailable()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
      else process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = prev
    }
  })

  test("rgAvailable() reports false for a bogus non-absolute OPENCODE_SESSIONS_EXPLORER_RG_BIN (not resolvable on $PATH)", () => {
    const prev = process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
    process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = "definitely-not-a-real-rg-binary-xyz"
    try {
      expect(rgAvailable()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
      else process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = prev
    }
  })

  test.skipIf(isWindows)(
    "rgAvailable() reports false for a PRESENT but non-executable OPENCODE_SESSIONS_EXPLORER_RG_BIN (the /etc/hosts repro)",
    () => {
      const prev = process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
      process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = nonExecBin
      try {
        expect(rgAvailable()).toBe(false)
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
        else process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = prev
      }
    },
  )

  test.skipIf(isWindows)("$PATH scan rejects a non-executable match, even though the file is present", () => {
    const pathDir = mkdtempSync(join(tmpdir(), "ose-rg-path-"))
    const fakeName = "fake-rg-for-path-scan-test"
    const fakePath = join(pathDir, fakeName)
    writeFileSync(fakePath, "#!/bin/sh\necho fake rg\n")
    chmodSync(fakePath, 0o644) // present on $PATH, but not executable

    const prevOverride = process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
    const prevPath = process.env.PATH
    // Bare (non-absolute) override name forces resolution through the
    // $PATH scan (resolveOnPath) rather than the absolute-path branch.
    process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = fakeName
    process.env.PATH = `${pathDir}:${prevPath ?? ""}`
    try {
      expect(rgAvailable()).toBe(false)
    } finally {
      rmSync(pathDir, { recursive: true, force: true })
      if (prevOverride === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
      else process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = prevOverride
      if (prevPath === undefined) delete process.env.PATH
      else process.env.PATH = prevPath
    }
  })

  test.skipIf(isWindows)(
    "attempting to run with a non-executable OPENCODE_SESSIONS_EXPLORER_RG_BIN raises a structured error, never rc=2 with zero hits",
    async () => {
      const prev = process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
      process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = nonExecBin
      try {
        // The failure MUST surface as a thrown structured error, never as a
        // normal-looking result object (which is what silently masquerades
        // a real failure as "no matches").
        let threw: unknown = null
        try {
          await runRg({ query: "hello", scopes: [join(dir, "a.txt")] })
        } catch (e) {
          threw = e
        }
        expect(threw).toBeInstanceOf(SessionsError)
        expect((threw as SessionsError).code).toBe("RG_FAILED")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
        else process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = prev
      }
    },
  )

  test("rgAvailable() reverts to reporting true once the bogus override is cleared", () => {
    const prev = process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
    process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = "/definitely/does/not/exist/rg-binary-xyz"
    expect(rgAvailable()).toBe(false)
    if (prev === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
    else process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = prev
    expect(rgAvailable()).toBe(true)
  })

  test("a spawn ENOENT raises RG_NOT_FOUND rather than surfacing as rc=2", async () => {
    const prev = process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
    // An absolute path that does not exist: locateRg() returns it verbatim
    // (absolute overrides are trusted as-is), so spawn() itself will emit an
    // asynchronous ENOENT "error" event once the child process attempt fails,
    // exercising the async ENOENT path distinct from the synchronous
    // spawn() throw already covered by rgAvailable() returning false upfront.
    process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = join(dir, "not-a-real-binary")
    try {
      let threw: unknown = null
      try {
        await runRg({ query: "hello", scopes: [join(dir, "a.txt")] })
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(SessionsError)
      expect((threw as SessionsError).code).toBe("RG_NOT_FOUND")
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN
      else process.env.OPENCODE_SESSIONS_EXPLORER_RG_BIN = prev
    }
  })

  test("throws BAD_ARGS on empty scopes", async () => {
    let threw: unknown = null
    try {
      await runRg({ query: "hello", scopes: [] })
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(SessionsError)
    expect((threw as SessionsError).code).toBe("BAD_ARGS")
  })

  test("literal match found", async () => {
    const res = await runRg({ query: "world", scopes: [join(dir, "a.txt")] })
    expect(res.rc).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res.truncated).toBe(false)
    expect(res.hits.length).toBe(1)
    expect(res.hits[0]!.line_text).toBe("hello world foo")
    expect(res.hits[0]!.line_number).toBe(1)
    expect(res.hits[0]!.match_start).toBe(6)
    expect(res.hits[0]!.match_end).toBe(11)
  })

  test("fixedString treats regex metacharacters literally", async () => {
    const withFixed = await runRg({
      query: "regex.meta[chars](test)",
      scopes: [join(dir, "b.txt")],
      fixedString: true,
    })
    expect(withFixed.rc).toBe(0)
    expect(withFixed.hits.length).toBe(1)
    expect(withFixed.hits[0]!.line_text).toBe("regex.meta[chars](test)")
  })

  test("a genuine rg usage error (malformed regex) raises a structured RG_FAILED error carrying stderr, not rc=2 with zero hits", async () => {
    let threw: unknown = null
    try {
      await runRg({ query: "(unclosed", scopes: [join(dir, "b.txt")], fixedString: false })
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(SessionsError)
    expect((threw as SessionsError).code).toBe("RG_FAILED")
    // rg's own stderr explanation of the malformed regex must be preserved,
    // not swallowed -- that's the actionable part of the error.
    expect((threw as SessionsError).message.length).toBeGreaterThan("rg exited with a usage/runtime error (exit code 2)".length)
  })

  test("case-insensitive by default, case-sensitive when requested", async () => {
    const insensitive = await runRg({ query: "hello", scopes: [join(dir, "a.txt")] })
    expect(insensitive.rc).toBe(0)
    // "hello world foo", "another Hello line", "hello-hyphenated" all match case-insensitively
    expect(insensitive.hits.length).toBe(3)

    const sensitive = await runRg({ query: "hello", scopes: [join(dir, "a.txt")], caseSensitive: true })
    expect(sensitive.rc).toBe(0)
    // Only "hello world foo" and "hello-hyphenated" have lowercase "hello"
    expect(sensitive.hits.length).toBe(2)
    for (const h of sensitive.hits) expect(h.line_text.includes("hello")).toBe(true)
  })

  test("wholeWord restricts to word-boundary matches", async () => {
    const noBoundary = await runRg({ query: "hello", scopes: [join(dir, "a.txt")] })
    expect(noBoundary.hits.length).toBe(3) // includes "hello-hyphenated"

    const withBoundary = await runRg({ query: "hello", scopes: [join(dir, "a.txt")], wholeWord: true })
    // "hello-hyphenated" — hyphen is a word boundary in rg's default \b semantics,
    // so "hello" still matches there too; assert boundary excludes partial-word
    // matches instead using a query that IS a substring of a longer word.
    expect(withBoundary.rc).toBe(0)

    const partial = await runRg({ query: "hell", scopes: [join(dir, "a.txt")] })
    expect(partial.hits.length).toBeGreaterThan(0) // "hell" matches inside "hello..." without -w

    const partialWholeWord = await runRg({ query: "hell", scopes: [join(dir, "a.txt")], wholeWord: true })
    expect(partialWholeWord.rc).toBe(1) // no whole-word "hell" token anywhere
    expect(partialWholeWord.hits.length).toBe(0)
  })

  test("zero matches returns rc 1, empty hits, no throw", async () => {
    const res = await runRg({ query: "definitely-not-present-xyz", scopes: [join(dir, "a.txt")] })
    expect(res.rc).toBe(1)
    expect(res.hits).toEqual([])
    expect(res.timedOut).toBe(false)
  })

  test("topk truncates and sets truncated:true", async () => {
    const res = await runRg({ query: "repeat", scopes: [join(dir, "b.txt")], topk: 2 })
    expect(res.hits.length).toBeLessThanOrEqual(2)
    expect(res.truncated).toBe(true)
  })

  test("multiple scopes in a single call return hits from both", async () => {
    const res = await runRg({ query: "hello", scopes: [join(dir, "a.txt"), subdir] })
    expect(res.rc).toBe(0)
    const paths = new Set(res.hits.map((h) => h.path))
    expect(paths.has(join(dir, "a.txt"))).toBe(true)
    expect(paths.has(join(subdir, "c.txt"))).toBe(true)
  })

  test("timeout path sets timedOut:true and rc:124", async () => {
    // Use an intentionally tiny (but non-zero, since 0 is falsy and would
    // skip arming the timer) timeout so the AbortController fires
    // essentially immediately, without relying on the search itself being
    // slow (keeps this deterministic, not flaky).
    const res = await runRg({ query: "hello", scopes: [dir], timeoutMs: 1 })
    expect(res.timedOut).toBe(true)
    expect(res.rc).toBe(124)
  })
})
