/**
 * Interject drain — Step 4 of JARVIS-mode. At the start of each
 * iteration, pull any queued user messages from the inject queue
 * (pushed by chat-ws when user types during an in-flight turn) and
 * push them as user-role messages so the agent sees them on this
 * iteration. Same pattern subagent-drain uses for completion notices.
 *
 * No-op when sessionId is missing or queue is empty.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { LoopMiddleware } from "../types.js";
import { drainInjects } from "../inject-queue.js";

export const interjectDrainMiddleware: LoopMiddleware = {
  name: "interject-drain",

  beforeIteration(ctx) {
    if (!ctx.req.sessionId) return { kind: "continue" };
    const injects = drainInjects(ctx.req.sessionId);
    if (injects.length === 0) return { kind: "continue" };
    for (const text of injects) {
      ctx.messages.push({ role: "user", content: text } as ChatCompletionMessageParam);
    }
    return { kind: "continue" };
  },
};
