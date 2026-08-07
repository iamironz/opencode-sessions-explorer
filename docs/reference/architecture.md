# Architecture Reference

## Scope

This page describes the layered pipeline that turns the OpenCode session
database into enriched, searchable tool responses, and the single-writer exception
to the otherwise read-only design. It is a conceptual reference; for the
contributor-facing build and code layout, see the
[Development Guide](../maintainers/development.md).

## The Layers

```
L1  SQLite DB (read-only source of truth)
      | PRAGMA query_only = 1; opened readonly
      v
L2a FTS5 sidecar (fts-index.sqlite)         L2b filesystem export tree
      | read straight from L1, never the         (~/.local/share/opencode-sessions-explorer)
      | file tree; trigram substring +            | by-session/... + by-channel/.../by-session/...
      | unicode61 BM25 tables                     | delta-synced before each search call
      v                                           v
    fast literal/lex tier                   L3a ripgrep (rg)          L3b ck (.ck/; optional)
    (query-plan.ts: "fts")                       exhaustive regex/          sem/hybrid embeddings
                                                  fallback tier               ONLY (query-plan.ts:
                                                  (query-plan.ts: "rg")       "ck")
      \_____________________________________________|___________________________/
                                    |
                                    v
L4  enriched response
      | re-fetches session/part metadata from SQLite per hit
      v
    { ok, data, meta, warnings } envelope
```

