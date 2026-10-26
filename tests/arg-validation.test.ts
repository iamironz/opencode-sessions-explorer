import { describe, expect, test } from "bun:test"
import { describeArgs, validateArgs, withDefaults, type JsonSchema, type ToolArgsSchema } from "../src/lib/jsonschema.ts"
import { tools } from "../src/tools/index.ts"

type AnyTool = { name: string; args: ToolArgsSchema; execute(input: unknown, ctx: unknown): Promise<{ content: string }> }
const all = Object.values(tools) as unknown as AnyTool[]
const byName = (n: string) => (tools as unknown as Record<string, AnyTool>)[`opencode-sessions-explorer-${n}`]!

async function call(n: string, input: unknown) {
  const res = await byName(n).execute(input, {})
  return JSON.parse(res.content) as { ok: boolean; error?: { code: string; message: string; hint?: string } }
}

/** Minimal valid value for a schema: first enum value, minimum, or a type placeholder. */
function sample(s: JsonSchema): unknown {
  if (Array.isArray(s.enum)) return s.enum[0]
  switch (s.type) {
    case "string": return "x"
    case "integer":
    case "number": return typeof s.minimum === "number" ? s.minimum : 1
    case "boolean": return true
    case "array": return []
    case "object": return {}
    default: return "x"
  }
}

describe("validateArgs (unit)", () => {
  const schema: ToolArgsSchema = {
    type: "object",
    properties: {
      session_id: { type: "string" },
      kinds: { type: "array", items: { type: "string", enum: ["text", "tool", "reasoning"] } },
      archived: { type: "string", enum: ["no", "only", "any"], default: "any" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
    required: ["session_id"],
  }

  test("valid input has no issues; optional null counts as absent", () => {
    expect(validateArgs(schema, { session_id: "ses_1", kinds: ["text"], limit: 5 })).toEqual([])
    expect(validateArgs(schema, { session_id: "ses_1", archived: null })).toEqual([])
  })

  test("enum violation inside an array lists the allowed values and suggests a typo fix", () => {
    const [i] = validateArgs(schema, { session_id: "s", kinds: ["reasning"] })
    expect(i!.path).toBe("kinds[0]")
    expect(i!.message).toContain('allowed: "text" | "tool" | "reasoning"')
    expect(i!.message).toContain('did you mean "reasoning"?')
  })

  test("scalar enum, type mismatch, range, unknown key and missing required are all reported together", () => {
    const issues = validateArgs(schema, { sessionId: "s", archived: "maybe", limit: "10" })
    const text = issues.map((i) => `${i.path}: ${i.message}`).join("\n")
    expect(text).toContain("session_id: missing required parameter (string)")
    expect(text).toContain('sessionId: unknown parameter (did you mean "session_id"?)')
    expect(text).toContain("allowed parameters: session_id, kinds, archived, limit")
    expect(text).toContain('archived: got "maybe"; allowed: "no" | "only" | "any"')
    expect(text).toContain('limit: expected integer, got string "10"')
    expect(validateArgs(schema, { session_id: "s", limit: 500 })[0]!.message).toBe("got 500; must be 1..50")
  })

  test("non-object input is rejected", () => {
    expect(validateArgs(schema, "ses_1")[0]!.message).toContain("expected an object of named parameters")
  })

  test("describeArgs renders a compact signature", () => {
    const sig = describeArgs(schema)
    expect(sig).toContain("session_id*: string")
    expect(sig).toContain('archived: "no" | "only" | "any" (default "any")')
    expect(sig).toContain("limit: integer 1..50 (default 20)")
    expect(sig).toContain('kinds: array of "text" | "tool" | "reasoning"')
  })
})

describe("every tool schema is self-consistent (no false positives)", () => {
  test("exactly 18 tools", () => expect(all.length).toBe(18))
  for (const t of all) {
    test(`${t.name}: defaults + minimal required input validate cleanly`, () => {
      const props = (t.args.properties ?? {}) as Record<string, JsonSchema>
      const minimal: Record<string, unknown> = {}
      for (const key of t.args.required ?? []) minimal[key] = sample(props[key] ?? {})
      expect(validateArgs(t.args, minimal)).toEqual([])
      expect(validateArgs(t.args, withDefaults(t.args, minimal))).toEqual([])
    })
  }
})

describe("tools return a BAD_ARGS envelope instead of silently matching nothing", () => {
  test("get-message: removed part type is rejected with the allowed list", async () => {
    const env = await call("get-message", { message_id: "msg_x", part_types: ["patch"] })
    expect(env.ok).toBe(false)
    expect(env.error!.code).toBe("BAD_ARGS")
    expect(env.error!.message).toContain('part_types[0]: got "patch"; allowed: "text" | "tool" | "reasoning" | "compaction"')
    expect(env.error!.hint).toContain("message_id*: string")
  })

  test("get-session: unknown parameter suggests the right name", async () => {
    const env = await call("get-session", { sessionId: "ses_x" })
    expect(env.error!.code).toBe("BAD_ARGS")
    expect(env.error!.message).toContain('did you mean "session_id"?')
    expect(env.error!.message).toContain("session_id: missing required parameter")
  })

  test("search-text: retired `mode` keeps its specific explanation", async () => {
    const env = await call("search-text", { q: "x", mode: "semantic" })
    expect(env.error!.code).toBe("BAD_ARGS")
    expect(env.error!.message).toContain("semantic modes were removed")
  })

  test("successful responses echo applied args and which ones came from defaults", async () => {
    const res = await byName("cost-by-project").execute({ group_by: "model" }, {})
    const env = JSON.parse(res.content) as { ok: boolean; meta: { args: Record<string, unknown>; args_defaulted: string[] } }
    expect(env.ok).toBe(true)
    expect(env.meta.args.group_by).toBe("model")
    expect(env.meta.args.archived).toBe("any")
    expect(env.meta.args_defaulted).toContain("archived")
    expect(env.meta.args_defaulted).not.toContain("group_by")
  })

  test("valid arguments are not rejected (bogus id → NOT_FOUND, not BAD_ARGS)", async () => {
    const env = await call("get-message", { message_id: "msg_does_not_exist", part_types: ["text", "tool"] })
    expect(env.error?.code).not.toBe("BAD_ARGS")
  })
})
