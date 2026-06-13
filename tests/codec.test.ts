/**
 * Unit tests for the columnar+interning result codec (src/lib/table.ts).
 * These are hermetic — no DB required.
 */
import { test, describe, expect } from "bun:test"
import { table, decodeTable, isTable } from "../src/lib/table.ts"

describe("table codec", () => {
  const sample = [
    { id: "a", agent: "build", model: { id: "m1" }, cost: 1, n: null },
    { id: "b", agent: "build", model: { id: "m2" }, cost: 2, n: 5 },
    { id: "c", agent: "executor-gpt", model: { id: "m1" }, cost: 3, n: null },
  ]

  test("round-trips losslessly", () => {
    const t = table(sample, { dict: ["agent", "model"] })
    expect(decodeTable(t)).toEqual(sample)
  })

  test("interns repeated values into a dictionary", () => {
    const t = table(sample, { dict: ["agent", "model"] })
    expect(t.dict.agent).toEqual(["build", "executor-gpt"]) // 2 distinct of 3
    expect(t.dict.model).toEqual([{ id: "m1" }, { id: "m2" }]) // 2 distinct of 3
    // rows store indices, not the literal values
    expect(t.rows[0][t.cols.indexOf("agent")]).toBe(0)
    expect(t.rows[2][t.cols.indexOf("agent")]).toBe(1)
  })

  test("columnar shape is smaller than array-of-objects for repeated keys", () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
      id: "ses_" + i, agent: i % 2 ? "build" : "executor-gpt",
      directory: "/Users/x", model: { id: "gpt", providerID: "openai", variant: "xhigh" },
      cost: i, tokens_input: i * 10, tokens_output: i * 100,
    }))
    const objBytes = new TextEncoder().encode(JSON.stringify(big)).length
    const tblBytes = new TextEncoder().encode(JSON.stringify(table(big, { dict: ["agent", "directory", "model"] }))).length
    expect(tblBytes).toBeLessThan(objBytes * 0.7) // >30% smaller
    expect(decodeTable(table(big, { dict: ["agent", "directory", "model"] }))).toEqual(big)
  })

  test("preserves null and missing fields", () => {
    const t = table([{ a: 1, b: null }, { a: 2 }], {})
    expect(decodeTable(t)).toEqual([{ a: 1, b: null }, { a: 2, b: null }])
  })

  test("empty array yields empty table", () => {
    const t = table([], { dict: ["agent"] })
    expect(t.rows).toEqual([])
    expect(decodeTable(t)).toEqual([])
  })

  test("plain arrays pass through decodeTable unchanged", () => {
    expect(decodeTable([{ x: 1 }] as any)).toEqual([{ x: 1 }])
    expect(decodeTable(null)).toEqual([])
  })

  test("every row length equals cols length", () => {
    const t = table(sample, { dict: ["agent"] })
    for (const r of t.rows) expect(r.length).toBe(t.cols.length)
  })

  test("isTable discriminates tables from arrays", () => {
    expect(isTable(table(sample, {}))).toBe(true)
    expect(isTable([1, 2, 3])).toBe(false)
    expect(isTable({ foo: 1 })).toBe(false)
  })

  test("drops dictionaries for absent columns", () => {
    const t = table([{ a: 1 }], { dict: ["nope"] })
    expect(t.dict.nope).toBeUndefined()
  })
})
