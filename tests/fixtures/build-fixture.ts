/**
 * Synthetic SQLite fixture builder for hermetic `bun test` runs — V2 schema.
 *
 * `buildFixtureDb(dbPath)` materializes a SMALL, deterministic opencode-V2-shaped
 * database using bun:sqlite. It creates `session_v2` + `session_message` (the
 * canonical V2 tables) with ALL columns schema.ts hard-requires PLUS every extra
 * column the tools SELECT, a `migration` table (one "2026" row), and a tiny
 * dataset crafted so the rehearsal probes pass WITHOUT touching the author's
 * real ~/.local/share DB.
 *
 * Messages use the verified live V2 shapes (see src/lib/v2-parts.ts): user
 * messages carry `data.text`; assistant messages carry inline `data.content[]`
 * items. The `pre_migration` session mimics an IMPORTED (V1-era) session —
 * tool items with `toolu_` ids, cleared result content, legacy `filePath`
 * inputs — so imported-vs-live normalization is covered hermetically.
 *
 * The exported `FIXTURES` constant is the single source of truth for the IDs /
 * phrases / expected_counts shared between this generator and tests/helpers.ts.
 * Part references are the synthesized V2 ids `<messageId>#<contentIndex>`.
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
    /** Spans the V1→V2 tool rename: imported bash/task + V2-live shell/subagent calls. */
    tool_alias: "ses_fix_active009",
    missing: "ses_fix_missing_xyz",
  },
  messages: {
    active_first_user: "msg_fix_active_u1",
    big_message_150mb: "msg_fix_bigmsg_a1",
    missing: "msg_fix_missing_xyz",
  },
  parts: {
    text_active: "msg_fix_active_u1#0",
    tool_completed: "msg_fix_active_a1#0",
    tool_error: "msg_fix_active_a1#1",
    big_5mb_patch: "msg_fix_bigpart_patch#220",
    tool_with_outputpath: "msg_fix_a002_a1#0",
    missing: "msg_fix_missing_xyz#0",
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

export function buildFixtureDb(dbPath: string): void {
  const db = new Database(dbPath, { create: true })
  try {
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("PRAGMA foreign_keys = OFF;")

    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        workspace_id TEXT,
        parent_id TEXT,
        fork_session_id TEXT,
        fork_boundary INTEGER,
        slug TEXT,
        directory TEXT,
        path TEXT,
        title TEXT,
        version TEXT,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        summary_diffs TEXT,
        metadata TEXT,
        cost REAL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER,
        revert TEXT,
        permission TEXT,
        agent TEXT,
        model TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_compacting INTEGER,
        time_archived INTEGER,
        time_suspended INTEGER,
        resume_attempts INTEGER,
        time_idle INTEGER,
        time_viewed INTEGER,
        idle_outcome TEXT
      );
    `)
    db.exec(`
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        seq INTEGER,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `)
    db.exec(`
      CREATE TABLE migration (
        id TEXT PRIMARY KEY,
        time_completed INTEGER
      );
    `)
    db.query("INSERT INTO migration (id, time_completed) VALUES (?, ?)")
      .run("20261023_1200_fixture_v2_head", T)

    const insSession = db.query(`
      INSERT INTO session_v2 (
        id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
        share_url, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
        tokens_cache_write, agent, model, time_created, time_updated, time_archived, time_compacting
      ) VALUES (
        $id, $project_id, $workspace_id, $parent_id, $slug, $directory, $path, $title, $version,
        $share_url, $cost, $tokens_input, $tokens_output, $tokens_reasoning, $tokens_cache_read,
        $tokens_cache_write, $agent, $model, $time_created, $time_updated, $time_archived, $time_compacting
      )
    `)

    const addSession = (s: SessionSpec) => {
      const created = T + s.idx * 3_600_000
      const updated = created + 600_000
      const tokens_input = s.tokens_input ?? 1000
      insSession.run({
        $id: s.id,
        $project_id: s.project_id ?? "global",
        $workspace_id: null,
        $parent_id: s.parent_id ?? null,
        $slug: s.id.replace(/^ses_/, "slug-"),
        $directory: s.directory ?? DIR_A,
        $path: (s.directory ?? DIR_A).replace(/^\//, ""),
        $title: s.title,
        $version: "2.1.3",
        $share_url: null,
        $cost: s.cost ?? 0.5,
        $tokens_input: tokens_input,
        $tokens_output: s.tokens_output ?? 500,
        $tokens_reasoning: s.tokens_reasoning ?? 100,
        $tokens_cache_read: 50,
        $tokens_cache_write: 20,
        $agent: s.agent ?? "build",
        $model: s.model ?? MODEL_A,
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

    // Big-part session (many tool items in one assistant message).
    addSession({ id: FIXTURES.sessions.big_part, title: "Big patch session", cost: 0.5, idx: 15 })

    // Pre-migration (imported V1-era) zero-cost session.
    addSession({ id: FIXTURES.sessions.pre_migration, title: "Pre migration zero cost session", cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, idx: 16 })

    // --- messages (V2 shapes) ---------------------------------------------
    const insMessage = db.query(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const addMsg = (id: string, sessionId: string, type: string, seq: number, ts: number, data: unknown) =>
      insMessage.run(id, sessionId, type, seq, ts, ts, JSON.stringify(data))
    const userMsg = (text: string, ts: number) => ({ time: { created: ts }, text })
    const asstMsg = (content: unknown[], ts: number) => ({
      time: { created: ts, streamed: ts },
      agent: "build",
      model: { id: "claude-opus-4-8", providerID: "anthropic", variant: "max" },
      content,
      finish: "stop",
      cost: 0.1,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
    })
    const textItem = (text: string) => ({ type: "text", text })
    const reasoningItem = (text: string) => ({ type: "reasoning", text })
    const toolItem = (id: string, name: string, state: Record<string, unknown>, start: number, end: number) => ({
      type: "tool", id, name, state,
      time: { created: start, completed: end },
    })

    // Active session content (V2-live style).
    addMsg(FIXTURES.messages.active_first_user, FIXTURES.sessions.active, "user", 0, T + 10,
      userMsg("Submit PR review for the session explorer. Please double-check the regex handling.", T + 10))
    addMsg("msg_fix_active_a1", FIXTURES.sessions.active, "assistant", 1, T + 20, asstMsg([
      toolItem("call_fix_done", "bash", {
        status: "completed",
        input: { command: "ls -la" },
        content: [{ type: "text", text: "ok done" }],
        metadata: {},
      }, T + 21, T + 24),
      toolItem("call_fix_err", "read", {
        status: "error",
        input: { filePath: "/x/missing.ts" },
        error: { type: "tool.execution", message: "read failed: file not found" },
      }, T + 22, T + 23),
      reasoningItem("Considering the PR review feedback before applying changes."),
    ], T + 20))

    // active002 — externalized-output tool part + a second error (for failure grouping).
    const T2 = T + 2 * 3_600_000
    const toolOutDir = process.env.OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR ?? "/tmp/opencode-tool-output"
    addMsg("msg_fix_a002_a1", "ses_fix_active002", "assistant", 1, T2 + 20, asstMsg([
      toolItem("call_fix_op", "grep", {
        status: "completed",
        input: { pattern: "foo" },
        // Whitelisted path (inside the tool-output dir) but intentionally NOT created on
        // disk, so dereference fails gracefully (null + warning) — see rehearsal CC-03c.
        metadata: { outputPath: join(toolOutDir, "tool_fix_outpath01") },
      }, T2 + 21, T2 + 22),
      toolItem("call_fix_err2", "edit", {
        status: "error",
        input: { filePath: "/x/edit.ts" },
        error: { type: "tool.execution", message: "edit failed: pattern not found" },
      }, T2 + 22, T2 + 23),
    ], T2 + 20))

    // Big-part session content.
    const TB = T + 15 * 3_600_000
    addMsg("msg_fix_bigpart_u1", FIXTURES.sessions.big_part, "user", 0, TB + 10,
      userMsg("work on the big patch please", TB + 10))
    addMsg(FIXTURES.messages.big_message_150mb, FIXTURES.sessions.big_part, "assistant", 1, TB + 20, asstMsg([
      textItem("applied the patch"),
    ], TB + 20))
    // One assistant message with 221 tool items (V2-live names, `path` inputs).
    const bigContent: unknown[] = []
    for (let i = 0; i < 220; i++) {
      bigContent.push(toolItem(`call_fix_bp_${i}`, "edit", {
        status: "completed",
        input: { path: `src/gen/file_${i}.ts` },
        content: [{ type: "text", text: `ok ${i}` }],
        metadata: {},
      }, TB + 40 + i, TB + 41 + i))
    }
    // Item #220: tool with a HUGE input object → get-part truncation path.
    bigContent.push(toolItem("call_fix_biginput", "write", {
      status: "completed",
      input: { path: "src/module/generated.ts", payload: "x".repeat(8192) },
      content: [{ type: "text", text: "written" }],
      metadata: {},
    }, TB + 300, TB + 310))
    addMsg("msg_fix_bigpart_patch", FIXTURES.sessions.big_part, "assistant", 2, TB + 30, asstMsg(bigContent, TB + 30))

    // Archived session: a user message + one compaction marker (event coverage).
    addMsg("msg_fix_arch_c0", FIXTURES.sessions.archived, "user", 0, T + 11 * 3_600_000,
      userMsg("old archived prompt", T + 11 * 3_600_000))
    addMsg("msg_fix_arch_c1", FIXTURES.sessions.archived, "compaction", 1, T + 11 * 3_600_000 + 50,
      { time: { created: T + 11 * 3_600_000 + 50 }, reason: "auto", status: "completed", summary: "compacted" })

    // Pre-migration (IMPORTED V1-era) session: toolu_ ids, cleared outputs,
    // legacy tool names + legacy `filePath` input key.
    const TP = T + 16 * 3_600_000
    addMsg("msg_fix_premig_u1", FIXTURES.sessions.pre_migration, "user", 0, TP + 10,
      userMsg("Imported era prompt about the legacy pipeline", TP + 10))
    addMsg("msg_fix_premig_a1", FIXTURES.sessions.pre_migration, "assistant", 1, TP + 20, asstMsg([
      toolItem("toolu_01FIXTURE0001", "bash", {
        status: "completed",
        input: { command: "git status" },
        content: [{ type: "text", text: "[Old tool result content cleared]" }],
        metadata: { truncated: true },
      }, TP + 21, TP + 22),
      toolItem("toolu_01FIXTURE0002", "read", {
        status: "completed",
        input: { filePath: "/legacy/path/old.ts" },
        content: [{ type: "text", text: "[Old tool result content cleared]" }],
        metadata: {},
      }, TP + 23, TP + 24),
      textItem("Legacy assistant reply"),
    ], TP + 20))

    // Tool-rename session (active009): one IMPORTED V1-era turn recording the
    // legacy names `bash`/`task`, then a V2-live turn recording the renamed
    // `shell`/`subagent` — both eras inside ONE session (alias merge coverage).
    // Each era has exactly one errored shell-family call.
    const TA = T + 9 * 3_600_000
    addMsg("msg_fix_a009_u1", FIXTURES.sessions.tool_alias, "user", 0, TA + 10,
      userMsg("Audit the shell and subagent tool calls", TA + 10))
    addMsg("msg_fix_a009_a1", FIXTURES.sessions.tool_alias, "assistant", 1, TA + 20, asstMsg([
      toolItem("toolu_01FIXALIAS001", "bash", {
        status: "completed",
        input: { command: "git log -1" },
        content: [{ type: "text", text: "[Old tool result content cleared]" }],
        metadata: {},
      }, TA + 21, TA + 22),
      toolItem("toolu_01FIXALIAS002", "bash", {
        status: "error",
        input: { command: "frobnicate" },
        error: "bash: frobnicate: command not found",
      }, TA + 23, TA + 24),
      toolItem("toolu_01FIXALIAS003", "task", {
        status: "completed",
        input: { description: "explore legacy", prompt: "map the legacy pipeline", subagent_type: "explore" },
        content: [{ type: "text", text: "legacy pipeline mapped" }],
        metadata: {},
      }, TA + 25, TA + 26),
    ], TA + 20))
    addMsg("msg_fix_a009_u2", FIXTURES.sessions.tool_alias, "user", 2, TA + 100,
      userMsg("Continue after the V2 migration", TA + 100))
    addMsg("msg_fix_a009_a2", FIXTURES.sessions.tool_alias, "assistant", 3, TA + 110, asstMsg([
      toolItem("call_fix_alias_sh1", "shell", {
        status: "completed",
        input: { command: "git status" },
        content: [{ type: "text", text: "nothing to commit" }],
        metadata: {},
      }, TA + 111, TA + 112),
      toolItem("call_fix_alias_sh2", "shell", {
        status: "error",
        input: { command: "false" },
        error: { type: "tool.execution", message: "shell: exit status 1" },
      }, TA + 113, TA + 114),
      toolItem("call_fix_alias_sub1", "subagent", {
        status: "completed",
        input: { description: "review", prompt: "review the V2 port", agent: "code-reviewer" },
        content: [{ type: "text", text: "review done" }],
        metadata: {},
      }, TA + 115, TA + 116),
    ], TA + 110))

    db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
  } finally {
    db.close()
  }
}
