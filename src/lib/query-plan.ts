/**
 * Pure planner that picks a search backend (fts / rg / ck) for a query.
 *
 * No I/O: every environment fact (index availability, channel coverage,
 * ripgrep availability) is passed in as an argument so this stays
 * unit-testable without a filesystem, DB, or subprocess.
 *
 * Backend tiers, and why escalation stops where it does:
 * - `ck` is reserved for embedding modes (`sem`/`hybrid`). It is never a
 *   fallback for literal/regex queries: `rg` and `ck` read the exact same
 *   filesystem export tree, so an exhaustive `rg` pass that found nothing
 *   proves `ck` has no additional corpus or capability to find more for
 *   literal/regex matching. Escalating to it there is pure latency waste.
 * - `rg` is the exhaustive literal/regex tier over the full export tree
 *   and every channel. It is the terminal fallback for anything that isn't
 *   an embedding query.
 * - `fts` is the fast indexed tier. It only excerpts large documents (e.g.
 *   4KB head + 4KB tail per `tool-output` entry) and only covers a channel
 *   subset, so its one legitimate escalation target is `rg`, which can see
 *   the un-indexed middle of large documents and the un-indexed channels.
 */
import type { SearchChannel, SearchSurface } from "./channel.js"
import { looksLikeExactIdentifier } from "./channel.js"
import { SessionsError } from "./errors.js"

export type SearchBackend = "fts" | "rg" | "ck"

export type QueryPlanInput = {
  mode: "regex" | "lex" | "sem" | "hybrid"
  q: string
  fixedString: boolean
  surface: SearchSurface
  channels: SearchChannel[] // the resolved channel set for this query
  // Sidecar index is present AND complete enough to be authoritative.
  // Callers MUST pass `ftsUsable()` semantics here (see lib/fts.ts), not mere
  // presence: a budget-stopped partial build is NOT usable, because
  // search-text only escalates off a backend on ZERO hits and would
  // otherwise silently return a fraction of the corpus without any signal
  // that coverage was incomplete. Do not pass a raw "file exists" check.
  ftsAvailable: boolean
  ftsCoversChannels: boolean // every requested channel is inside the indexed set
  rgAvailable: boolean
}

export type QueryPlan = {
  backend: SearchBackend
  literal: boolean // query can be treated as a literal substring
  exactIdentifier: boolean // looksLikeExactIdentifier(q)
  fallbacks: SearchBackend[] // ordered escalation path if the primary yields nothing/fails
  reason: string // short human-readable explanation, safe to surface in warnings
  /**
   * True when the ONLY correct `rg` invocation for this plan is a
   * fixed-string (`-F`) search, never a live regular expression.
   *
   * Set whenever:
   *  - `mode:"lex"` — BM25/text intent must NEVER be reinterpreted as a
   *    regex, even when the FTS BM25 tier is unusable and the query has to
   *    fall back onto `rg`. A `lex` query like `v1.2.3`, `C++`, or `*` is
   *    full of regex metacharacters but is not a regex query — this flag is
   *    what lets `rg` treat it as a fixed string instead.
   *  - the query was classified `literal` (see `isLiteralPattern`) for a
   *    `regex`-mode query — its own literal fast path is also a
   *    fixed-string match, not a regex match, whenever it runs through `rg`.
   *
   * Callers (search-text.ts, grep-session.ts) MUST pass this straight
   * through as `runRg({ fixedString: plan.treatAsFixedString, ... })`
   * instead of re-deriving fixed-stringness from `mode`/metacharacters
   * themselves, or `lex` queries risk silently becoming regex again.
   */
  treatAsFixedString: boolean
}

// Regex metacharacters that disqualify a query from being treated as a
// literal substring search. Deliberately includes `.` (matches any char in
// regex, so a literal "." would silently under-match if we skipped this).
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/

/**
 * Classifies a `mode:"regex"` query as literal-vs-regex based on regex
 * metacharacters. This is ONLY meaningful for `regex` mode's own
 * literal-fast-path decision (can this run through `rg -F` / the trigram
 * index instead of a real regex evaluation?).
 *
 * `mode:"lex"` NEVER goes through this function to decide literal-ness:
 * `lex` is BM25/text intent by definition and is always treated as literal
 * regardless of metacharacters (see `planSearch`) — that is the fix for the
 * defect where `v1.2.3` / `C++` / `*` under `lex` mode were silently
 * reinterpreted as regular expressions.
 */
