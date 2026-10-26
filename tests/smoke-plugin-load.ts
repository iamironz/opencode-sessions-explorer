/**
 * Plugin-load smoke test: simulates the OpenCode V2 host wiring — imports the
 * directory entry (index.ts), runs Plugin.define's setup with a minimal Context,
 * captures what editor.add registered, and executes one tool end-to-end.
 * Run: bun tests/smoke-plugin-load.ts (hermetic fixture via ./setup.ts)
 */
import "./setup.ts"

type AddedTool = { name: string; description: string; input: any; execute: (i: any, c: any) => Promise<any> }

const added: AddedTool[] = []
const hostCtx = {
  location: { directory: "/home/iamironz" },
  tool: {
    transform: async (cb: (editor: any) => void) => {
      cb({
        add: (t: AddedTool) => added.push(t),
        list: () => added,
        get: () => undefined,
        namespace: () => {},
        update: () => {},
        remove: () => {},
      })
      return { dispose: async () => {} }
    },
  },
}

const mod = await import("../index.ts")
const plugin = (mod as any).default as { id: string; setup: (ctx: any) => Promise<void> }
if (!plugin || typeof plugin.setup !== "function") throw new Error("default export is not a Plugin.define result")
await plugin.setup(hostCtx)

const expected = [
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
]
const names = added.map((t) => t.name)
const missing = expected.filter((n) => !names.includes(n))
const extra = names.filter((n) => !expected.includes(n))
if (missing.length || extra.length) throw new Error(`tool set mismatch: missing=${missing} extra=${extra}`)
for (const t of added) {
  if (typeof t.description !== "string" || t.description.length < 100) throw new Error(`bad description on ${t.name}`)
  if (!t.input || t.input.type !== "object") throw new Error(`bad input schema on ${t.name}`)
}

// Execute one tool through the registered (host-shaped) definition.
const dbStats = added.find((t) => t.name === "opencode-sessions-explorer-db-stats")!
const result = await dbStats.execute({}, { sessionID: "smoke", messageID: "smoke", agent: "smoke" })
const env = JSON.parse(result.content)
if (env.ok !== true || env.function !== "db_stats" || !env.data.table_counts["session_v2"]) {
  throw new Error(`db_stats smoke failed: ${result.content.slice(0, 200)}`)
}
const cur = added.find((t) => t.name === "opencode-sessions-explorer-current-session")!
const curEnv = JSON.parse((await cur.execute({}, { sessionID: "smoke-session", agent: "build" })).content)
if (curEnv.data.context.directory !== "/home/iamironz") throw new Error("host directory not captured")

console.log(`OK: plugin id=${plugin.id}; ${added.length} tools registered; db_stats + current-session smoke passed`)
