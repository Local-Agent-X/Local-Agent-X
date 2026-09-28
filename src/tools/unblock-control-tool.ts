// Re-surface the control that clears a security block, for the session that
// asks. "Show me the unblock button again" has no answer once the card has
// scrolled into a collapsed activity group or a reload dropped it; this tool
// emits a fresh result whose metadata carries the same block shape the chat
// renders the notice from, for the session's CURRENT state only. It shows; it
// never clears — declassify is the user's click (routes/security.ts).

import type { ToolDefinition, ToolResult } from "../types.js";
import { getTaintSummary } from "../data-lineage/index.js";
import { readKernelQuarantine } from "../ari-kernel/index.js";

export const showUnblockControlTool: ToolDefinition = {
  name: "show_unblock_control",
  description:
    "Show the user the control that clears a security block in THIS session, if one exists. Call it when the user asks to see the unblock / declassify button again, or asks why your calls are being refused. " +
    "It only SHOWS the control — the user clicks it; you cannot clear a block yourself. When nothing is blocked it says so plainly: then just retry the call that was refused.",
  readOnly: true,
  parameters: { type: "object", properties: {}, required: [] },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = String(args._sessionId || "default");
    const opId = typeof args._operationId === "string" ? args._operationId : undefined;

    const taint = getTaintSummary(sessionId);
    if (taint.count > 0) {
      return {
        content:
          `This session is quarantined by ${taint.count} sensitive read${taint.count === 1 ? "" : "s"} (source${taint.sources.length === 1 ? "" : "s"}: ${taint.sources.join(", ")}), ` +
          "so outbound calls that carry that data are refused. The \"Declassify & retry\" control is shown on this card; only the user can click it. " +
          "Tell them it is there and what clearing it releases. Do not retry the blocked call until they have.",
        status: "ok",
        metadata: { layer: "quarantine-notice", clearable: "declassify", scope: "session-memory", taint_sources: taint.sources.join(",") },
      };
    }

    const q = readKernelQuarantine(opId, false);
    if (q) {
      return {
        content:
          `The security kernel has this turn in restricted mode since ${q.restrictedAt} (${q.rule ?? q.trigger}: ${q.reason}). ` +
          "No session taint is involved, so there is no control to show and nothing for the user to clear: the kernel run state belongs to this turn and the next user message starts clean. " +
          "Report what was refused and end the turn.",
        status: "ok",
        metadata: { layer: "quarantine-notice", rule: q.rule ?? q.trigger, trigger: "restricted", scope: "operation", quarantine: q },
      };
    }

    return {
      content:
        "Nothing is blocked in this session: no sensitive-read taint is recorded and this turn's kernel run state is clean. " +
        "There is no control to show. If a call was refused earlier, it was scoped to that turn — retry it now.",
    };
  },
};
