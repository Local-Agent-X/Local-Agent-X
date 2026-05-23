/**
 * op_wait — explicit blocking primitive. Holds the chat turn open until the
 * named op completes or the timeout elapses. Default to NOT calling this;
 * the session bridge auto-surfaces completions in a future turn.
 */

import type { ToolDefinition } from "../../types.js";
import { awaitCanonicalOp } from "../../canonical-loop/index.js";

export const opWaitTool: ToolDefinition = {
  name: "op_wait",
  description:
    "BLOCKS your chat turn — the user CANNOT reply while this is running, and the chat UI shows a stop button. Default to NOT calling this. After op_submit_async, just tell the user 'started, I'll let you know when it's done' and return; the session bridge auto-surfaces the completion in a future turn. ONLY call op_wait if your CURRENT response cannot be composed without the op's result (e.g., the user asked 'what's the answer?' and you must read it out of the op output to reply). Phrases like 'tell me what status' or 'let me know when done' do NOT require op_wait — auto-notify handles those.",
  parameters: {
    type: "object",
    properties: {
      op_id: { type: "string", description: "The opId returned from op_submit_async." },
      timeout_ms: { type: "number", description: "Max wait in ms. Default 1800000 (30 min). Returns a timeout error if exceeded — the op keeps running and you can op_status it later." },
    },
    required: ["op_id"],
  },
  async execute(args) {
    const opId = String(args.op_id || "").trim();
    if (!opId) return { content: "op_wait requires an 'op_id'.", isError: true };

    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 30 * 60 * 1000;
    const startMs = Date.now();
    const result = await awaitCanonicalOp(opId, timeoutMs);
    const wallMs = Date.now() - startMs;

    if (!result) {
      return {
        content: `op ${opId} did not complete within ${Math.round(timeoutMs / 1000)}s. Worker may still be running — call op_status(op_id="${opId}") to check.`,
        isError: true,
      };
    }

    const summary =
      `op ${opId} ${result.status} in ${Math.round(wallMs / 1000)}s` +
      (result.error ? `\n  error: ${result.error.message}` : "") +
      (result.filesChanged.length > 0 ? `\n  files: ${result.filesChanged.slice(0, 5).join(", ")}${result.filesChanged.length > 5 ? "..." : ""}` : "") +
      `\n\n${result.finalSummary}`;

    return { content: summary, isError: result.status !== "completed" };
  },
};
