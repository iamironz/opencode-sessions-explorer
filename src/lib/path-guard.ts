/**
 * Path-traversal guard for dereferencing externalized tool-output files.
 *
 * The whitelist is exactly the OpenCode tool-output directory and its
 * subdirectories. Any path resolving outside this root is rejected.
 *
 * Whitelist root discovery:
 *   1. $OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR if set (absolute path)
 *   2. $XDG_DATA_HOME/opencode/tool-output on Linux/macOS
 *   3. $LOCALAPPDATA/opencode/tool-output on Windows
 *   4. ~/.local/share/opencode/tool-output (default for Linux/macOS)
 *
 * Symlinks are resolved BEFORE comparing so that a symlink inside the
 * whitelist pointing outside it is also rejected.
 */
import { homedir, platform } from "node:os"
import { resolve, join } from "node:path"
import { realpathSync } from "node:fs"

function defaultToolOutputDir(): string {
  if (process.env.OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR) {
    return resolve(process.env.OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR)
  }
  const home = homedir()
  switch (platform()) {
    case "win32": {
      const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local")
      return resolve(local, "opencode", "tool-output")
    }
    case "darwin":
    case "linux":
    default: {
      const dataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share")
      return resolve(dataHome, "opencode", "tool-output")
    }
  }
}

const ALLOWED_ROOTS = [defaultToolOutputDir()]

export function isWhitelistedToolOutputPath(p: string): boolean {
  // Resolve to absolute, normalize. Try realpath; fall back to lexical resolve.
  let abs: string
  try { abs = realpathSync(p) } catch { abs = resolve(p) }
  for (const root of ALLOWED_ROOTS) {
    if (abs === root) return true
    if (abs.startsWith(root + "/")) return true
  }
  return false
}

/** Exposed for tests. */
export const _ALLOWED_ROOTS = ALLOWED_ROOTS
