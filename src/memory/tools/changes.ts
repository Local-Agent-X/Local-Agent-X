/**
 * memory_changes: the memory change log (fact-events.ts) for the agent, so a
 * user who is not at Settings ("what happened to my reta dose?", "put that
 * back") can see what changed, who changed it and why, and undo it.
 */
import type { MemoryIndex } from "../index.js";
import type { FactEvent } from "../fact-events.js";
import { localDate } from "../retrieval-format.js";
import { sessionIdOf } from "../../tool-execution/internal-args.js";
import { actsWithoutUser } from "../synthetic-sessions.js";

const ASKED_TO_UNDO = /\b(undo|undid|restore|revert|bring (?:it |that |them )?back|put (?:it |that |them )?back|change (?:it |that )?back)\b/i;

function line(e: FactEvent): string {
  const text = String(e.after?.content ?? e.before?.content ?? "(erased at the user's request)");
  const was = e.op === "change" && e.before?.content !== e.after?.content ? ` (was: ${String(e.before?.content).slice(0, 160)})` : "";
  const why = e.reason ? ` — ${e.reason.slice(0, 200)}` : "";
  const undone = e.undoneBy != null ? " [undone]" : "";
  return `change #${e.id} · ${e.op} memory #${e.factId} by ${e.actor ?? "unknown"} on ${localDate(e.at)}${undone}: ${text.slice(0, 200)}${was}${why}`;
}

export function createChangesTool(memory: MemoryIndex) {
  return {
    name: "memory_changes",
    compactDescription: "See how a memory changed (who, when, why), or undo one change by its number. Use when the user asks what happened to something you remembered, or to put it back.",
    description:
      "The memory change log. With `query` (words from the memory) it lists the changes to matching memories, newest first: " +
      "each one's number, what happened (changed, retired, brought back, removed), who did it (the agent in a chat, background " +
      "extraction or cleanup, sync, the user) and why. With `fact_id` it gives one memory's whole history. " +
      "With `undo` (a change number) it reverses that change: a retired memory is current again, a removed one comes back, " +
      "a changed one goes back to what it said. Use it when the user asks what happened to something you remembered, says a memory " +
      "is wrong or missing, or asks you to put it back. Show the user the change before undoing it unless they asked for exactly that.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words from the memory whose changes to list" },
        fact_id: { type: "number", description: "One memory's number, for its whole history" },
        undo: { type: "number", description: "The change number to undo" },
      },
    },
    confirmWithUser: (args: Record<string, unknown>, { userText }: { userText: string }) =>
      args.undo != null && !ASKED_TO_UNDO.test(userText)
        ? `The agent wants to undo memory change #${Number(args.undo)}. Approve only if you want that change reversed.`
        : null,
    async execute(args: Record<string, unknown>) {
      if (args.undo != null) {
        // A job no person started does not reverse what the user changed.
        if (actsWithoutUser(sessionIdOf(args) ?? "")) return { content: "memory_changes undo runs only in a chat with the user", isError: true };
        const result = memory.undoMemoryChange(Number(args.undo), "agent:undo");
        return result.ok ? { content: result.message } : { content: `undo failed: ${result.message}`, isError: true };
      }
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const factId = args.fact_id != null ? Number(args.fact_id) : undefined;
      if (!query && factId === undefined) return { content: "give query or fact_id (or undo with a change number)", isError: true };
      const events = memory.memoryChanges(factId !== undefined ? { factId, limit: 40 } : { contains: query, limit: 25 });
      if (events.length === 0) return { content: factId !== undefined ? `no changes recorded for memory #${factId}` : `no changes recorded to memories matching "${query}"` };
      return { content: events.map(line).join("\n") };
    },
  };
}
