# Manage Archived Sessions Guide

## Purpose

Restore a previously archived OpenCode session so it can be opened and prompted
again, using the one tool in this plugin that writes to the database.

## Mental Model

`unarchive-session` is the only write surface in an otherwise read-only plugin. It
does two things in a single isolated write:

1. **Clears `time_archived`** so the session is no longer marked archived.
2. **Refreshes `time_updated`** so the session resurfaces at the top of OpenCode's
   recency-ordered list.

The `time_updated` bump is required, not cosmetic. OpenCode loads sessions ordered
by `time_updated DESC` with a default limit of ~100 per directory. Clearing
`time_archived` alone leaves a long-archived session buried below that window, so the
app still fails to retrieve it with "Unable to retrieve session". Refreshing
`time_updated` is also the intuitive meaning of "restore". Because it always
restores to a usable state, the tool also resurfaces an already-active-but-buried
session and is idempotent in effect (active and at the top).

### Why A Direct Database Write Is Required

OpenCode exposes no archive/unarchive endpoint that can clear the flag: the HTTP
`UpdatePayload` types `time.archived` as a finite number and the handler ignores
`undefined`, so a clear cannot be sent over the wire. The `opencode session` CLI
only offers list and delete. A direct database write is therefore the only
mechanism. Reads still go through the shared read-only handle; the write goes through
a separate, short-lived read-write connection used only by this tool.

## Controls

| Tool | Use It For | Key Args |
| --- | --- | --- |
| `unarchive-session` | "Unarchive `ses_…`", "restore an archived session so I can continue it" | `session_id` (must be an existing session; returns `NOT_FOUND` otherwise) |
| `list-sessions` / `search-sessions-meta` | Find archived sessions to restore | `archived: 'only'` |

## Recommended Flow

1. Find the archived session you want back:

   ```json
   { "archived": "only", "limit": 20 }
   ```

1. Restore it by id:

   ```json
   { "session_id": "ses_XYZ" }
   ```

   The response reports `was_archived`, the new `now_active` and `resurfaced`
   state, the session `directory`, and before/after `time_updated` values.

1. Make the restored session visible in the app. Because the write happens outside
   OpenCode, it emits no `session.updated` event:

   1. Reload or restart the OpenCode window.
   1. Open OpenCode in the session's own `directory` — it is restored under that
      directory and now sorts to the top of the recency-ordered list.

## Related Docs

- [Recall and navigation](recall-and-navigation.md)
- [Tool reference](../reference/tools.md)
- [Architecture](../reference/architecture.md)
- [Security policy](../../.github/SECURITY.md)
