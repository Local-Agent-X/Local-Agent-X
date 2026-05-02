/**
 * Delegate worker — submits a chat message to the worker pool as an op.
 *
 * Called by the chat route when routeMessage() returns destination=delegate.
 * Returns opId + a user-facing reply text the chat agent surfaces while
 * the worker runs in the background.
 *
 * Provider note: `provider` here is the user's currently-selected provider
 * (codex / anthropic / etc.) — passed for the routing-notice text only.
 * The worker subprocess inherits provider via the user's settings.json on
 * its own resolveProvider call.
 */

import { newOpId } from "../workers/op-store.js";
import { buildContextPack } from "../workers/context-pack-builder.js";
import { getRetryPolicy } from "../workers/heartbeat.js";
import { submitOp } from "../workers/pool.js";
import { trackOpForSession } from "../workers/session-bridge.js";
import type { Op, OpVisibility } from "../workers/types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("routing.delegate-worker");

export async function delegateMessageToWorker(
  message: string,
  sessionId: string,
  provider: string,
): Promise<{ opId: string; replyText: string }> {
  const opType = "freeform";
  const lane = "build" as const;

  const contextPack = await buildContextPack({
    description: message,
    successCriteria: [
      "Address every concrete sub-task in the user's message",
      "Apply real edits to files when the task calls for it (don't just describe what could be done)",
      "End with a brief summary of what was changed",
    ],
    constraints: [
      "Don't ask the user clarifying questions — make the best reasonable interpretation and proceed",
      "If a step is ambiguous, document the assumption in your final summary",
    ],
    lane,
    budget: { maxIterations: 30, maxWallTimeMs: 15 * 60 * 1000 },
  });

  const op: Op = {
    id: newOpId(`op_${opType}`),
    type: opType,
    task: message,
    contextPack,
    lane,
    retryPolicy: getRetryPolicy(opType),
    ownerId: "local-user",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  trackOpForSession(op.id, sessionId, message);
  void submitOp(op).catch((e) => {
    logger.warn(`op ${op.id} submit threw: ${(e as Error).message}`);
  });

  logger.info(`submitted op ${op.id} for session ${sessionId} (${message.length}ch)`);

  const providerLabel: Record<string, string> = {
    codex: "Codex (gpt-5.x)",
    anthropic: "Anthropic Claude",
    openai: "OpenAI",
    xai: "xAI Grok",
    gemini: "Google Gemini",
    local: "local model",
  };
  const providerDisplay = providerLabel[provider] || provider;
  const replyText =
    `🤖 This looks like a longer task — I'm running it in a worker so I stay responsive while you keep chatting.\n\n` +
    `**Op ${op.id}** started in the background on ${providerDisplay}. I'll surface the result here when it's done (usually 30s–3min). You'll see live status in the Agents panel; I'll narrate the result on your next message.\n\n` +
    `_Worker delegation engages on long tasks regardless of provider — the worker runs the same model in a fresh ~5K-token context instead of the full chat history, which keeps focus tight and leaves the chat free for you to talk about other things._`;

  return { opId: op.id, replyText };
}
