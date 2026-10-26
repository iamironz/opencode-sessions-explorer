/**
 * Tool definition wrapper for the OpenCode V2 plugin API.
 *
 * V2 registers tools through `ctx.tool.transform(editor => editor.add(...))`
 * with plain JSON Schema `input` and an `execute` that resolves to
 * `{ content }`. This wrapper keeps the existing per-tool bodies unchanged in
 * shape: each tool still runs `runWithEnvelope(...)` and returns the envelope
 * as a JSON string; the wrapper applies JSON-Schema defaults to raw input and
 * wraps the string into the V2 result shape.
 *
 * The host `execute` context (V2 `ToolContext`) carries `sessionID`,
 * `messageID`, `agent`, and an abort `signal`. Unlike V1 it has no
 * `directory`/`worktree`; the plugin entry stashes the session location
 * directory at setup time via `setHostDirectory()`.
 */
import type { Info } from "@opencode/plugin/promise/tool"
import type { ArgIssue, ToolArgsSchema } from "./jsonschema.js"
import { describeArgs, stripNulls, validateArgs, withDefaults } from "./jsonschema.js"
import { fail, runWithEnvelope } from "./envelope.js"

/** Minimal structural type for the V2 tool execution context we consume. */
export type HostToolContext = {
  sessionID?: string
  messageID?: string
  agent?: string
  signal?: AbortSignal
  [key: string]: unknown
}

/** A host-facing V2 tool plus the source args schema (kept for tests + MCP). */
export type SessionsTool = Info<any, any> & {
  /** Source-of-truth JSON Schema for the tool args (also used by src/mcp.ts). */
  readonly args: ToolArgsSchema
}

export type ToolDefinition<A> = {
  /** Full public tool name, `opencode-sessions-explorer-<name>`. */
  name: string
  /** Routing description — the exact V1 text (LLM routing depends on it). */
  description: string
  /** JSON Schema for the arguments (object schema with per-property defaults). */
  args: ToolArgsSchema
  /**
   * Retired parameter names → specific explanation, shown instead of the generic
   * "unknown parameter" message (e.g. search-text's removed `mode`).
   */
  removedArgs?: Record<string, string>
  /** Tool body: validated+defaulted args in, envelope JSON string out. */
  execute(args: A, context: HostToolContext): Promise<string>
}

/** Envelope `function` name for a tool: `opencode-sessions-explorer-get-message` → `get_message`. */
function envelopeName(toolName: string): string {
  return toolName.replace(/^opencode-sessions-explorer-/, "").replace(/-/g, "_")
}

/**
 * Echo the effective arguments into the envelope `meta` so the caller can see
 * what was actually applied: `meta.args` (provided + defaults) and
 * `meta.args_defaulted` (keys that came from schema defaults). This exposes
 * silently-dropped parameters — e.g. OpenCode Code Mode strips unknown keys
 * before they reach the plugin, so a typo like `archvied` shows up as
 * `archived` in `args_defaulted`.
 */
function withAppliedArgs(json: string, provided: Record<string, unknown>, applied: Record<string, unknown>): string {
  let env: any
  try { env = JSON.parse(json) } catch { return json }
  if (!env || typeof env !== "object" || !env.meta || typeof env.meta !== "object") return json
  env.meta.args = applied
  env.meta.args_defaulted = Object.keys(applied).filter((k) => !(k in provided))
  return JSON.stringify(env)
}

/** BAD_ARGS envelope listing every problem plus the full valid-parameter signature. */
function badArgs<A>(def: ToolDefinition<A>, issues: ArgIssue[]): Promise<string> {
  const message = `Invalid arguments for ${def.name}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`
  const hint = `Valid parameters (* = required): ${describeArgs(def.args)}`
  return runWithEnvelope(envelopeName(def.name), 8, async () => fail("BAD_ARGS", message, hint))
}

let hostDirectory = ""

/** Called once from the plugin setup context (NOT from the transform hook). */
export function setHostDirectory(directory: string): void {
  hostDirectory = directory
}

/** The plugin location directory captured at setup ("" when unavailable). */
export function getHostDirectory(): string {
  return hostDirectory
}

/** Build the host-facing tool from a definition. */
export function defineTool<A>(def: ToolDefinition<A>): SessionsTool {
  return {
    name: def.name,
    description: def.description,
    input: { additionalProperties: false, ...def.args } as any,
    args: def.args,
    async execute(rawInput: any, context: any) {
      // Strict input validation: unknown parameters, wrong types, out-of-range
      // numbers and values outside an enum are rejected with the allowed options,
      // instead of silently matching nothing.
      const issues = validateArgs(def.args, rawInput, def.removedArgs)
      if (issues.length) return { content: await badArgs(def, issues) }
      const provided = stripNulls(rawInput)
      const args = withDefaults(def.args, provided) as A
      const json = await def.execute(args, context as HostToolContext)
      return { content: withAppliedArgs(json, provided, args as Record<string, unknown>) }
    },
  } as SessionsTool
}
