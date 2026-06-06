// Read-only tool: lets the agent recall what it has DONE across this
// conversation — the tools it ran and whether they succeeded — without
// re-reading the whole transcript.
//
// Backed by the operational action ledger (ops/action-ledger.ts), which is
// written once per committed turn. Unlike session_status (live turn only) this
// spans past messages and past ops in the same session, so the agent can
// answer "did that already fail?" / "what have I tried?" truthfully instead of
// guessing.
//
// Always scoped to the caller's own session.

import type { ToolDefinition, ToolResult } from "../types.js";
import { readSessionActions } from "../ops/action-ledger.js";

function ok(content: string): ToolResult { return { content }; }

export function createReadMyLogsTool(getSessionId?: () => string): ToolDefinition {
  return {
    name: "read_my_logs",
    description:
      "Review what YOU have actually done earlier in this conversation — the tools you ran and whether each succeeded or failed. " +
      "Use this before retrying something to check if you already tried it (and what happened), or when the user asks 'what have you done so far?'. " +
      "Returns recent actions newest-last with outcome marks. Scoped to your own session; read-only.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max recent turns to return (default 20)." },
        only_failures: { type: "boolean", description: "If true, return only turns that had at least one failed action." },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const sessionId = args._sessionId
        ? String(args._sessionId)
        : (getSessionId ? getSessionId() : "");
      if (!sessionId) {
        return ok("No session in scope — nothing to report.");
      }
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;
      const onlyFailures = args.only_failures === true;

      let entries = readSessionActions(sessionId, { limit });
      if (onlyFailures) {
        entries = entries.filter(e => e.actions.some(a => a.status === "error"));
      }
      if (entries.length === 0) {
        return ok(
          onlyFailures
            ? "No failed actions recorded for this conversation."
            : "No actions recorded yet for this conversation. You haven't run any tools, or this is the first turn.",
        );
      }

      const lines = entries.map(e => {
        const acts = e.actions
          .map(a => `${a.tool}${a.status === "ok" ? "✓" : a.status === "error" ? "✗" : "⊘"}`)
          .join(", ");
        const when = e.ts.replace("T", " ").slice(0, 16);
        const surface = e.opType === "chat_turn" ? "" : ` (${e.opType})`;
        return `- ${when}${surface}: ${acts}`;
      });

      return ok(
        `Your recent actions in this conversation (oldest→newest):\n${lines.join("\n")}\n\n` +
        `Report truthfully from this — don't claim work that isn't listed.`,
      );
    },
  };
}
