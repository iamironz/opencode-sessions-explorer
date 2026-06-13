/**
 * Test helpers — mock OpenCode ToolContext + run-and-parse helper.
 *
 * Critically, this helper APPLIES ZOD VALIDATION to the input args so
 * defaults declared with `.default(...)` actually kick in — mirroring
 * what OpenCode does at runtime before calling execute().
 */
import { z } from "zod"
import type { Envelope } from "../src/lib/types.js"
import { decodeTable, isTable } from "../src/lib/table.js"

export function mockCtx() {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

/** Call a tool's execute (after applying zod defaults) and parse the JSON envelope.
 *  Accepts EITHER a module (with default export) OR the tool definition directly.
 *  Optional ctxOverride lets a test inject sessionID/messageID/etc — useful for
 *  testing opencode-sessions-explorer-current-session against a real fixture session. */
/** Raw runner — returns the on-the-wire envelope WITHOUT decoding columnar tables.
 *  Use this to assert the compact wire format. */
export async function runToolRaw<T = any>(
  toolModuleOrDef: any,
  args: Record<string, any>,
  ctxOverride: Partial<ReturnType<typeof mockCtx>> = {},
): Promise<Envelope<T>> {
  const def = toolModuleOrDef?.default ?? toolModuleOrDef
  const schema = z.object(def.args)
  const parsed = schema.parse(args)
  const ctx = { ...mockCtx(), ...ctxOverride }
  const result = await def.execute(parsed, ctx)
  const json = typeof result === "string" ? result : (result.output ?? JSON.stringify(result))
  return JSON.parse(json) as Envelope<T>
}

/** Behavioral runner — like runToolRaw but auto-decodes any top-level columnar
 *  table fields in `data` back into arrays of objects, so existing behavioral
 *  assertions read the logical shape. The wire format is asserted separately via
 *  runToolRaw + tests/codec.test.ts. */
export async function runTool<T = any>(
  toolModuleOrDef: any,
  args: Record<string, any>,
  ctxOverride: Partial<ReturnType<typeof mockCtx>> = {},
): Promise<Envelope<T>> {
  const env = await runToolRaw<T>(toolModuleOrDef, args, ctxOverride)
  const data: any = (env as any).data
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const k of Object.keys(data)) {
      if (isTable(data[k])) data[k] = decodeTable(data[k])
    }
  }
  return env
}

/** Decode a columnar table result (or pass a plain array through). */
export function rows<T = any>(t: any): T[] {
  return decodeTable<T>(t)
}

import liveFixtures from "./fixtures.json"
import { FIXTURES as hermeticFixtures } from "./fixtures/build-fixture.ts"

type Fixtures = {
  sessions: Record<string, string>
  messages: Record<string, string>
  parts: Record<string, string>
  phrases: Record<string, string>
  expected_counts: Record<string, number>
}

/** In LIVE mode use the author's real-corpus fixtures.json; otherwise use the
 *  synthetic IDs/phrases/counts that tests/fixtures/build-fixture.ts inserted —
 *  one shared source of truth so helpers and the generator never drift. */
export function loadFixtures(): Fixtures {
  if (process.env.OPENCODE_SESSIONS_EXPLORER_LIVE) return liveFixtures as Fixtures
  return hermeticFixtures as unknown as Fixtures
}
