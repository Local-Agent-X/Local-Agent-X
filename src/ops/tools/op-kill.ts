/**
 * op_kill — cooperative cancel. With no op_id, kills the most recent live
 * non-chat-turn op for the current chat session.
 */

import type { ToolDefinition } from "../../types.js";
import { opCancel } from "../../canonical-loop/index.js";
import { readOp } from "../op-store.js";
import { listOpsForSession } from "../session-bridge.js";

export const opKillTool: ToolDefinition = {
  name: "op_kill",
  description: "Cancel a running op. The op transitions to cancelling and the adapter is aborted at the next safe boundary (sub-second for in-flight turns). Partial side-effects may persist (per spec §7). If `op_id` is omitted, kills the most recently submitted live op for the current chat session — saves the model from having to know op ids it never received cleanly.",
  parameters: {
    type: "object",
    properties: { op_id: { type: "string", description: "The opId returned from op_submit_async / op_submit. Omit to kill the most-recent live op for this session." } },
  },
  async execute(args) {
    let opId = typeof args.op_id === "string" ? args.op_id.trim() : "";
    if (!opId) {
      const sessionId = String(args._sessionId || "");
      if (!sessionId) return { content: "op_kill needs an op_id when called outside a chat session.", isError: true };
      const liveIds = listOpsForSession(sessionId);
      const live = liveIds
        .map(id => readOp(id))
        .filter((o): o is NonNullable<typeof o> => !!o)
        .filter(o => (o.status === "running" || o.status === "pending") && o.type !== "chat_turn");
      if (live.length === 0) return { content: "no live op to kill for this session.", isError: true };
      opId = live[live.length - 1].id;
    }
    const res = opCancel(opId, "op_kill");
    return { content: res.ok ? `op cancelling.` : `op was not running.`, isError: !res.ok };
  },
};
