// Read-only tool that lets the agent ask "am I still working? on what?"
//
// Purpose: when the user asks a follow-up like "are you still working on X?"
// the agent needs ground truth, not a guess. Calling `session_status` returns
// the live turn-lock registry entry for the agent's own session so it can
// answer truthfully.
//
// The tool cannot read other sessions' state — it's always scoped to the
// caller's own session ID.

import type { ToolDefinition, ToolResult } from "./types.js";
import { getActiveTurn } from "./session-turn-lock.js";

function ok(content: string): ToolResult { return { content }; }

export function createSessionStatusTool(getSessionId?: () => string): ToolDefinition {
  return {
    name: "session_status",
    description:
      "Check whether a long-running turn is in progress for YOUR CURRENT SESSION. Returns iteration count, elapsed time, and the most recent tool that was invoked. " +
      "Use this when the user asks follow-up questions like 'are you still working?' or 'what are you doing right now?' — do NOT guess, call this tool and report truthfully.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const sessionId = args._sessionId
        ? String(args._sessionId)
        : (getSessionId ? getSessionId() : "default");
      const turn = getActiveTurn(sessionId);
      if (!turn) {
        return ok(
          `No active turn for this session. The previous turn has completed (or was never in flight). If the user is asking about work that was supposedly in progress, clarify that it finished.`,
        );
      }
      const elapsedSec = Math.round(turn.elapsedMs / 1000);
      const recentTools = turn.toolsCalled.slice(-5).join(", ") || "none";
      return ok(
        `Active turn in progress for this session:\n` +
        `  - started ${elapsedSec}s ago\n` +
        `  - iteration ${turn.iteration}\n` +
        `  - most recent tool: ${turn.lastToolName || "(none yet)"}\n` +
        `  - last few tools called: ${recentTools}\n` +
        `  - has made a committing (non-idempotent) tool call: ${turn.hasCommitted ? "yes" : "no"}\n\n` +
        `Report this state to the user directly. Don't invent details not listed above.`,
      );
    },
  };
}
