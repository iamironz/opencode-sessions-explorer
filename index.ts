/**
 * opencode-sessions-explorer — OpenCode V2 plugin entry (directory entry point).
 *
 * The V2 plugin host loads a DIRECTORY containing `index.ts`; this file is
 * that entry and simply re-exports the plugin definition from `src/plugin.ts`
 * (which is also the npm/dist entry, keeping one source of truth).
 */
export { default } from "./src/plugin.js"
