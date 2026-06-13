/**
 * opencode-sessions-explorer-session-genealogy
 *
 * Walk the parent_id chain (ancestors) and the descendants tree from a session.
 * Depth-bounded to avoid runaway recursion. Cap: 64 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { table } from "../lib/table.js"

type Mini = { id: string; title: string; agent: string | null; time_created: number; time_archived: number | null }

export const sessionGenealogy = tool({
  description:
    "opencode-sessions-explorer: walk the OpenCode session parent/child tree to trace subagent dispatches and pair-execution chains. " +
    "Answers: \"what's the parent chain of session ses_X\", \"what subagents were spawned from ses_Y\", \"genealogy of session ses_Z\", \"what sessions did ses_W create\", \"trace the pair-execution tree from ses_X\", \"who are the descendants of session ses_X\", \"who is the orchestrator that launched ses_Y\". " +
    "OpenCode subagent dispatches and pair-execution (executor-opus + executor-gpt, etc.) create child sessions linked via parent_id; this tool walks that graph in either direction. " +
    "direction:'ancestors' walks UP parent_id chains; 'descendants' walks DOWN to child sessions; 'both' returns both arms. Depth-bounded by max_depth (default 5, max 10) to prevent runaway traversal. Optional include_archived to prune archived branches.",
  args: {
    session_id: tool.schema.string().describe("Session ID"),
    direction: tool.schema.enum(["ancestors", "descendants", "both"]).default("both"),
    max_depth: tool.schema.number().int().min(1).max(10).default(5),
    include_archived: tool.schema.boolean().default(true).describe("If false, prune archived branches"),
  },
  async execute(args) {
    return runWithEnvelope("session_genealogy", 64, async (ctx) => {
      const root = stmt(`SELECT id, title, parent_id, agent, time_created, time_archived FROM session WHERE id = ?`).get(args.session_id) as any
      if (!root) fail("NOT_FOUND", `session not found: ${args.session_id}`)

      const ancestors: Mini[] = []
      if (args.direction !== "descendants") {
        let cur: any = root
        const seen = new Set<string>([root.id])
        for (let d = 0; d < args.max_depth; d++) {
          if (!cur?.parent_id) break
          if (seen.has(cur.parent_id)) { ctx.warnings.push("cycle detected in parent chain"); break }
          const p = stmt(`SELECT id, title, parent_id, agent, time_created, time_archived FROM session WHERE id = ?`).get(cur.parent_id) as any
          if (!p) { ctx.warnings.push(`dangling parent_id: ${cur.parent_id}`); break }
          if (!args.include_archived && p.time_archived != null) break
          ancestors.push({ id: p.id, title: p.title, agent: p.agent, time_created: p.time_created, time_archived: p.time_archived })
          seen.add(p.id)
          cur = p
        }
      }

      type Node = Mini & { children: Node[] }
      const buildTree = (id: string, depth: number, seen: Set<string>): Node | null => {
        if (depth >= args.max_depth) return null
        if (seen.has(id)) { ctx.warnings.push(`cycle in descendants at ${id}`); return null }
        seen.add(id)
        const me = stmt(`SELECT id, title, agent, time_created, time_archived FROM session WHERE id = ?`).get(id) as any
        if (!me) return null
        const children = stmt(`SELECT id FROM session WHERE parent_id = ?`).all(id) as { id: string }[]
        const visibleChildren: Node[] = []
        for (const c of children) {
          const sub = buildTree(c.id, depth + 1, new Set(seen))
          if (!sub) continue
          if (!args.include_archived && sub.time_archived != null) continue
          visibleChildren.push(sub)
        }
        return { id: me.id, title: me.title, agent: me.agent, time_created: me.time_created, time_archived: me.time_archived, children: visibleChildren }
      }
      const descendants = args.direction !== "ancestors" ? buildTree(root.id, 0, new Set()) : null

      return {
        root: { id: root.id, title: root.title, agent: root.agent, time_created: root.time_created, time_archived: root.time_archived },
        ancestors: table(ancestors, { dict: ["agent"] }),
        descendants_tree: descendants,
      }
    })
  },
})
