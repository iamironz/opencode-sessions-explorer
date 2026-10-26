/**
 * Tool-name aliases across the OpenCode V1 → V2 tool rename.
 *
 * Verified from live data (`session_message.data.content[]` tool items,
 * `$.name`, checked 2026-10-23): imported V1-era history records `bash` and
 * `task`; V2-live rows (after the migration) record `shell` and `subagent`
 * instead. Without aliasing, a `tool:'bash'` filter silently misses every
 * post-migration call, and per-tool counts split one logical tool across two
 * buckets.
 *
 * Each group lists every recorded spelling of ONE logical tool; the LAST entry
 * is the canonical (V2) name. This table is the single source of truth for the
 * TS helpers AND the generated SQL CASE expression.
 *
 * Rules applied by the tools:
 * - exact `tool` filters expand to the whole group (`IN (…)`);
 * - LIKE patterns are NOT expanded (they match the raw recorded name);
 * - aggregations/counts group by the canonical name;
 * - rows listing individual calls keep the raw recorded name (fidelity).
 */
export const TOOL_ALIAS_GROUPS: readonly (readonly [string, ...string[]])[] = [
  ["bash", "shell"],
  ["task", "subagent"],
]

const GROUP_BY_NAME: ReadonlyMap<string, readonly string[]> = new Map(
  TOOL_ALIAS_GROUPS.flatMap((group) => group.map((name) => [name, group] as const)),
)

/** Every recorded spelling of `name`'s logical tool (or just `[name]`). */
export function expandToolName(name: string): string[] {
  return [...(GROUP_BY_NAME.get(name) ?? [name])]
}

/** Canonical (V2) name for `name` — e.g. `bash` → `shell`, `task` → `subagent`. */
export function canonicalToolName(name: string): string {
  const group = GROUP_BY_NAME.get(name)
  return group ? group[group.length - 1]! : name
}

/**
 * SQL expression mapping `nameExpr` (e.g. `json_extract(je.value,'$.name')`)
 * to its canonical tool name; names outside every alias group pass through.
 * Generated from TOOL_ALIAS_GROUPS (constant names — safe to inline).
 */
export function canonicalToolNameSql(nameExpr: string): string {
  const whens = TOOL_ALIAS_GROUPS.flatMap((group) => {
    const canonical = group[group.length - 1]!
    return group
      .filter((name) => name !== canonical)
      .map((name) => `WHEN ${sqlString(name)} THEN ${sqlString(canonical)}`)
  })
  return `(CASE ${nameExpr} ${whens.join(" ")} ELSE ${nameExpr} END)`
}

/**
 * WHERE fragment for a user-supplied `tool` filter: a SQL LIKE over the raw
 * recorded name when it contains `%` or `_` (unchanged semantics), otherwise
 * an exact match over the whole alias group.
 */
export function toolNameFilter(nameExpr: string, tool: string): { sql: string; params: string[] } {
  if (/[%_]/.test(tool)) return { sql: `${nameExpr} LIKE ?`, params: [tool] }
  const names = expandToolName(tool)
  if (names.length === 1) return { sql: `${nameExpr} = ?`, params: names }
  return { sql: `${nameExpr} IN (${names.map(() => "?").join(", ")})`, params: names }
}

/** Property description shared by the `tool` filter args (search-tool-calls, list-tool-failures). */
export const TOOL_FILTER_ALIAS_NOTE =
  `Exact names match across the OpenCode V1→V2 tool rename: ${TOOL_ALIAS_GROUPS.map((g) => g.map((n) => `'${n}'`).join("/")).join(" and ")} are matched together (LIKE patterns match the raw recorded name only). ` +
  "MCP calls made after the V2 migration are recorded as 'execute' (Code Mode), not under their MCP tool names."

/** Note for aggregations: alias groups merge into one bucket named by the canonical V2 name. */
export const TOOL_GROUP_ALIAS_NOTE =
  `Per-tool aggregates merge each alias group into one bucket under the canonical V2 name (${TOOL_ALIAS_GROUPS.map((g) => `'${g[g.length - 1]}'`).join(", ")}).`

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}
