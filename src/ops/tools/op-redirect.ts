/**
 * op_redirect — inject a latest-wins instruction into a running op. The
 * worker picks it up at the next safe boundary, no mid-step interrupt.
 */

import type { ToolDefinition } from "../../types.js";
import { opRedirect } from "../../canonical-loop/index.js";

export const opRedirectTool: ToolDefinition = {
  name: "op_redirect",
  description: "Inject a new instruction into a running op. Cooperative — the worker reads it at the next safe boundary, doesn't interrupt the current step. Latest-wins: a second redirect overwrites the first if applied before the worker picks it up.",
  parameters: {
    type: "object",
    properties: {
      op_id: { type: "string", description: "The opId returned from op_submit_async / op_submit." },
      instruction: { type: "string", description: "Plain-English instruction to inject into the worker's context." },
    },
    required: ["op_id", "instruction"],
  },
  async execute(args) {
    const opId = String(args.op_id);
    const instruction = String(args.instruction || "").trim();
    if (!instruction) return { content: "op_redirect requires an 'instruction'", isError: true };
    const res = opRedirect(opId, instruction, "op_redirect");
    return {
      content: res.ok
        ? `Instruction injected into ${opId}. Worker will pick it up at next safe boundary.`
        : `op ${opId} not running`,
      isError: !res.ok,
    };
  },
};
