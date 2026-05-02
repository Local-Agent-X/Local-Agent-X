/**
 * Subagent completion drain — push-based signaling so the parent
 * doesn't burn iterations polling agent_status. Pulls any pending
 * subagent results from the completion queue and injects them as a
 * synthetic user message.
 *
 * No-op when sessionId is missing or the queue is empty.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { LoopMiddleware } from "../types.js";

export const subagentDrainMiddleware: LoopMiddleware = {
  name: "subagent-drain",

  async beforeIteration(ctx) {
    if (!ctx.req.sessionId) return { kind: "continue" };
    try {
      const { drainCompletions, formatCompletionMessage } = await import("../../agency/completion-queue.js");
      const notices = drainCompletions(ctx.req.sessionId);
      if (notices.length === 0) return { kind: "continue" };
      ctx.messages.push({
        role: "user",
        content: formatCompletionMessage(notices),
      } as ChatCompletionMessageParam);
    } catch {
      // Completion queue is optional infrastructure — don't fail the
      // turn if it's missing or misbehaving.
    }
    return { kind: "continue" };
  },
};
