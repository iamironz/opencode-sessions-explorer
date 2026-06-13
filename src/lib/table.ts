/**
 * Columnar + interning result codec.
 *
 * List-shaped tool results are the dominant token cost: array-of-objects repeats
 * every JSON key once per row (22-34% of payload) and re-serializes repeated
 * nested objects/strings (model, directory, agent) per row.
 *
 * `table()` converts an array of uniform records into a compact, LOSSLESS shape:
 *
 *   {
 *     cols: ["id","title","agent","model", ...],
 *     dict: { agent: ["build","executor-gpt"], model: [ {...} ] },
 *     rows: [ ["ses_…","Title",0,0, ...] ]
 *   }
 *
 * Decode rule (single, simple): a cell in a column whose name is a key in `dict`
 * is an integer index into `dict[col]`; otherwise it is the literal value.
 *
 * `decodeTable()` is the inverse and is shipped for consumers + used by tests.
 * It passes plain arrays through unchanged so callers can treat either shape
 * uniformly during a migration.
 */

export type Table = {
  cols: string[]
  dict: Record<string, unknown[]>
  rows: unknown[][]
}

export type TableOptions = {
  /** Explicit column order. Defaults to the keys of the first record. */
  cols?: string[]
  /** Columns whose values should be interned into `dict` and replaced by an index. */
  dict?: string[]
}

/** Build a columnar+interned table from an array of uniform records. */
export function table(records: Record<string, unknown>[], opts: TableOptions = {}): Table {
  const cols = opts.cols ?? (records.length ? Object.keys(records[0]!) : [])
  const dictCols = new Set(opts.dict ?? [])

  const dict: Record<string, unknown[]> = {}
  const dictIndex: Record<string, Map<string, number>> = {}
  for (const c of dictCols) { dict[c] = []; dictIndex[c] = new Map() }

  const intern = (col: string, val: unknown): number => {
    const key = stableKey(val)
    const m = dictIndex[col]!
    let i = m.get(key)
    if (i === undefined) {
      i = dict[col]!.push(val ?? null) - 1
      m.set(key, i)
    }
    return i
  }

  const rows = records.map((r) =>
    cols.map((c) => {
      const v = r[c]
      if (dictCols.has(c)) return intern(c, v)
      return v === undefined ? null : v
    }),
  )

  // Drop dictionaries that ended up empty (column absent / all undefined).
  for (const c of Object.keys(dict)) if (dict[c]!.length === 0) delete dict[c]

  return { cols, dict, rows }
}

/** Inverse of `table()`. Plain arrays pass through unchanged. */
export function decodeTable<T = Record<string, unknown>>(t: Table | T[] | null | undefined): T[] {
  if (t == null) return []
  if (Array.isArray(t)) return t
  const tbl = t as Table
  if (!Array.isArray(tbl.cols) || !Array.isArray(tbl.rows)) return []
  const dict = tbl.dict ?? {}
  return tbl.rows.map((row) => {
    const o: Record<string, unknown> = {}
    tbl.cols.forEach((c, i) => {
      const v = row[i]
      const d = dict[c]
      o[c] = d && typeof v === "number" && v >= 0 && v < d.length ? d[v] : v
    })
    return o as T
  })
}

/** True if a value looks like an encoded table (vs a plain array). */
export function isTable(v: unknown): v is Table {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    Array.isArray((v as any).cols) && Array.isArray((v as any).rows)
}

function stableKey(val: unknown): string {
  if (val === undefined || val === null) return "\u0000null"
  if (typeof val === "object") {
    try { return "o" + JSON.stringify(val) } catch { return "o?" }
  }
  return typeof val + ":" + String(val)
}
