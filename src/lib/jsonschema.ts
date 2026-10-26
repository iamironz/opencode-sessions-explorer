/**
 * Plain JSON Schema helpers for the OpenCode V2 plugin tool API.
 *
 * V2 tool args are declared as JSON Schema (`input`), not zod. The V1 plugin
 * relied on zod `.default()` to materialize default argument values before
 * `execute()` ran; the V2 host does not guarantee default application, so
 * `withDefaults()` reproduces that behavior locally.
 *
 * Unknown keys are preserved (not stripped) so tools can keep their explicit
 * "reject unknown argument" checks (e.g. `mode` on search-text/grep-session).
 */

/** Structural JSON Schema (matches effect's JsonSchema: an open record). */
export type JsonSchema = { [key: string]: unknown }

/** A root object schema describing a tool's arguments. */
export type ToolArgsSchema = JsonSchema & {
  type: "object"
  properties?: Record<string, JsonSchema>
  required?: string[]
}

/** One argument problem, phrased for the calling model (path + human message). */
export type ArgIssue = { path: string; message: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

function typeOfValue(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number"
  return typeof v
}

function show(v: unknown): string {
  const s = JSON.stringify(v)
  if (s === undefined) return String(v)
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]!
}

/** Closest option for a typo ("sessionId" → "session_id", "reasning" → "reasoning"). */
function suggest(value: string, options: readonly string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "")
  const v = norm(value)
  let best: string | null = null
  let bestD = Infinity
  for (const o of options) {
    const d = norm(o) === v ? 0 : editDistance(v, norm(o))
    if (d < bestD) { bestD = d; best = o }
  }
  return best !== null && bestD <= Math.max(2, Math.floor(value.length / 4)) ? best : null
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function rangeText(s: JsonSchema): string | null {
  const min = typeof s.minimum === "number" ? s.minimum : undefined
  const max = typeof s.maximum === "number" ? s.maximum : undefined
  if (min !== undefined && max !== undefined) return `${min}..${max}`
  if (min !== undefined) return `>= ${min}`
  if (max !== undefined) return `<= ${max}`
  return null
}

function checkType(s: JsonSchema, value: unknown, path: string, issues: ArgIssue[]): boolean {
  if (s.type === undefined) return true
  const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[]
  const actual = typeOfValue(value)
  const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"))
  if (!ok) issues.push({ path, message: `expected ${types.join(" | ")}, got ${actual} ${show(value)}` })
  return ok
}

function validateValue(s: JsonSchema, value: unknown, path: string, issues: ArgIssue[]): void {
  if (!checkType(s, value, path, issues)) return
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) {
    const hit = typeof value === "string" ? suggest(value, s.enum.filter((e): e is string => typeof e === "string")) : null
    issues.push({
      path,
      message: `got ${show(value)}; allowed: ${s.enum.map(show).join(" | ")}${hit ? ` (did you mean ${show(hit)}?)` : ""}`,
    })
  }
  if (typeof value === "number") {
    const tooLow = typeof s.minimum === "number" && value < s.minimum
    const tooHigh = typeof s.maximum === "number" && value > s.maximum
    if (tooLow || tooHigh) issues.push({ path, message: `got ${value}; must be ${rangeText(s)}` })
  }
  if (Array.isArray(value) && isPlainObject(s.items)) {
    value.forEach((item, i) => validateValue(s.items as JsonSchema, item, `${path}[${i}]`, issues))
  }
  if (isPlainObject(value) && isPlainObject(s.properties)) {
    validateObject(s, value, path, issues, undefined)
  }
}

function validateObject(
  s: JsonSchema,
  obj: Record<string, unknown>,
  path: string,
  issues: ArgIssue[],
  removed: Record<string, string> | undefined,
): void {
  const props = (isPlainObject(s.properties) ? s.properties : {}) as Record<string, JsonSchema>
  const allowed = Object.keys(props)
  const required = Array.isArray(s.required) ? (s.required as string[]) : []
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) {
      issues.push({ path: joinPath(path, key), message: `missing required parameter (${typeText(props[key] ?? {})})` })
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue // optional null == absent
    const prop = props[key]
    if (!prop) {
      if (s.additionalProperties === false) {
        const hint = removed?.[key]
        const hit = hint ? null : suggest(key, allowed)
        issues.push({
          path: joinPath(path, key),
          message: hint ?? `unknown parameter${hit ? ` (did you mean "${hit}"?)` : ""}; allowed parameters: ${allowed.join(", ")}`,
        })
      }
      continue
    }
    validateValue(prop, value, joinPath(path, key), issues)
  }
}

function typeText(s: JsonSchema): string {
  if (Array.isArray(s.enum)) return s.enum.map(show).join(" | ")
  if (s.type === "array" && isPlainObject(s.items)) return `array of ${typeText(s.items as JsonSchema)}`
  const t = Array.isArray(s.type) ? (s.type as string[]).join(" | ") : String(s.type ?? "any")
  const range = rangeText(s)
  return range ? `${t} ${range}` : t
}

/**
 * Validate raw tool input against the tool's root args schema. Unknown keys are
 * rejected (root is treated as `additionalProperties: false`); `null` on an
 * optional parameter counts as absent. Collects ALL problems, not just the first.
 * `removed` maps retired parameter names to a specific explanation.
 */
export function validateArgs(
  schema: ToolArgsSchema,
  input: unknown,
  removed?: Record<string, string>,
): ArgIssue[] {
  const src = input === undefined || input === null ? {} : input
  if (!isPlainObject(src)) {
    return [{ path: "(arguments)", message: `expected an object of named parameters, got ${typeOfValue(src)}` }]
  }
  const issues: ArgIssue[] = []
  validateObject({ ...schema, additionalProperties: false }, src, "", issues, removed)
  return issues
}

/** Compact one-line signature of every parameter (for error hints). `*` = required. */
export function describeArgs(schema: ToolArgsSchema): string {
  const props = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const parts = Object.entries(props).map(([key, prop]) => {
    const def = prop && "default" in prop ? ` (default ${show((prop as { default: unknown }).default)})` : ""
    return `${key}${required.has(key) ? "*" : ""}: ${typeText(prop)}${def}`
  })
  return parts.length ? parts.join("; ") : "(no parameters)"
}

/** Drop `null`/`undefined` values so optional nulls behave exactly like omission. */
export function stripNulls(input: unknown): Record<string, unknown> {
  const src = (isPlainObject(input) ? input : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) if (v !== null && v !== undefined) out[k] = v
  return out
}

/**
 * Apply `default` values from the schema's top-level properties to `input`.
 * Missing/absent input is treated as `{}`. Values already present are kept.
 */
export function withDefaults(schema: ToolArgsSchema, input: unknown): Record<string, unknown> {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const out: Record<string, unknown> = { ...src }
  const props = schema.properties ?? {}
  for (const [key, prop] of Object.entries(props)) {
    if (out[key] === undefined && prop && typeof prop === "object" && "default" in prop) {
      out[key] = (prop as { default: unknown }).default
    }
  }
  return out
}
