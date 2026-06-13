/**
 * Tool registry — all 18 opencode-sessions-explorer tools, keyed by their public tool name.
 * 17 are read-only; `unarchive-session` is the lone write tool.
 *
 * The Plugin function in `src/plugin.ts` returns this map under the `tool:` key
 * of its hooks object, which is how OpenCode registers them with the LLM at
 * session start.
 */
import { costByPeriod } from "./cost-by-period.js"
import { costByProject } from "./cost-by-project.js"
import { currentSession } from "./current-session.js"
import { dbStats } from "./db-stats.js"
import { getMessage } from "./get-message.js"
import { getPart } from "./get-part.js"
import { getSession } from "./get-session.js"
import { grepSession } from "./grep-session.js"
import { listRepeatedPrompts } from "./list-repeated-prompts.js"
import { listSessions } from "./list-sessions.js"
import { listToolFailures } from "./list-tool-failures.js"
import { searchSessionsMeta } from "./search-sessions-meta.js"
import { searchText } from "./search-text.js"
import { searchToolCalls } from "./search-tool-calls.js"
import { sessionGenealogy } from "./session-genealogy.js"
import { sessionSummary } from "./session-summary.js"
import { sessionTimeline } from "./session-timeline.js"
import { unarchiveSession } from "./unarchive-session.js"

export const tools = {
  "opencode-sessions-explorer-cost-by-period": costByPeriod,
  "opencode-sessions-explorer-cost-by-project": costByProject,
  "opencode-sessions-explorer-current-session": currentSession,
  "opencode-sessions-explorer-db-stats": dbStats,
  "opencode-sessions-explorer-get-message": getMessage,
  "opencode-sessions-explorer-get-part": getPart,
  "opencode-sessions-explorer-get-session": getSession,
  "opencode-sessions-explorer-grep-session": grepSession,
  "opencode-sessions-explorer-list-repeated-prompts": listRepeatedPrompts,
  "opencode-sessions-explorer-list-sessions": listSessions,
  "opencode-sessions-explorer-list-tool-failures": listToolFailures,
  "opencode-sessions-explorer-search-sessions-meta": searchSessionsMeta,
  "opencode-sessions-explorer-search-text": searchText,
  "opencode-sessions-explorer-search-tool-calls": searchToolCalls,
  "opencode-sessions-explorer-session-genealogy": sessionGenealogy,
  "opencode-sessions-explorer-session-summary": sessionSummary,
  "opencode-sessions-explorer-session-timeline": sessionTimeline,
  "opencode-sessions-explorer-unarchive-session": unarchiveSession,
} as const

export type ToolName = keyof typeof tools

export {
  costByPeriod,
  costByProject,
  currentSession,
  dbStats,
  getMessage,
  getPart,
  getSession,
  grepSession,
  listRepeatedPrompts,
  listSessions,
  listToolFailures,
  searchSessionsMeta,
  searchText,
  searchToolCalls,
  sessionGenealogy,
  sessionSummary,
  sessionTimeline,
  unarchiveSession,
}