export function isLiteralPattern(q: string, fixedString: boolean): boolean {
  if (fixedString) return true
  if (q.trim().length === 0) return false
  return !REGEX_METACHARACTERS.test(q)
}

/**
 * True only when `q` contains a contiguous run of at least 3 characters
 * that SQLite's FTS5 `trigram` tokenizer can actually use to accelerate a
 * `body LIKE '%q%'` lookup (the `docs_sub` table in lib/fts.ts).
 *
 * Why this exists: the trigram tokenizer indexes overlapping windows of 3
 * literal characters. A query shorter than 3 characters — or one whose only
 * literal runs are shorter than 3 once `%`/`_` LIKE wildcards are accounted
 * for — has no 3-character window the index can match on, so SQLite's LIKE
 * optimizer cannot restrict the trigram index and falls back to a full
 * content scan. Measured on the real 565k-doc / 5.0GB index: the 2-character
 * literal `th` took 12.20s despite `timeout_ms: 1000`, because there is no
 * bound on that fallback scan — it isn't a query the trigram index can help
 * with at all.
 *
 * Rule for what breaks a run:
 *  - `%` and `_` DO break a run. `lib/fts.ts` deliberately never escapes
 *    these in the LIKE pattern (`%${q}%`) — they act as ordinary LIKE
 *    wildcards, matching "any characters"/"any one character" — so a
 *    3-character window straddling one of them is not a literal run the
 *    trigram index can pin down.
 *  - Whitespace does NOT break a run. The trigram tokenizer windows over
 *    every 3 consecutive characters regardless of what they are; a space is
 *    just another character to it, so e.g. `"a b"` (3 chars, one a space)
 *    is a perfectly usable trigram window.
 *  - Characters are counted as Unicode code points, not UTF-16 code units
 *    (`Array.from`, not `.length`/indexing), so a multi-byte CJK character
 *    or an emoji outside the BMP (a UTF-16 surrogate pair) counts as ONE
 *    character, matching how the trigram tokenizer itself windows over
 *    characters rather than UTF-16 units.
 *  - Empty or whitespace-only input is never usable (nothing to match).
 *
 * Contract: exported name/signature is depended on by other planner
 * callers — do not rename it.
 */
export function hasUsableTrigram(q: string): boolean {
  if (!q || q.trim().length === 0) return false
  let run = 0
  for (const ch of q) {
    // `for...of` over a string iterates by Unicode code point, not UTF-16
    // code unit, so a surrogate-pair emoji or a CJK character is one `ch`.
    if (ch === "%" || ch === "_") {
      run = 0
      continue
    }
    run += 1
    if (run >= 3) return true
  }
  return false
}

/** Backend must be `rg`; throws a structured, catchable error if it is genuinely
 * unavailable rather than silently degrading to `ck` (see module doc: `ck`
 * reads the same file tree as `rg` but times out on it — degrading there is
 * a slow, silent false negative, not a real fallback). Callers running
 * inside `runWithEnvelope` (search-text.ts) already catch `SessionsError`
 * and render it into the structured `{ ok:false, error }` envelope, so this
 * surfaces cleanly without any extra handling on the caller's side. */
function requireRg(input: QueryPlanInput): void {
  if (!input.rgAvailable) {
    throw new SessionsError(
      "RG_NOT_FOUND",
      "This query has no valid backend: it requires ripgrep (rg) over the file tree, but rg is not installed or not resolvable.",
      "install ripgrep, e.g. `brew install ripgrep`, or point OPENCODE_SESSIONS_EXPLORER_RG_BIN at an absolute rg binary path",
    )
  }
}

function buildFallbacks(primary: SearchBackend, candidates: SearchBackend[], input: QueryPlanInput): SearchBackend[] {
  const isAvailable = (b: SearchBackend): boolean => {
    if (b === primary) return false
    if (b === "rg") return input.rgAvailable
    if (b === "fts") return input.ftsAvailable && input.ftsCoversChannels
    return true // ck is always assumed available
  }
  return candidates.filter(isAvailable)
}

