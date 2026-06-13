/**
 * Byte-cap enforcer + snippet builder + secret redactor.
 *
 * Every tool MUST funnel its return value through one of these helpers
 * before serialization — see the cap budgets in the design doc §5.
 */

/** Truncate a string to `maxBytes` UTF-8 bytes, appending the marker. */
export function truncateString(s: string, maxBytes: number, marker = "…[truncated]"): { value: string; truncated: boolean; originalBytes: number } {
  const enc = new TextEncoder()
  const bytes = enc.encode(s)
  if (bytes.length <= maxBytes) return { value: s, truncated: false, originalBytes: bytes.length }
  const markerBytes = enc.encode(marker).length
  const slice = bytes.slice(0, Math.max(0, maxBytes - markerBytes))
  // decode safely (may split a multibyte char) — fall back by trimming a few bytes
  let decoded = new TextDecoder("utf-8", { fatal: false }).decode(slice)
  // remove the trailing replacement char if any
  decoded = decoded.replace(/\uFFFD+$/, "")
  return { value: decoded + marker, truncated: true, originalBytes: bytes.length }
}

/** Approximate byte size of a JS value once JSON-stringified. */
export function approxJsonBytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length
}

/**
 * Build a one-line snippet of ~maxChars centred on the first case-insensitive
 * occurrence of `q` in `text`. Marker chars ⟦ ⟧ are easy for an LLM to parse.
 */
export function snippet(text: string, q: string, maxChars = 220): { value: string; offset: number } {
  if (!text) return { value: "", offset: -1 }
  if (!q) {
    const v = text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text
    return { value: v.replace(/\s+/g, " "), offset: 0 }
  }
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const idx = lower.indexOf(needle)
  if (idx < 0) {
    // no match — return head
    const head = text.slice(0, Math.min(maxChars, text.length))
    return { value: head.replace(/\s+/g, " "), offset: -1 }
  }
  const before = Math.floor((maxChars - q.length) / 2)
  const start = Math.max(0, idx - before)
  const end = Math.min(text.length, start + maxChars)
  let value = text.slice(start, end)
  // mark the matched range
  const relIdx = idx - start
  if (relIdx >= 0 && relIdx + q.length <= value.length) {
    value = value.slice(0, relIdx) + "⟦" + value.slice(relIdx, relIdx + q.length) + "⟧" + value.slice(relIdx + q.length)
  }
  if (start > 0) value = "…" + value
  if (end < text.length) value = value + "…"
  return { value: value.replace(/\s+/g, " "), offset: idx }
}

/** Redact common secret shapes from a snippet. */
const SECRET_PATTERNS: { re: RegExp; mask: string }[] = [
  { re: /AKIA[0-9A-Z]{16}/g, mask: "AKIA****REDACTED" },
  { re: /aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+]{40}/gi, mask: "aws_secret_access_key=****REDACTED" },
  { re: /ghp_[A-Za-z0-9]{20,}/g, mask: "ghp_****REDACTED" },
  { re: /github_pat_[A-Za-z0-9_]{40,}/g, mask: "github_pat_****REDACTED" },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, mask: "sk-****REDACTED" },
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, mask: "sk-ant-****REDACTED" },
  { re: /xoxb-[A-Za-z0-9-]{20,}/g, mask: "xoxb-****REDACTED" },
  { re: /xoxa-[A-Za-z0-9-]{20,}/g, mask: "xoxa-****REDACTED" },
  { re: /xoxp-[A-Za-z0-9-]{20,}/g, mask: "xoxp-****REDACTED" },
  { re: /xoxe-[A-Za-z0-9-]{20,}/g, mask: "xoxe-****REDACTED" },
  { re: /AIza[0-9A-Za-z\-_]{35}/g, mask: "AIza****REDACTED" },
  { re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, mask: "jwt.****REDACTED" },
  { re: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, mask: "-----BEGIN PRIVATE KEY-----****REDACTED-----END PRIVATE KEY-----" },
  { re: /authorization\s*:\s*bearer\s+\S+/gi, mask: "authorization: bearer ****REDACTED" },
  { re: /bearer\s+[A-Za-z0-9._~+/-]{24,}/gi, mask: "bearer ****REDACTED" },
]

export function redactSecrets(s: string): string {
  let out = s
  for (const { re, mask } of SECRET_PATTERNS) out = out.replace(re, mask)
  return out
}
