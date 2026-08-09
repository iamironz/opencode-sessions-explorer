#!/usr/bin/env bun
/**
 * mcp — MCP stdio entry point.
 *
 * Second entry point beside `src/plugin.ts`. The plugin hands `tools` to the
 * OpenCode host; this file serves the same tools over the Model Context Protocol
 * on stdin/stdout so a NON-OpenCode host (any MCP client) can call them.
 *
 * `src/tools/index.ts` stays the single source of truth — this file only filters,
 * renames, and adapts. It does not define or duplicate any tool.
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
import type { ToolContext } from "@opencode-ai/plugin"
import { z } from "zod"
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

/**
 * `tool()` from `@opencode-ai/plugin` is a transparent wrapper: each registry
 * value is exactly `{ description, args, execute }`, where `args` is a plain
 * object of zod schemas (not a `ZodObject`).
 */
type ExposedTool = {
  description: string
  args: z.ZodRawShape
  execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>
}

const exposed = new Map<string, ExposedTool>(
  Object.entries(tools)
    .filter(([name]) => !EXCLUDED_TOOLS.has(name))
    .map(([name, def]) => [name.slice(TOOL_PREFIX.length), def as unknown as ExposedTool]),
)

/**
 * Deliberate no-op shim for the OpenCode `ToolContext`. OpenCode injects real
 * session identity, cancellation, and permission plumbing per call; a foreign MCP
 * host has none of that. Every exposed tool reads the DB directly and ignores
 * these fields, so empty identity plus a never-aborted signal is safe.
 */
const stubContext: ToolContext = {
  sessionID: "",
  messageID: "",
  agent: "",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
}

const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...exposed].map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: z.toJSONSchema(z.object(def.args), { io: "input" }) as { type: "object" },
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const def = exposed.get(name)
  if (!def) {
    return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true }
  }
  try {
    // Tools return the JSON envelope as a string (`lib/envelope.ts`); guard anyway.
    const result = await def.execute(args ?? {}, stubContext)
    const text = typeof result === "string" ? result : JSON.stringify(result)
    return { content: [{ type: "text" as const, text }] }
  } catch (e) {
    // Never let a single failing call tear down the stdio server.
    return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
