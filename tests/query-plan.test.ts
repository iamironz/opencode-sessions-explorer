/**
 * Unit tests for the query backend planner (src/lib/query-plan.ts).
 * Pure module, no DB/filesystem required.
 */
import { test, describe, expect } from "bun:test"
import { isLiteralPattern, hasUsableTrigram, planSearch, type QueryPlanInput } from "../src/lib/query-plan.ts"
import { SessionsError } from "../src/lib/errors.ts"

function baseInput(overrides: Partial<QueryPlanInput> = {}): QueryPlanInput {
  return {
    mode: "regex",
    q: "MP-4493",
    fixedString: false,
    surface: "recall",
    channels: ["conversation", "session-summary"],
    ftsAvailable: true,
    ftsCoversChannels: true,
    rgAvailable: true,
    ...overrides,
  }
}

describe("isLiteralPattern", () => {
  test("Jira-style key with a bare dash is literal", () => {
    expect(isLiteralPattern("MP-4493", false)).toBe(true)
  })

  test("a dotted filename is NOT literal (. is a regex metachar)", () => {
    expect(isLiteralPattern("opencode.json", false)).toBe(false)
  })

  test("an explicit regex pattern is NOT literal", () => {
    expect(isLiteralPattern("foo.*bar", false)).toBe(false)
  })

  test("fixedString:true forces literal even with metacharacters", () => {
    expect(isLiteralPattern("a.*+?^$()[]{}|\\b", true)).toBe(true)
  })

  test("empty/whitespace-only query is not literal", () => {
    expect(isLiteralPattern("", false)).toBe(false)
    expect(isLiteralPattern("   ", false)).toBe(false)
  })
})

describe("planSearch: literal queries", () => {
  test("literal + fts available + covers channels -> fts, fallback is rg only", () => {
    const plan = planSearch(baseInput())
    expect(plan.backend).toBe("fts")
    expect(plan.literal).toBe(true)
    expect(plan.fallbacks).toEqual(["rg"])
  })

  test("literal + fts available but does not cover channels -> rg, no fallback, reason names channels", () => {
    const plan = planSearch(
      baseInput({ ftsCoversChannels: false, channels: ["reasoning", "tool-output"] }),
    )
    expect(plan.backend).toBe("rg")
    expect(plan.fallbacks).toEqual([])
    expect(plan.reason).toContain("reasoning")
    expect(plan.reason).toContain("tool-output")
  })

  test("literal + fts unavailable -> rg, no fallback", () => {
    const plan = planSearch(baseInput({ ftsAvailable: false, ftsCoversChannels: false }))
    expect(plan.backend).toBe("rg")
    expect(plan.fallbacks).toEqual([])
  })

  test("lex mode with literal query still prefers fts, falls back to rg only", () => {
    const plan = planSearch(baseInput({ mode: "lex" }))
    expect(plan.backend).toBe("fts")
    expect(plan.fallbacks).toEqual(["rg"])
  })

  test("lex mode with literal query but fts unavailable -> rg with no fallback", () => {
    const plan = planSearch(baseInput({ mode: "lex", ftsAvailable: false, ftsCoversChannels: false }))
    expect(plan.backend).toBe("rg")
    expect(plan.fallbacks).toEqual([])
  })
})

describe("planSearch: regex queries", () => {
  test("regex pattern -> rg even when fts is available and covers channels, no fallback", () => {
    const plan = planSearch(baseInput({ q: "foo.*bar" }))
    expect(plan.backend).toBe("rg")
    expect(plan.literal).toBe(false)
    expect(plan.fallbacks).toEqual([])
  })
})

describe("planSearch: ck escalation regression (must never happen for regex/lex)", () => {
  test("mode:regex never carries ck as a fallback, across fts/rg availability combinations", () => {
    const inputs: QueryPlanInput[] = [
      baseInput({ mode: "regex", q: "foo.*bar", ftsAvailable: true, ftsCoversChannels: true, rgAvailable: true }),
      baseInput({ mode: "regex", q: "foo.*bar", ftsAvailable: false, ftsCoversChannels: false, rgAvailable: true }),
      baseInput({ mode: "regex", q: "foo.*bar", ftsAvailable: true, ftsCoversChannels: false, rgAvailable: true }),
    ]
    for (const input of inputs) {
      const plan = planSearch(input)
      expect(plan.fallbacks).not.toContain("ck")
    }
  })

  test("mode:lex never carries ck as a fallback, across fts/rg availability combinations", () => {
    const inputs: QueryPlanInput[] = [
      baseInput({ mode: "lex", q: "MP-4493", ftsAvailable: true, ftsCoversChannels: true, rgAvailable: true }),
      baseInput({ mode: "lex", q: "MP-4493", ftsAvailable: false, ftsCoversChannels: false, rgAvailable: true }),
      baseInput({ mode: "lex", q: "MP-4493", ftsAvailable: true, ftsCoversChannels: false, rgAvailable: true }),
    ]
    for (const input of inputs) {
      const plan = planSearch(input)
      expect(plan.fallbacks).not.toContain("ck")
    }
  })

  test("fts -> rg escalation is still present when fts is the primary backend", () => {
    const plan = planSearch(baseInput({ ftsAvailable: true, ftsCoversChannels: true, rgAvailable: true }))
    expect(plan.backend).toBe("fts")
    expect(plan.fallbacks).toContain("rg")
    expect(plan.fallbacks).toEqual(["rg"])
  })
})

