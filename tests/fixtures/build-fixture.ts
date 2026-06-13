/**
 * Synthetic SQLite fixture builder for hermetic `bun test` runs.
 *
 * `buildFixtureDb(dbPath)` materializes a SMALL, deterministic opencode.db-shaped
 * database using bun:sqlite. It creates the session/message/part tables with ALL
 * columns that schema.ts hard-requires PLUS every extra column the tools SELECT,
 * a __drizzle_migrations table (one "2026" row), and a tiny dataset crafted so the
 * rehearsal probes pass WITHOUT touching the author's real ~/.local/share DB.
 *
 * The exported `FIXTURES` constant is the single source of truth for the IDs /
 * phrases / expected_counts shared between this generator and tests/helpers.ts.
 *
 * NOTE: this module has NO import-time side effects (it never opens a DB); only
 * calling buildFixtureDb() writes anything.
 */
import { Database } from "bun:sqlite"
import { join } from "node:path"

/** Single source of truth for hermetic fixture identities. Mirrors fixtures.json shape. */
export const FIXTURES = {
  sessions: {
    active: "ses_fix_active001",
    archived: "ses_fix_archived01",
    deep_parent: "ses_fix_grand0001",
    big_part: "ses_fix_bigpart01",
    pre_migration: "ses_fix_premig001",
    missing: "ses_fix_missing_xyz",
  },
  messages: {
    active_first_user: "msg_fix_active_u1",
    big_message_150mb: "msg_fix_bigmsg_a1",
    missing: "msg_fix_missing_xyz",
  },
  parts: {
    text_active: "prt_fix_active_text01",
    tool_completed: "prt_fix_active_tooldone1",
    tool_error: "prt_fix_active_toolerr1",
    big_5mb_patch: "prt_fix_bigpatch0001",
    tool_with_outputpath: "prt_fix_outpath0001",
    missing: "prt_fix_missing_xyz",
  },
  phrases: {
    active_known: "Submit PR review",
  },
  expected_counts: {
    session_min: 5,
    message_min: 3,
    part_min: 50,
  },
} as const

const T = 1_775_000_000_000 // ~2026-04, satisfies "recent epoch" checks

const DIR_A = "/Users/iamironz/projects/opencode-sessions-explorer"
const DIR_B = "/Users/iamironz/projects/other-app"
const MODEL_A = JSON.stringify({ id: "claude-opus-4-8", providerID: "anthropic", variant: "max" })
const MODEL_B = JSON.stringify({ id: "gpt-5", providerID: "openai", variant: "high" })

type SessionSpec = {
  id: string
  title: string
  project_id?: string
  parent_id?: string | null
  directory?: string
  agent?: string
  model?: string
  cost?: number
  tokens_input?: number
  tokens_output?: number
  tokens_reasoning?: number
  time_archived?: number | null
  idx: number
}

function msgData(role: "user" | "assistant" | "system"): string {
  return JSON.stringify({
    role,
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
    cost: 0.1,
    tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
  })
}

