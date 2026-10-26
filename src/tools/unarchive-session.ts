/**
 * opencode-sessions-explorer-unarchive-session
 *
 * The ONE write tool in this otherwise read-only plugin. Restores an archived
 * session by clearing `session_v2.time_archived` AND refreshing
 * `session_v2.time_updated`.
 *
 * OpenCode exposes NO archive/unarchive endpoint that can CLEAR the flag: the
 * HTTP `UpdatePayload` types `time.archived` as a finite number and the handler
 * ignores `undefined`, so a clear/`null` cannot be sent over the wire (verified
 * against v1.15.12 source; V2 exposes no clear either). A direct DB write is
 * the only mechanism.
 *
 * Why bump time_updated: verified against the opencode v2.1.3 binary — the
 * V2 session picker (`SessionStore.list`) reads `session_v2` ordered by
 * `time_updated DESC, id DESC` (archived rows filtered via
 * `time_archived IS NULL`). A long-archived session keeps an old
 * time_updated, so merely clearing time_archived leaves it buried below that
 * recency window. Refreshing time_updated resurfaces it at the top (also the
 * intuitive meaning of "restore").
 *
 * Reads stay on the shared read-only handle; the write goes through the isolated
 * `lib/db-write.ts` connection. Always restores to a usable state (clears archived
 * + resurfaces), including an already-active-but-buried session, so it is not a
 * no-op on active rows; idempotent in effect (active + at the top). Cap: 8 KB.
 */
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { unarchiveSessionRow } from "../lib/db-write.js"
import { defineTool } from "../lib/tool-v2.js"

const RELOAD_NOTE =
  "Reload/restart the OpenCode window for the restored session to appear — an external DB write emits no live update event. The session's time_updated was refreshed so it now sorts to the top of the recency-ordered list (loaded by default). It is restored under its own directory, so open OpenCode in that directory to see it."

export const unarchiveSession = defineTool<{ session_id: string }>({
  name: "opencode-sessions-explorer-unarchive-session",
  description:
    "opencode-sessions-explorer: UNARCHIVE (restore) a previously archived OpenCode session so it can be opened and prompted again. " +
    "This is the only opencode-sessions-explorer tool that WRITES to opencode.db — every other tool is read-only. " +
    'Answers: "unarchive session ses_…", "restore an archived session", "bring back a session I archived", "make an archived session active again", "un-archive ses_…", "restore a session so I can continue it". ' +
    "Clears session_v2.time_archived AND refreshes session_v2.time_updated so the restored session resurfaces at the top of OpenCode's recency-ordered session list (the app loads only the most-recent ~100 per directory, so without this it stays hidden and prompting fails with 'Unable to retrieve session'). " +
    "OpenCode exposes no archive/unarchive HTTP/SDK endpoint that can clear the flag and `opencode session` only offers list/delete, so a direct DB write is the only mechanism. " +
    "Always restores to a usable state — it also resurfaces an already-active-but-buried session, so it is not a no-op on active sessions (idempotent in effect: active + at the top). Returns NOT_FOUND only if the session id does not exist. " +
    "To FIND archived sessions to restore, use list-sessions or search-sessions-meta with archived:'only'. " +
    "After restoring, reload/restart the OpenCode window (the change emits no live event) and open OpenCode in the session's directory.",
  args: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session ID to unarchive (e.g. 'ses_…'). Must be an existing session." },
    },
    required: ["session_id"],
  },
  async execute(args) {
    return runWithEnvelope("unarchive_session", 8, async (ctx) => {
      // Read-only lookup: clean NOT_FOUND + reporting (directory helps the user
      // know where to open OpenCode to see the restored session).
      const row = stmt(
        `SELECT id, title, directory FROM session_v2 WHERE id = ?`,
      ).get(args.session_id) as { id: string; title: string | null; directory: string | null } | undefined

      if (!row) fail("NOT_FOUND", `session not found: ${args.session_id}`)

      // Always restore to a usable state: clear time_archived + resurface
      // (bump time_updated), even if already active but buried.
      const result = unarchiveSessionRow(args.session_id)
      ctx.warnings.push(RELOAD_NOTE)

      return {
        session_id: row!.id,
        title: row!.title,
        directory: row!.directory,
        was_archived: result.wasArchived,
        now_active: true,
        resurfaced: true,
        time_archived_before: result.archivedBefore,
        archived_after: false,
        time_updated_before: result.updatedBefore,
        time_updated_after: result.updatedAfter,
      }
    })
  },
})