Search is not one path through this diagram: a pure planner
(`src/lib/query-plan.ts`) picks fts, rg, or ck per query, and escalates to a
fallback backend only when the primary returns zero hits. See
[the query planner section](#the-query-planner-fts--rg--ck) below for the exact
rules.

### L1 — SQLite Source Of Truth

The OpenCode database is the authoritative source. The shared handle opens it
read-only and sets `PRAGMA query_only = 1` as a belt-and-braces guard, so any
accidental write through that handle throws. The live OpenCode process may be
writing concurrently — the database runs in WAL mode and multiple readers plus a
writer is safe, with a `busy_timeout` covering rare lock collisions. All metadata,
counts, and message/part bodies ultimately come from here.

### L2a — FTS5 Sidecar (Fast Tier)

`src/lib/fts.ts` maintains a separate SQLite file, `fts-index.sqlite` in the
export root (override via `OPENCODE_SESSIONS_EXPLORER_FTS_DB`), holding two
FTS5 tables over the same document set:

- `docs_sub` — `tokenize='trigram'`, for substring matching (`body LIKE ?`,
  index-accelerated). Case-insensitivity here is **ASCII-only**: the tokenizer
  folds `A-Z`<->`a-z` but not accented or non-Latin letters, so an indexed
  `ÄBC` is matched by `ÄBC` or `Äbc` but not by `äbc`. Ripgrep's `-i` is
  Unicode-aware and can find such a match that this tier misses. This is a
  known, deliberate limitation — see
  [FTS Coverage Limitations](#fts-coverage-limitations) below — not a claim
  of parity with ripgrep.
- `docs_lex` — `tokenize="unicode61 tokenchars '-_'"`, for BM25-ranked `lex`
  search, keeping identifiers like `MP-4493` as single tokens. `mode:"lex"`
  is always treated as text against this table (BM25 `MATCH`), never as a
  regular expression, regardless of how many regex metacharacters the query
  contains (e.g. `v1.2.3`, `C++`).

Measured on a large real corpus, a full build indexed 507,840 parts into
565,516 documents in about 210 seconds, producing a roughly 5.0 GB sidecar
file (peak ~1.5 GB RSS during that one-time build, ~250 MB RSS at query
time). Your numbers will vary with history size; see
[export-and-maintenance.md](../guides/export-and-maintenance.md) for the
build command.

This sidecar reads documents from the SQLite DB directly (via the same
channel-view logic as the exporter), **not** from the filesystem export tree,
and keeps its own resumable cursor plus tombstone reconciliation for content
that is later hard-deleted from SQLite. Indexed channels default to every
derived channel except `raw`, overridable via
`OPENCODE_SESSIONS_EXPLORER_FTS_CHANNELS`. `tool-output` — the largest channel
by far — is indexed as a 4 KB head + 4 KB tail excerpt (see
[the tool-output trade-off](#the-tool-output-excerpt-trade-off) below) rather
than excluded outright. Build or refresh it with
`opencode-sessions-explorer-fts-build` (`--reset` rebuilds from cursor zero,
`--budget-ms N` stops after N ms); `search-text` also delta-syncs it on every
call with a ~1.5s budget, skipping the filesystem export tree entirely when it
does.

The `docs_sub` trigram tokenizer needs a run of **3 or more contiguous
characters** (counted as Unicode code points, so a CJK character or an emoji
counts as one) to accelerate a `body LIKE '%q%'` lookup at all. A 1-2
character literal — including a 1-2 character CJK or emoji query — has no
such window, so the query planner (`src/lib/query-plan.ts`,
`hasUsableTrigram()`) routes it straight to `rg` instead of `fts`. As a
defensive backstop, `queryFts()` itself also bounds any such
too-short-for-the-index query to a deadline (750ms by default, or the
caller's `timeoutMs`) rather than letting it run as an unbounded content
scan, and marks the result `interrupted` if the deadline or a row cap was
hit first.

#### Latency

Measured on a real index (566,958 documents, warm OS/page cache), single
`docs_sub` lookups:

| Query | Latency | Why |
| --- | --- | --- |
| Rare identifier, e.g. `MP-4493` | ~8 ms | Trigram-accelerated, few candidate rows. |
| Shorter identifier prefix, e.g. `MP-44` | ~19 ms | Trigram-accelerated, more candidate rows to rank/order. |
| Common short word, e.g. `the` | ~508 ms | Trigram-accelerated, but high cardinality plus the query's `ORDER BY` forces a temp B-tree over a large row set. |
| 1-2 character literal or a 1-2 character CJK/emoji query | ~507-694 ms warm, up to ~12 s cold | Below the 3-character trigram floor above — not index-accelerated at all; this is exactly the case the planner now routes to `rg` and `queryFts()`'s own deadline now bounds as a backstop. |

"Millisecond" is accurate for a rare, selective literal; it is not a blanket
claim for every literal query, and it never applies to a query the trigram
index cannot accelerate.

### L2b — Filesystem Export Tree

Searchable content is also materialized to a filesystem tree (default
`~/.local/share/opencode-sessions-explorer`, overridable via
`OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`). It has two arms:

- `by-session/<ses_id>/` — the raw, lossless per-part export plus `meta.json`.
- `by-channel/<channel>/by-session/<ses_id>/` — curated channel views derived from
  the raw parts (see [search-surfaces.md](search-surfaces.md)).

The tree is built once by `opencode-sessions-explorer-bulk-export` and then
delta-synced automatically before each `search-text` / `grep-session` call that
needs it (real regex, `sem`/`hybrid`, or an `fts` zero-hit escalation), so new
parts become searchable without a manual re-export. Budgeted sync uses an id-cursor
insert fast path for newly appended parts, plus session-dirty scans keyed by
`session.time_updated` to re-export sessions whose part status or metadata changed.
Short search-triggered syncs also schedule a throttled background reconcile, while
unbudgeted bulk exports perform full tombstone cleanup inline.

### L3a — ripgrep (Exhaustive Tier)

`search-text` (for real regex patterns, for `lex`/literal queries too short
for the trigram index, and as the fallback when the FTS sidecar is missing
or does not cover the requested channels) and `grep-session` (always) shell
out to the [`rg`](https://github.com/BurntSushi/ripgrep) CLI over the
filesystem export tree. Unlike the multi-scope fan-out `ck` used to require,
a single `rg` invocation accepts every scope path at once.

`rg` is required (not optional) whenever the query planner picks it as the
**primary** backend. When that happens and `rg` is not installed or not
resolvable, `planSearch()` throws a structured `RG_NOT_FOUND` error rather
than silently falling back to `ck` (the old behavior, which then timed out
over the full export tree and returned nothing). The tool returns
`{ ok: false, error: { code: "RG_NOT_FOUND" } }` for that call. Availability
is a real probe, not an assumption: `rgAvailable()` checks that the resolved
path is a regular, executable file (POSIX `X_OK`), so a present-but-not-
executable binary (or one that fails to spawn for another reason, e.g. it
isn't a valid executable) is classified `RG_FAILED` rather than silently
returning an empty successful result. `grep-session` has no other backend at
all, so a missing or broken `rg` is a hard failure for every `grep-session`
call. Queries that don't need `rg` — a literal/`lex` query the FTS sidecar
can serve, or a `sem`/`hybrid` query served by `ck` — are unaffected. Install
ripgrep with `brew install ripgrep` (macOS), `apt install ripgrep`
(Debian/Ubuntu), or `cargo install ripgrep`; override the binary path via
`OPENCODE_SESSIONS_EXPLORER_RG_BIN`.

### L3b — ck Index (Optional, `sem`/`hybrid` Only)

`search-text` shells out to the [`ck`](https://github.com/BeaconBay/ck) CLI
only for `sem` and `hybrid` modes — the only modes that need embeddings. `ck`
is optional: when it is absent, only `sem`/`hybrid` `search-text` calls return
`CK_NOT_FOUND`; every other search path (literal, `lex`, regex, and
`grep-session` entirely) works without it. The index lives under `.ck/` in the
export root and is incremental; the plugin invokes normal `sem`/`hybrid`
searches and lets `ck` perform its own lazy index build/refresh, so explicit
index commands are optional prewarm or troubleshooting steps, not a
prerequisite for first use.

An unscoped (`scopeIds === "all"`) `sem`/`hybrid` query whose resolved
channels explicitly include `raw` — i.e. `surface:'forensics'` or an
explicit `channels:['raw']` with no `session_ids`/`project_id`/`agent`/
`since_ms`/`until_ms` filter — is refused with `BAD_ARGS` naming the reason
(the full `by-session` replay tree is hundreds of thousands of files and
`ck` times out over it — see the measured numbers in
[The Query Planner](#the-query-planner-fts--rg--ck) above) and the remedy:
scope the query, use a curated surface instead of
`forensics`/`raw`, or use `mode:'regex'` (served by ripgrep).

That first check inspects the requested channels. A second guard runs after
scope resolution, inside the backend runner: if an unscoped `sem`/`hybrid`
run resolves onto the raw `by-session` root (or the export root) — which
happens when the curated channel export is still partial and scope
resolution falls back to the raw tree — it is refused with the same
`BAD_ARGS` error. The partial-export warning is still emitted, so the
indirect route is covered as well as the explicit one.

## The Query Planner (fts / rg / ck)

`src/lib/query-plan.ts` is a pure function, `planSearch()`, with no I/O: every
environment fact (index availability, channel coverage, ripgrep availability)
is passed in as an argument. It decides:

- `sem`/`hybrid` mode -> always `ck` (the only embedding engine).
- `lex` mode -> always treated as text, never as a regex, regardless of
  metacharacters in the query. If the FTS index covers the requested
  channels -> `fts` (BM25), with `rg` as the fallback on zero hits. If the
  index is missing or does not cover the requested channels -> `rg` directly,
  as a fixed-string match (not a live regex) — this is the fix for `lex`
  queries like `v1.2.3`, `C++`, or `*` that used to be silently reinterpreted
  as regular expressions.
- `regex` mode, real regex pattern (contains a regex metacharacter and not
  `fixed_string:true`) -> always `rg`. The FTS index cannot evaluate regular
  expressions, so it is never a candidate here.
- `regex` mode, literal pattern (no metacharacters, or `fixed_string:true`)
  with a usable 3+ character trigram run, whose channels are fully covered by
  the FTS index -> `fts`, with `rg` as the one fallback if `fts` returns zero
  hits.
- `regex` mode, literal pattern with no usable 3+ character trigram run (see
  [above](#l2a--fts5-sidecar-fast-tier)), or when the FTS index is missing or
  does not cover the requested channels -> `rg` directly.

`ck` is **never** a fallback for literal or regex queries: `rg` and `ck` read
the exact same filesystem export tree, so an exhaustive `rg` pass that found
nothing proves `ck` has no additional corpus or capability to find more.
Escalating to it there would add latency with zero recall benefit — this is
why the `raw` channel and any unscoped forensic sweep are routed to `rg`, not
`ck` (measured: `ck` timed out at 30-34s returning zero rows over 328,069 raw
files, versus 6.2s for `rg` over the same tree).

Escalation to a fallback backend only fires when the primary backend returns
**zero** hits, and only within the caller's `timeout_ms` budget. `search-text`
surfaces which backend actually produced results via `backend`,
`backends_tried`, and `plan_reason` in its response (see
[tools.md](tools.md)). A query the planner routes to `rg` as its primary
backend has no fallback of its own: if `rg` is unavailable, `planSearch()`
throws `RG_NOT_FOUND` instead (see [L3a](#l3a--ripgrep-exhaustive-tier)
above) rather than adding `ck` as a fallback there.

### FTS Coverage Limitations

The FTS sidecar's substring/`lex` search is not a strict superset of what
ripgrep can find. Three concrete gaps, all real and by design (not bugs to
report):

- **`tool-output` excerpting** (see below) means the middle of the largest
  ~33,000 `tool-output` documents is absent from the index. Escalation to
  `rg` only fires when the fast tier returns **zero** hits for the whole
  query — so a term that appears once in an indexed excerpt and once in an
  omitted middle returns only the indexed occurrence; the omitted occurrence
  is not surfaced by that search, though the content itself remains readable
  via `get-part` and findable via an explicit `rg`-routed search (e.g.
  `surface:'forensics'`).
- **ASCII-only case folding** in the trigram (`docs_sub`) table (see
  [L2a](#l2a--fts5-sidecar-fast-tier) above): a non-ASCII case-fold match that
  ripgrep's Unicode-aware `-i` would find can be missed by the fast tier.
- **Substring-table subset**: a channel excluded from
  `OPENCODE_SESSIONS_EXPLORER_FTS_SUBSTRING_CHANNELS` is indexed into the
  BM25 (`docs_lex`) table but not the substring (`docs_sub`) table, so it is
  `lex`-searchable but not literal-searchable via `fts` — a literal query
  scoped to such a channel does not cover it and routes to `rg` instead (per
  the planner rules above).

### Partial Index And Dead Letters

Completeness is **drain-based**, not budget-based: a sync marks the index
`complete` as soon as it has drained the entire source `part` table with no
unresolved ("hot") failures, regardless of whether that particular run had a
`--budget-ms` time budget. A budgeted run that happens to finish before its
budget expires is complete; a budgeted OR unbudgeted run that stops with the
source not yet drained, or with an unresolved failure, is not. Once an index
has been marked complete, a later budget-stopped delta-sync does not demote
it back to incomplete — only a genuinely unresolved (retriable) failure, or
a `--reset`/schema-version rebuild, clears completeness. `ftsUsable()` (the
completeness-aware check the query planner uses via its `ftsAvailable`
input) returns `false` for an incomplete index, and
`opencode-sessions-explorer-fts-build` prints a loud `PARTIAL` warning
naming the reason and the exact re-run command when a run ends incomplete.
Literal/`lex` search does not trust an incomplete index as authoritative —
it falls back to `rg` instead of silently returning a truncated result set.

Freshness ("how far behind the live source is the indexed cursor right
now?") is a **separate, informational** property from completeness and
never gates the fast tier: `db-stats`'s `at_source` / `lag_ms` fields (see
below) tell you how stale the index is, but even a lagging-but-complete
index is still used as authoritative — gating on "caught up to source"
would be unsatisfiable on any actively-written database, since OpenCode
writes new parts continuously.

A part whose document build throws is retried up to 5 times before being
moved to a **dead-letter** set. Dead-lettered parts do not block
completeness (the build can still finish and be marked complete), but they
mean the index is permanently missing that part's content until the
underlying part changes and the next sync retries it. A missing or corrupt
sidecar table (`docs_sub`, `docs_lex`, or `doc_map`) forces a full rebuild
of the whole coupled set and clears completeness/cursor/failure state, so a
damaged index reports as not-built rather than silently serving as
authoritative with missing content.

`db-stats`'s `fts` section reports all of this: `complete`, `at_source`,
`lag_ms`, `failed_parts`, `dead_letters`, and `case_folding_ascii_only`,
alongside `present`, `docs`, `bytes`, `channels`, `cursor`, and `last_error`
(see [tools.md](tools.md) for the exact field names). `check-deps`'s
`FTS sidecar` line, by contrast, still reports only presence/doc-count/
bytes/channels/cursor/last-error — it does not yet surface completeness or
failure counts, so `db-stats` (or `fts-build`'s own console output) is the
way to check completeness today.

### The `tool-output` Excerpt Trade-Off

`tool-output` is the one channel big enough to need excerpting: at full size
it is roughly 876 MB across 168,261 documents (about 76% of all indexed text,
averaging 5.3 KB per document). The FTS sidecar indexes it as a 4 KB head + 4
KB tail excerpt with a marker naming the `get-part` call to fetch the full
body. About 135,000 of those 168,261 documents fit entirely within 8 KB and
are indexed in full; only the middle of the largest ~33,000 documents is
outside the fast index. Those middles are always readable via `get-part`,
and always findable by a query that reaches the `rg` tier — either directly
(non-literal, too-short-for-the-trigram, or index-unavailable queries) or via
the `fts -> rg` zero-hit escalation described above. As noted in
[FTS Coverage Limitations](#fts-coverage-limitations), a query that already
gets at least one hit from the indexed excerpt does not escalate, so an
occurrence that exists only in an omitted middle is not guaranteed to surface
alongside a hit the excerpt itself already satisfied.

### L4 — Enriched Response

Every backend hands back a backend-neutral hit shape before this layer runs.
`rg` and `ck` hits carry file paths (parsed for session/part ids); `fts` hits
already carry `session_id`/`part_id` columns directly from the sidecar. Either
way, this final layer re-fetches fresh metadata from SQLite (session title,
agent, model, part type, message role) before returning results, so the
response shape is identical regardless of which backend served the query.
Every tool wraps its payload in a uniform `{ ok, data, meta, warnings }`
envelope; list-shaped data inside `data` uses the compact format described in
[response-format.md](response-format.md).

## Single-Writer Exception

The plugin is read-only with exactly one sanctioned write: `unarchive-session`.
Reads never write through the shared read-only handle. The write goes through a
separate, short-lived read-write connection that performs a single statement —
`UPDATE session SET time_archived = NULL, time_updated = <now>` — and closes
immediately.

Both fields are updated deliberately. OpenCode loads sessions ordered by
`time_updated DESC` with a default limit per directory, so clearing `time_archived`
alone would leave a long-archived session buried below that window, and opening it
would fail with "Unable to retrieve session". Refreshing `time_updated` resurfaces
the session at the top of the list, which is also the intuitive meaning of
"restore". OpenCode exposes no HTTP or SDK endpoint that can *clear* the archived
flag, so the direct database write is the only mechanism.

## Examples

Materialize the export tree (L2b) and build the FTS sidecar (L2a), then
optionally prewarm the `ck` index (L3b):

```bash
bunx opencode-sessions-explorer-bulk-export
bunx opencode-sessions-explorer-fts-build
cd ~/.local/share/opencode-sessions-explorer
ck --index .   # optional prewarm from the export root; sem/hybrid only
```

Verify every layer is healthy, including ripgrep and the FTS sidecar:

```bash
bunx opencode-sessions-explorer-check-deps
```

## Related Docs

- Tool catalog: [tools.md](tools.md)
- Search surfaces and channels: [search-surfaces.md](search-surfaces.md)
- Compact result format: [response-format.md](response-format.md)
- Configuration and environment overrides: [configuration.md](configuration.md)
- Export and maintenance workflow: [../guides/export-and-maintenance.md](../guides/export-and-maintenance.md)
- Development Guide: [../maintainers/development.md](../maintainers/development.md)
- Troubleshooting: [../support/troubleshooting.md](../support/troubleshooting.md)
