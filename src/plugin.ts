/**
 * opencode-sessions-explorer plugin — OpenCode V2 entry point.
 *
 * Registers 18 tools that give the OpenCode LLM access to your OpenCode
 * session history: recall, search/grep, and historical analysis (17
 * read-only) plus one deliberate write (`unarchive-session`). See README.md for
 * the full tool catalog and intent triggers.
 *
 * V2 install (opencode.json / config — path points at the DIRECTORY that
 * contains index.ts):
 *   { "plugin": [{ "path": "/home/you/projects/opencode-sessions-explorer" }] }
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
import { Plugin } from "@opencode/plugin"
import { tools } from "./tools/index.js"
import { setHostDirectory } from "./lib/tool-v2.js"

/**
 * The ONLY export is the default Plugin definition (OpenCode V2's loader).
 * `setup` runs once per location: it captures the location directory (used by
 * current-session for orientation) and registers all tools through the
 * synchronous `tool.transform` hook.
 */
export default Plugin.define({
  id: "opencode-sessions-explorer",
  async setup(ctx) {
    try {
      setHostDirectory(ctx.location.directory ?? "")
    } catch {
      setHostDirectory("")
    }
    await ctx.tool.transform((editor) => {
      for (const tool of Object.values(tools)) editor.add(tool)
    })
  },
})