export function buildFixtureDb(dbPath: string): void {
  const db = new Database(dbPath, { create: true })
  try {
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("PRAGMA foreign_keys = OFF;")

    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        parent_id TEXT,
        directory TEXT,
        title TEXT,
        slug TEXT,
        version TEXT,
        share_url TEXT,
        workspace_id TEXT,
        path TEXT,
        agent TEXT,
        model TEXT,
        cost REAL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER,
        time_compacting INTEGER
      );
    `)
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `)
    db.exec(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `)
    db.exec(`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT,
        created_at INTEGER
      );
    `)
    db.query("INSERT INTO __drizzle_migrations (id, name, created_at) VALUES (?, ?, ?)")
      .run(1, "0001_2026_05_initial_schema", T)

    const insSession = db.query(`
      INSERT INTO session (
        id, project_id, parent_id, directory, title, slug, version, share_url,
        workspace_id, path, agent, model, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write,
        time_created, time_updated, time_archived, time_compacting
      ) VALUES (
        $id, $project_id, $parent_id, $directory, $title, $slug, $version, $share_url,
        $workspace_id, $path, $agent, $model, $cost, $tokens_input, $tokens_output,
        $tokens_reasoning, $tokens_cache_read, $tokens_cache_write,
        $time_created, $time_updated, $time_archived, $time_compacting
      )
    `)

    const addSession = (s: SessionSpec) => {
      const created = T + s.idx * 3_600_000
      const updated = created + 600_000
      const tokens_input = s.tokens_input ?? 1000
      insSession.run({
        $id: s.id,
        $project_id: s.project_id ?? "global",
        $parent_id: s.parent_id ?? null,
        $directory: s.directory ?? DIR_A,
        $title: s.title,
        $slug: s.id.replace(/^ses_/, "slug-"),
        $version: "1.15.10",
        $share_url: null,
        $workspace_id: "wsp_fix_0001",
        $path: s.directory ?? DIR_A,
        $agent: s.agent ?? "build",
        $model: s.model ?? MODEL_A,
        $cost: s.cost ?? 0.5,
        $tokens_input: tokens_input,
        $tokens_output: s.tokens_output ?? 500,
        $tokens_reasoning: s.tokens_reasoning ?? 100,
        $tokens_cache_read: 50,
        $tokens_cache_write: 20,
        $time_created: created,
        $time_updated: updated,
        $time_archived: s.time_archived ?? null,
        $time_compacting: null,
      })
    }

    // --- sessions ---------------------------------------------------------
    // Active session under test (title carries both "review" and "session").
    addSession({ id: FIXTURES.sessions.active, title: "Submit PR review for session explorer", cost: 2.5, idx: 1 })
    // Extra active sessions (>= 6 active so list_sessions limit:5 → has_more).
    addSession({ id: "ses_fix_active002", title: "Debugging the session timeline", cost: 1.2, idx: 2 })
    addSession({ id: "ses_fix_active003", title: "Refactor cost analysis", cost: 0.8, idx: 3 })
    addSession({ id: "ses_fix_active004", title: "Add new tool to plugin", cost: 0.3, idx: 4, directory: DIR_B, model: MODEL_B, agent: "plan" })
    addSession({ id: "ses_fix_active005", title: "Write tests for session codec", cost: 1.7, idx: 5 })
    addSession({ id: "ses_fix_active006", title: "Investigate slow query", cost: 0.4, idx: 6 })
    addSession({ id: "ses_fix_active007", title: "Plan session migration work", cost: 0.9, idx: 7, agent: "plan" })
    addSession({ id: "ses_fix_active008", title: "Tidy export tree", cost: 0.2, idx: 8 })
    addSession({ id: "ses_fix_active009", title: "Audit tool failures", cost: 0.6, idx: 9 })
    addSession({ id: "ses_fix_active010", title: "Review session cost report", cost: 1.1, idx: 10 })

    // Archived sessions (>= 1 archived).
    addSession({ id: FIXTURES.sessions.archived, title: "Old archived review session", cost: 0.7, idx: 11, time_archived: T + 11 * 3_600_000 + 100 })

    // Genealogy chain: root (archived) -> child -> grandchild.
    addSession({ id: "ses_fix_root00001", title: "Root orchestrator session", cost: 0.5, idx: 12, time_archived: T + 12 * 3_600_000 + 100 })
    addSession({ id: "ses_fix_child0001", title: "Child executor session", cost: 0.5, idx: 13, parent_id: "ses_fix_root00001" })
    addSession({ id: FIXTURES.sessions.deep_parent, title: "Grandchild session", cost: 0.5, idx: 14, parent_id: "ses_fix_child0001" })

    // Big-part session (many small patch parts).
    addSession({ id: FIXTURES.sessions.big_part, title: "Big patch session", cost: 0.5, idx: 15 })

    // Pre-migration zero-cost session.
    addSession({ id: FIXTURES.sessions.pre_migration, title: "Pre migration zero cost session", cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, idx: 16 })

    // --- messages + parts -------------------------------------------------
    const insMessage = db.query(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`)
    const insPart = db.query(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`)
    const addMessage = (id: string, sessionId: string, ts: number, role: "user" | "assistant" | "system") =>
      insMessage.run(id, sessionId, ts, ts, msgData(role))
    const addPart = (id: string, messageId: string, sessionId: string, ts: number, data: unknown) =>
      insPart.run(id, messageId, sessionId, ts, ts, JSON.stringify(data))

    // Active session content.
    addMessage(FIXTURES.messages.active_first_user, FIXTURES.sessions.active, T + 10, "user")
    addPart(FIXTURES.parts.text_active, FIXTURES.messages.active_first_user, FIXTURES.sessions.active, T + 11, {
      type: "text",
      text: "Submit PR review for the session explorer. Please double-check the regex handling.",
    })
    addMessage("msg_fix_active_a1", FIXTURES.sessions.active, T + 20, "assistant")
    addPart(FIXTURES.parts.tool_completed, "msg_fix_active_a1", FIXTURES.sessions.active, T + 21, {
      type: "tool",
      tool: "bash",
      callID: "call_fix_done",
      state: { status: "completed", input: { command: "ls -la" }, output: "ok done", time: { start: T + 21, end: T + 24 } },
    })
    addPart(FIXTURES.parts.tool_error, "msg_fix_active_a1", FIXTURES.sessions.active, T + 22, {
      type: "tool",
      tool: "read",
      callID: "call_fix_err",
      state: { status: "error", input: { filePath: "/x/missing.ts" }, error: "read failed: file not found" },
    })
    addPart("prt_fix_active_reason01", "msg_fix_active_a1", FIXTURES.sessions.active, T + 23, {
      type: "reasoning",
      text: "Considering the PR review feedback before applying changes.",
    })

    // active002 — externalized-output tool part + a second error (for failure grouping).
    const T2 = T + 2 * 3_600_000
    addMessage("msg_fix_a002_a1", "ses_fix_active002", T2 + 20, "assistant")
    const toolOutDir = process.env.OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR ?? "/tmp/opencode-tool-output"
    addPart(FIXTURES.parts.tool_with_outputpath, "msg_fix_a002_a1", "ses_fix_active002", T2 + 21, {
      type: "tool",
      tool: "grep",
      callID: "call_fix_op",
      state: {
        status: "completed",
        input: { pattern: "foo" },
        // Whitelisted path (inside the tool-output dir) but intentionally NOT created on
        // disk, so dereference fails gracefully (null + warning) — see rehearsal CC-03c.
        metadata: { outputPath: join(toolOutDir, "tool_fix_outpath01") },
      },
    })
    addPart("prt_fix_a002_err1", "msg_fix_a002_a1", "ses_fix_active002", T2 + 22, {
      type: "tool",
      tool: "edit",
      callID: "call_fix_err2",
      state: { status: "error", input: { filePath: "/x/edit.ts" }, error: "edit failed: pattern not found" },
    })

    // Big-part session content.
    const TB = T + 15 * 3_600_000
    addMessage("msg_fix_bigpart_u1", FIXTURES.sessions.big_part, TB + 10, "user")
    addPart("prt_fix_bigpart_text1", "msg_fix_bigpart_u1", FIXTURES.sessions.big_part, TB + 11, {
      type: "text",
      text: "work on the big patch please",
    })
    addMessage(FIXTURES.messages.big_message_150mb, FIXTURES.sessions.big_part, TB + 20, "assistant")
    addPart("prt_fix_bigmsg_p1", FIXTURES.messages.big_message_150mb, FIXTURES.sessions.big_part, TB + 21, {
      type: "patch",
      hash: "hbig1",
      files: ["src/a.ts", "src/b.ts"],
    })
    addPart("prt_fix_bigmsg_p2", FIXTURES.messages.big_message_150mb, FIXTURES.sessions.big_part, TB + 22, {
      type: "text",
      text: "applied the patch",
    })
    // ~220 small patch parts to push part_count > 200.
    addMessage("msg_fix_bigpart_patch", FIXTURES.sessions.big_part, TB + 30, "assistant")
    for (let i = 0; i < 220; i++) {
      const pid = `prt_fix_bp_${String(i).padStart(3, "0")}`
      addPart(pid, "msg_fix_bigpart_patch", FIXTURES.sessions.big_part, TB + 40 + i, {
        type: "patch",
        hash: `h${i}`,
        files: [`src/gen/file_${i}.ts`],
      })
    }
    // Oversized-by-count patch part: >200 files triggers get-part files truncation,
    // and the raw JSON is several KB (retargeted byte assertion in rehearsal).
    const bigFiles = Array.from({ length: 260 }, (_, i) => `src/module/generated/file_${String(i).padStart(4, "0")}.ts`)
    addPart(FIXTURES.parts.big_5mb_patch, "msg_fix_bigpart_patch", FIXTURES.sessions.big_part, TB + 1000, {
      type: "patch",
      hash: "hbigpatch",
      files: bigFiles,
    })

    db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
  } finally {
    db.close()
  }
}
