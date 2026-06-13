# Response Format Reference

## Scope

This page documents the compact, lossless format that list-shaped tool results use.
Several tools return arrays of uniform records (sessions, events, tool calls, cost
groups, search hits). Serializing those as plain arrays-of-objects repeats every
JSON key on every row and re-serializes the same nested values (model, directory,
agent) again and again. To cut payload size without losing information, list results
are encoded as a columnar table with string interning.

Scalar, single-object responses (for example `get-session` or `db-stats`) are
returned as ordinary JSON objects and are **not** encoded this way.

## The Table Shape

An encoded list result is an object with three keys:

```json
{
  "cols": ["id", "title", "agent", "model"],
  "dict": {
    "agent": ["build", "executor-gpt"],
    "model": [{ "id": "claude-opus", "provider": "anthropic" }]
  },
  "rows": [
    ["ses_a1", "Fix retry bug", 0, 0],
    ["ses_b2", "Cost audit", 1, 0]
  ]
}
```

- `cols` — the column order; each row is an array of cells in this order.
- `dict` — interning tables for selected columns. A column listed here stores its
  distinct values once; rows reference them by integer index. Columns absent from
  `dict` store their literal value inline.
- `rows` — one array per record.

## Decode Rule

There is a single decode rule:

> A cell in a column whose name is a key in `dict` is an integer index into
> `dict[col]`. Otherwise the cell is its literal value.

Decoding the example above yields:

```json
[
  { "id": "ses_a1", "title": "Fix retry bug", "agent": "build", "model": { "id": "claude-opus", "provider": "anthropic" } },
  { "id": "ses_b2", "title": "Cost audit", "agent": "executor-gpt", "model": { "id": "claude-opus", "provider": "anthropic" } }
]
```

Note that both rows reuse the same `model` object (index `0`) instead of repeating
it — that is where the savings come from on large result sets.

## Reference Decoder

The plugin ships the inverse function, `decodeTable()`, in
[`src/lib/table.ts`](../../src/lib/table.ts). It is used by the test suite and is
safe for consumers to copy. Two behaviors make migration painless:

- A plain array passed to `decodeTable()` is returned unchanged, so callers can
  treat encoded and unencoded results uniformly.
- An out-of-range or non-integer cell in a `dict` column is passed through as its
  literal value rather than throwing.

A minimal equivalent decoder:

```ts
function decodeTable(t) {
  if (t == null) return []
  if (Array.isArray(t)) return t // already plain
  const dict = t.dict ?? {}
  return t.rows.map((row) => {
    const o = {}
    t.cols.forEach((c, i) => {
      const v = row[i]
      const d = dict[c]
      o[c] = d && typeof v === "number" && v >= 0 && v < d.length ? d[v] : v
    })
    return o
  })
}
```

## Examples

A `list-sessions` result interns the repetitive `agent`, `model`, `directory`, and
`project_id` columns:

```json
{
  "sessions": {
    "cols": ["id", "title", "agent", "model", "directory", "cost"],
    "dict": {
      "agent": ["build"],
      "model": [{ "id": "claude-opus" }],
      "directory": ["/projects/app"],
      "project_id": []
    },
    "rows": [
      ["ses_a1", "Fix retry bug", 0, 0, 0, 0.42]
    ]
  },
  "has_more": false
}
```

Apply the decode rule to recover the records, then read `cost` (a literal column)
directly.

## Related Docs

- Tool catalog: [tools.md](tools.md)
- Search surfaces and channels: [search-surfaces.md](search-surfaces.md)
- Four-layer architecture: [architecture.md](architecture.md)
- Configuration and environment overrides: [configuration.md](configuration.md)
- Troubleshooting: [../support/troubleshooting.md](../support/troubleshooting.md)
