/**
 * Opaque cursor encode/decode. The cursor is base64(JSON.stringify({ts,id})).
 *
 * Callers never inspect the cursor's contents — they just pass it back.
 * Decoding bad cursors returns null (caller falls back to "no cursor").
 */
import type { Cursor } from "./types.js"

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url")
}

export function decodeCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8"))
    if (typeof obj?.ts !== "number" || typeof obj?.id !== "string") return null
    return { ts: obj.ts, id: obj.id }
  } catch {
    return null
  }
}
