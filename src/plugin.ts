/**
 * opencode-sessions-explorer plugin — entry point.
 *
 * Registers 18 tools that give the OpenCode LLM access to every prior OpenCode
 * session on this machine: recall, search/grep, and historical analysis (17
 * read-only) plus one deliberate write (`unarchive-session`). See README.md for
 * the full tool catalog and intent triggers.
 *
 * Install (opencode.json):
 *   { "plugin": ["opencode-sessions-explorer"] }
 *
 * Local development (load from src directly):
 *   { "plugin": ["file:///absolute/path/to/opencode-sessions-explorer/src/plugin.ts"] }
 *
 * Required permission (opencode.json):
 *   {
 *     "permission": {
 *       "external_directory": { "~/.local/share/opencode/**": "allow" }
 *     }
 *   }
 *
 * Optional external dep: the `ck` CLI (cargo install ck-search) is needed by
 * search-text + grep-session. Without it those two tools return CK_NOT_FOUND
 * cleanly; the other 16 work fine.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tools } from "./tools/index.js"

/**
 * OpenCode plugin entry. The ONLY export must be the Plugin function
 * (OpenCode's loader iterates module exports and rejects with
 * "Plugin export is not a function" if any non-function export is present
 * alongside a default — verified against opencode v1.15.10).
 */
export const OpencodeSessionsExplorerPlugin: Plugin = async () => {
  return {
    tool: tools,
  }
}

export default OpencodeSessionsExplorerPlugin