export function planSearch(input: QueryPlanInput): QueryPlan {
  const isLexMode = input.mode === "lex"
  // `lex` is BM25/text intent by contract and is NEVER a regex, regardless
  // of metacharacters in the query — a `mode:"regex"` query is the only one
  // whose literal-vs-regex classification depends on isLiteralPattern.
  const literal = isLexMode ? true : isLiteralPattern(input.q, input.fixedString)
  const exactIdentifier = looksLikeExactIdentifier(input.q)

  // sem/hybrid: only ck does embeddings, regardless of everything else.
  if (input.mode === "sem" || input.mode === "hybrid") {
    return {
      backend: "ck",
      literal,
      exactIdentifier,
      fallbacks: [],
      reason: `${input.mode} mode requires ck`,
      treatAsFixedString: false,
    }
  }

  if (isLexMode) {
    // BM25 tier (docs_lex/unicode61) has no trigram-length requirement, so
    // hasUsableTrigram does not gate this branch — it only matters for the
    // literal-substring (docs_sub/trigram) path below.
    if (input.ftsAvailable && input.ftsCoversChannels) {
      return {
        backend: "fts",
        literal,
        exactIdentifier,
        fallbacks: buildFallbacks("fts", ["rg"], input),
        reason: "lex query served from fts BM25 index",
        treatAsFixedString: true,
      }
    }
    // fts unusable for lex -> fall back to a LITERAL (fixed-string) rg
    // search, never a regex one: this is the fix for lex queries like
    // `v1.2.3` / `C++` / `*` silently becoming regex matches.
    requireRg(input)
    const reasonSuffix = input.ftsAvailable
      ? `fts does not cover requested channels: ${input.channels.join(", ")}`
      : "fts index unavailable"
    return {
      backend: "rg",
      literal,
      exactIdentifier,
      fallbacks: [],
      reason: `lex query fixed-string fallback to rg: ${reasonSuffix}`,
      treatAsFixedString: true,
    }
  }

  // mode:"regex" from here on.
  // Not literal -> a real regex. The FTS index cannot evaluate regular
  // expressions, so it is never a candidate here. rg is terminal: ck reads
  // the same tree and adds no capability for regex matching.
  if (!literal) {
    requireRg(input)
    return {
      backend: "rg",
      literal,
      exactIdentifier,
      fallbacks: [],
      reason: "regex pattern requires rg",
      treatAsFixedString: false,
    }
  }

  // Literal query. fts's trigram (docs_sub) path can only accelerate this if
  // the query has a usable 3+ character run (see hasUsableTrigram) — below
  // that, fts degrades to an unbounded full content scan (12.2s measured for
  // a 2-char query against a 1000ms timeout budget on the real index), so an
  // unbounded fts is never an acceptable primary even when the index is
  // otherwise available. rg is bounded/killable, so it is always the right
  // choice for a too-short literal.
  if (!hasUsableTrigram(input.q)) {
    requireRg(input)
    return {
      backend: "rg",
      literal,
      exactIdentifier,
      fallbacks: [],
      reason: "literal query has no usable 3+ character trigram run; fts would fall back to an unbounded full scan, routing to rg instead",
      treatAsFixedString: true,
    }
  }

  // Literal query with a usable trigram: prefer fts when it is available
  // and covers the requested channels. fts's only legitimate escalation
  // target is rg (see module doc); never ck.
  if (input.ftsAvailable && input.ftsCoversChannels) {
    return {
      backend: "fts",
      literal,
      exactIdentifier,
      fallbacks: buildFallbacks("fts", ["rg"], input),
      reason: "literal query served from fts trigram index",
      treatAsFixedString: true,
    }
  }

  // fts unavailable or does not cover the requested channels -> rg. rg is
  // terminal here too.
  requireRg(input)
  const reasonSuffix = input.ftsAvailable
    ? `fts does not cover requested channels: ${input.channels.join(", ")}`
    : "fts index unavailable"

  return {
    backend: "rg",
    literal,
    exactIdentifier,
    fallbacks: [],
    reason: reasonSuffix,
    treatAsFixedString: true,
  }
}
