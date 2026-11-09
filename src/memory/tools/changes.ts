/**
 * The memory change log (fact-events.ts) for the agent, so a user who is not
 * at Settings ("what happened to my reta dose?", "put that back") can see what
 * changed, who changed it and why, and undo it. Two tools: memory_changes
 * only reads, so its list always reaches the model; memory_undo writes.
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
    compactDescription: "See how a memory changed: who changed it, when and why, each with a change number memory_undo takes.",
    description:
      "The memory change log. With `query` (words from the memory) it lists the changes to matching memories, newest first: " +
      "each one's number, what happened (changed, retired, brought back, removed), who did it (the agent in a chat, background " +
      "extraction or cleanup, sync, the user) and why. With `fact_id` it gives one memory's whole history. " +
      "Use it when the user asks what happened to something you remembered, or says a memory is wrong or missing. " +
      "To reverse a change, call memory_undo with its number.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words from the memory whose changes to list" },
        fact_id: { type: "number", description: "One memory's number, for its whole history" },
      },
    },
    async execute(args: Record<string, unknown>) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const factId = args.fact_id != null ? Number(args.fact_id) : undefined;
      if (!query && factId === undefined) return { content: "give query or fact_id", isError: true };
      const events = memory.memoryChanges(factId !== undefined ? { factId, limit: 40 } : { contains: query, limit: 25 });
      if (events.length === 0) return { content: factId !== undefined ? `no changes recorded for memory #${factId}` : `no changes recorded to memories matching "${query}"` };
      return { content: events.map(line).join("\n") };
    },
  };
}

export function createUndoTool(memory: MemoryIndex) {
  return {
    name: "memory_undo",
    compactDescription: "Undo one memory change by its number from memory_changes. Asks the user unless they asked for it.",
    description:
      "Reverse one memory change, by the change number memory_changes lists: a retired memory is current again, a removed one " +
      "comes back, a changed one goes back to what it said. Use it when the user asks you to put a memory back. " +
      "Show the user the change first unless they asked for exactly that one.",
    parameters: {
      type: "object",
      properties: { change: { type: "number", description: "The change number to undo" } },
      required: ["change"],
    },
    confirmWithUser: (args: Record<string, unknown>, { userText }: { userText: string }) =>
      !ASKED_TO_UNDO.test(userText)
        ? `The agent wants to undo memory change #${Number(args.change)}. Approve only if you want that change reversed.`
        : null,
    async execute(args: Record<string, unknown>) {
      const change = Number(args.change);
      if (!Number.isInteger(change)) return { content: "change must be a change number from memory_changes", isError: true };
      // A job no person started does not reverse what the user changed.
      if (actsWithoutUser(sessionIdOf(args) ?? "")) return { content: "memory_undo runs only in a chat with the user", isError: true };
      const result = memory.undoMemoryChange(change, "agent:undo");
      return result.ok ? { content: result.message } : { content: `undo failed: ${result.message}`, isError: true };
    },
  };
}
