#!/usr/bin/env bun
/**
 * mcp — MCP stdio entry point.
 *
 * Second entry point beside `src/plugin.ts`. The plugin hands the tools to the
 * OpenCode V2 host; this file serves the same tools over the Model Context
 * Protocol on stdin/stdout so a NON-OpenCode host (any MCP client) can call
 * them.
 *
 * `src/tools/index.ts` stays the single source of truth — this file only filters,
 * renames, and adapts. It does not define or duplicate any tool. V2 tool args
 * are already plain JSON Schema, so they are passed to MCP as-is.
 *
 * Usage (host config):
 *   command: bun
 *   args: ["run", "/absolute/path/to/opencode-sessions-explorer/dist/mcp.js"]
 *
 * stdout is reserved for JSON-RPC framing: never `console.log` from this process.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { version } from "../package.json"
import { tools } from "./tools/index.js"

const SERVER_NAME = "opencode-sessions-explorer"

/**
 * Registry keys are namespaced for OpenCode's flat tool space. An MCP host
 * namespaces by server, so the prefix is stripped here:
 * `opencode-sessions-explorer-list-sessions` -> `list-sessions`.
 */
const TOOL_PREFIX = "opencode-sessions-explorer-"

/**
 * Withheld from foreign MCP hosts:
 *   - `current-session` answers "which session am I running in", which is derived
 *     from OpenCode host identity. A foreign host has no such identity, so the
 *     tool is meaningless there.
 *   - `unarchive-session` is the only WRITE path into the live `opencode.db`
 *     (`lib/db-write.ts`). This integration is read-only by design.
 */
const EXCLUDED_TOOLS = new Set<string>([
  "opencode-sessions-explorer-current-session",
  "opencode-sessions-explorer-unarchive-session",
])

const exposed = new Map(
  Object.entries(tools)
    .filter(([name]) => !EXCLUDED_TOOLS.has(name))
    .map(([name, def]) => [name.slice(TOOL_PREFIX.length), def]),
)

const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...exposed].map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.input as { type: "object" },
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const def = exposed.get(name)
  if (!def) {
    return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true }
  }
  try {
    // Tools return the JSON envelope wrapped as `{ content }`; guard anyway.
    // The stub context mirrors src/lib/tool-v2.ts HostToolContext — foreign MCP
    // hosts have no OpenCode identity.
    const result = await def.execute(args ?? {}, stubContext())
    const text = typeof result === "string" ? result : ((result as any).content ?? JSON.stringify(result))
    return { content: [{ type: "text" as const, text }] }
  } catch (e) {
    // Never let a single failing call tear down the stdio server.
    return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true }
  }
})

/** Deliberate no-op shim: never-aborted signal, empty identity. */
function stubContext() {
  return {
    sessionID: "",
    messageID: "",
    agent: "",
    id: "",
    signal: new AbortController().signal,
    progress: async () => {},
  } as any
}

await server.connect(new StdioServerTransport())
