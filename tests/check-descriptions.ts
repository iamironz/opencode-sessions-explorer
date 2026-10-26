/**
 * Forward-looking guard for the LLM-facing tool surface (descriptions route
 * the LLM to tools, so they must not advertise things that cannot exist).
 *
 * (a) No tool description, input enum, or property description advertises a
 *     part type / channel the V2 adapter never produces (`file`, `patch`,
 *     `subtask`, `step-start`, `step-finish`, `patch-summary`) or legacy V1
 *     `prt_` part ids. The V2 adapter (src/lib/v2-parts.ts messageToParts)
 *     only yields text / reasoning / tool / compaction parts.
 * (b) Tool names are unchanged: exactly the 18 registered names below.
 *
 * Run: bun tests/check-descriptions.ts   (exit 0 = clean, 1 = violations)
 */
const { tools } = await import("../src/tools/index.ts")

const EXPECTED_NAMES = [
  "opencode-sessions-explorer-cost-by-period",
  "opencode-sessions-explorer-cost-by-project",
  "opencode-sessions-explorer-current-session",
  "opencode-sessions-explorer-db-stats",
  "opencode-sessions-explorer-get-message",
  "opencode-sessions-explorer-get-part",
  "opencode-sessions-explorer-get-session",
  "opencode-sessions-explorer-grep-session",
  "opencode-sessions-explorer-list-repeated-prompts",
  "opencode-sessions-explorer-list-sessions",
  "opencode-sessions-explorer-list-tool-failures",
  "opencode-sessions-explorer-search-sessions-meta",
  "opencode-sessions-explorer-search-text",
  "opencode-sessions-explorer-search-tool-calls",
  "opencode-sessions-explorer-session-genealogy",
  "opencode-sessions-explorer-session-summary",
  "opencode-sessions-explorer-session-timeline",
  "opencode-sessions-explorer-unarchive-session",
] as const

/** Removed part types / channels — must never appear as an enum value. */
const REMOVED_VALUES = new Set(["file", "patch", "subtask", "step-start", "step-finish", "patch-summary"])

/**
 * Free-text patterns that advertise a removed type/channel or a legacy id.
 * `file`/`patch` are ordinary English words, so they are only flagged in
 * type-advertising positions (quoted, slash-lists, `[patch …]` summaries,
 * "patch parts", "file references", "patches"). `apply_patch` (a tool name)
 * is not matched: `\b` never falls between `_` and `p`.
 */
const FORBIDDEN_TEXT: { label: string; re: RegExp }[] = [
  { label: "prt_ id", re: /prt_/ },
  { label: "subtask", re: /\bsubtasks?\b/i },
  { label: "step-start/step-finish", re: /\bstep-(?:start|finish)\b/i },
  { label: "patch-summary", re: /\bpatch-summary\b/i },
  { label: "quoted file/patch type", re: /[`'"](?:file|patch)[`'"]/i },
  { label: "file/patch in a type slash-list", re: /(?:^|[\s(/])(?:file|patch)\/|\/(?:file|patch)\b(?![./-])/i },
  { label: "[file|patch …] summary", re: /\[(?:file|patch)\b/i },
  { label: "file/patch parts/references/events", re: /\b(?:file|patch)\s+(?:parts?|references?|events?|channels?|markers?)\b/i },
  { label: "patches (as a body kind)", re: /\bpatches\b/i },
]

type ToolLike = { name?: unknown; description?: unknown; args?: unknown }
const problems: string[] = []

// (b) tool names unchanged
const registered = Object.keys(tools).sort()
const expected = [...EXPECTED_NAMES].sort()
if (registered.length !== 18 || JSON.stringify(registered) !== JSON.stringify(expected)) {
  const missing = expected.filter((n) => !registered.includes(n))
  const extra = registered.filter((n) => !(expected as string[]).includes(n))
  problems.push(`tool registry drift: ${registered.length} tools; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`)
}
for (const [key, def] of Object.entries(tools as Record<string, ToolLike>)) {
  if (def?.name !== key) problems.push(`${key}: registry key != tool name (${String(def?.name)})`)
}

// (a) descriptions + enums + property descriptions
function checkText(where: string, text: string): void {
  for (const { label, re } of FORBIDDEN_TEXT) {
    const m = re.exec(text)
    if (m) problems.push(`${where}: advertises ${label} — …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`)
  }
}

function walkSchema(where: string, node: unknown): void {
  if (!node || typeof node !== "object") return
  const n = node as Record<string, unknown>
  if (typeof n.description === "string") checkText(`${where}.description`, n.description)
  if (Array.isArray(n.enum)) {
    for (const v of n.enum) {
      if (typeof v !== "string") continue
      if (REMOVED_VALUES.has(v)) problems.push(`${where}.enum: contains removed value '${v}'`)
      if (v.includes("prt_")) problems.push(`${where}.enum: contains legacy prt_ value '${v}'`)
    }
  }
  if (n.properties && typeof n.properties === "object") {
    for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) walkSchema(`${where}.${k}`, v)
  }
  if (n.items) walkSchema(`${where}[]`, n.items)
  for (const combo of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(n[combo])) (n[combo] as unknown[]).forEach((s, i) => walkSchema(`${where}.${combo}[${i}]`, s))
  }
}

let checked = 0
for (const [key, def] of Object.entries(tools as Record<string, ToolLike>)) {
  const short = key.replace("opencode-sessions-explorer-", "")
  if (typeof def?.description !== "string" || !def.description) {
    problems.push(`${short}: missing description`)
  } else {
    checkText(`${short}.description`, def.description)
  }
  walkSchema(`${short}.args`, def?.args)
  checked++
}

if (problems.length === 0) {
  console.log(`ok: ${checked} tools — names unchanged; no removed part types/channels or prt_ ids advertised`)
  process.exit(0)
}
for (const p of problems) console.error(`FAIL ${p}`)
console.error(`\n${problems.length} problem(s)`)
process.exit(1)