describe("planSearch: sem/hybrid queries", () => {
  test("sem mode -> ck regardless of fts/rg availability", () => {
    const plan = planSearch(baseInput({ mode: "sem", ftsAvailable: true, ftsCoversChannels: true, rgAvailable: true }))
    expect(plan.backend).toBe("ck")
    expect(plan.fallbacks).toEqual([])
  })

  test("hybrid mode -> ck regardless of fts/rg availability", () => {
    const plan = planSearch(baseInput({ mode: "hybrid", ftsAvailable: false, rgAvailable: false }))
    expect(plan.backend).toBe("ck")
    expect(plan.fallbacks).toEqual([])
  })
})

describe("planSearch: missing rg raises a structured error instead of degrading to ck", () => {
  test("regex path with rgAvailable:false throws RG_NOT_FOUND, never returns ck", () => {
    let threw: unknown = null
    try {
      planSearch(baseInput({ q: "foo.*bar", rgAvailable: false }))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(SessionsError)
    expect((threw as SessionsError).code).toBe("RG_NOT_FOUND")
  })

  test("literal + fts miss-coverage path with rgAvailable:false throws RG_NOT_FOUND", () => {
    expect(() => planSearch(baseInput({ ftsCoversChannels: false, rgAvailable: false }))).toThrow(SessionsError)
  })

  test("literal + fts unavailable + rg unavailable throws RG_NOT_FOUND", () => {
    let threw: unknown = null
    try {
      planSearch(baseInput({ ftsAvailable: false, ftsCoversChannels: false, rgAvailable: false }))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(SessionsError)
    expect((threw as SessionsError).code).toBe("RG_NOT_FOUND")
  })

  test("lex path falling back off fts with rgAvailable:false throws RG_NOT_FOUND", () => {
    let threw: unknown = null
    try {
      planSearch(baseInput({ mode: "lex", ftsAvailable: false, ftsCoversChannels: false, rgAvailable: false }))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(SessionsError)
    expect((threw as SessionsError).code).toBe("RG_NOT_FOUND")
  })

  test("literal query with no usable trigram and rgAvailable:false throws RG_NOT_FOUND even though fts is otherwise available", () => {
    // "th" is literal but has no 3-char trigram run; fts would fall back to
    // an unbounded scan, so this must route to rg, not silently accept fts.
    let threw: unknown = null
    try {
      planSearch(baseInput({ q: "th", rgAvailable: false }))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(SessionsError)
    expect((threw as SessionsError).code).toBe("RG_NOT_FOUND")
  })

  test("fts-primary plan does NOT throw when rg is unavailable (rg is only a fallback there, not required)", () => {
    const plan = planSearch(baseInput({ rgAvailable: false }))
    expect(plan.backend).toBe("fts")
    expect(plan.fallbacks).toEqual([])
  })
})

describe("planSearch: mode:lex is never reinterpreted as a regex", () => {
  for (const q of ["v1.2.3", "C++", "*", '"quoted phrase"', "a(b)[c]"]) {
    test(`lex query ${JSON.stringify(q)} is served from fts (BM25) when the index is usable, not treated as regex`, () => {
      const plan = planSearch(baseInput({ mode: "lex", q }))
      expect(plan.backend).toBe("fts")
      expect(plan.literal).toBe(true)
      expect(plan.treatAsFixedString).toBe(true)
    })

    test(`lex query ${JSON.stringify(q)} falls back to a FIXED-STRING rg search (not regex) when fts is unusable`, () => {
      const plan = planSearch(baseInput({ mode: "lex", q, ftsAvailable: false, ftsCoversChannels: false }))
      expect(plan.backend).toBe("rg")
      expect(plan.literal).toBe(true)
      expect(plan.treatAsFixedString).toBe(true)
    })
  }
})

describe("hasUsableTrigram", () => {
  test("1 and 2 character queries have no usable trigram", () => {
    expect(hasUsableTrigram("t")).toBe(false)
    expect(hasUsableTrigram("th")).toBe(false)
  })

  test("a bare 3-character query has a usable trigram", () => {
    expect(hasUsableTrigram("the")).toBe(true)
  })

  test("a longer query with no wildcards has a usable trigram", () => {
    expect(hasUsableTrigram("MP-4493")).toBe(true)
  })

  test("% and _ wildcards break a run: two short segments around a wildcard stay unusable", () => {
    expect(hasUsableTrigram("ab%cd")).toBe(false) // "ab" then "cd" -- both < 3
    expect(hasUsableTrigram("a_bc")).toBe(false) // "a" then "bc" -- both < 3
  })

  test("a 3+ char literal run survives even next to a wildcard", () => {
    expect(hasUsableTrigram("ab%cde")).toBe(true) // "cde" is a usable 3-run
    expect(hasUsableTrigram("%abc%")).toBe(true) // "abc" is a usable 3-run
  })

  test("whitespace does not break a run", () => {
    expect(hasUsableTrigram("a b")).toBe(true) // 3 chars total, one a space
  })

  test("CJK characters count as one character each, not UTF-16 units", () => {
    expect(hasUsableTrigram("日本語")).toBe(true) // 3 BMP chars
    expect(hasUsableTrigram("日本")).toBe(false) // 2 chars
  })

  test("emoji (surrogate-pair) characters count as one character each, not UTF-16 units", () => {
    // Each of these is a single Unicode code point represented as a UTF-16
    // surrogate pair (.length === 2 per emoji); counting UTF-16 units would
    // wrongly call 2 emoji (.length 4) a usable "3-char" run.
    expect(hasUsableTrigram("😀😀")).toBe(false) // 2 code points
    expect(hasUsableTrigram("😀😀😀")).toBe(true) // 3 code points
  })

  test("empty and whitespace-only queries have no usable trigram", () => {
    expect(hasUsableTrigram("")).toBe(false)
    expect(hasUsableTrigram("   ")).toBe(false)
  })
})

describe("planSearch: literal query without a usable trigram never uses fts, even when fts is available", () => {
  test("a 2-char literal query is routed to rg (bounded/killable), not fts, with a diagnosable reason", () => {
    const plan = planSearch(baseInput({ q: "th", ftsAvailable: true, ftsCoversChannels: true, rgAvailable: true }))
    expect(plan.backend).toBe("rg")
    expect(plan.literal).toBe(true)
    expect(plan.treatAsFixedString).toBe(true)
    expect(plan.fallbacks).toEqual([])
    expect(plan.reason).toContain("trigram")
  })

  test("a 3+ char literal query with a usable trigram still uses fts when available", () => {
    const plan = planSearch(baseInput({ q: "the", ftsAvailable: true, ftsCoversChannels: true }))
    expect(plan.backend).toBe("fts")
  })
})

describe("planSearch: fallback invariants", () => {
  test("fallbacks never contain the primary backend", () => {
    const inputs: QueryPlanInput[] = [
      baseInput(),
      baseInput({ q: "foo.*bar" }),
      baseInput({ ftsCoversChannels: false }),
      baseInput({ mode: "sem" }),
      // rg-unavailable case that still resolves (fts primary, rg only a
      // fallback candidate) rather than requiring rg -- see the dedicated
      // RG_NOT_FOUND describe block for cases where rg IS required.
      baseInput({ rgAvailable: false }),
    ]
    for (const input of inputs) {
      const plan = planSearch(input)
      expect(plan.fallbacks).not.toContain(plan.backend)
    }
  })

  test("fallbacks never contain rg when rgAvailable is false", () => {
    const plan = planSearch(baseInput({ rgAvailable: false }))
    expect(plan.fallbacks).not.toContain("rg")
  })

  test("fallbacks never contain fts when ftsAvailable is false or coverage is missing", () => {
    const plan1 = planSearch(baseInput({ ftsAvailable: false, ftsCoversChannels: false, q: "foo.*bar" }))
    expect(plan1.fallbacks).not.toContain("fts")

    const plan2 = planSearch(baseInput({ ftsCoversChannels: false, q: "MP-4493" }))
    expect(plan2.fallbacks).not.toContain("fts")
  })
})

describe("planSearch: exactIdentifier flag", () => {
  test("Jira key is an exact identifier", () => {
    const plan = planSearch(baseInput({ q: "MP-4493" }))
    expect(plan.exactIdentifier).toBe(true)
  })

  test("a session id is an exact identifier", () => {
    const plan = planSearch(baseInput({ q: "ses_abc123" }))
    expect(plan.exactIdentifier).toBe(true)
  })

  test("an ordinary phrase is not an exact identifier", () => {
    const plan = planSearch(baseInput({ q: "how do I search my sessions" }))
    expect(plan.exactIdentifier).toBe(false)
  })
})
