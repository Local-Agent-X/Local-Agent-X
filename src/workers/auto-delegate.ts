/**
 * Auto-delegation: route long-task chat messages to the worker pool.
 *
 * Fix E (per supervisor architecture spec): when a chat message looks like
 * a long task AND the provider routing didn't already escape (Fix D in
 * prepare-request.ts), submit the task to the worker pool instead of
 * running it inline in the chat agent's turn.
 *
 * Why this matters for OpenAI-only users:
 *   The Codex drift problem is caused by context bloat — a 334k-token chat
 *   turn loses focus on the original task. Running the same Codex model in
 *   a worker subprocess gives it a FRESH 5K-token context (just the task
 *   pack) instead of the bloated chat history. Same model intelligence,
 *   different failure surface. No Anthropic required.
 *
 * Flow:
 *   1. Chat route checks shouldAutoDelegate(provider, message)
 *   2. If yes, calls delegateMessageToWorker() → returns opId + reply text
 *   3. Chat route streams the reply, registers the op for session-bridge
 *      notification, ends the SSE stream cleanly
 *   4. Worker runs in subprocess with fresh context
 *   5. When worker finishes, session-bridge pushes a notification back
 *      into the same chat session via the chat-ws broadcaster
 */

import { newOpId } from "./op-store.js";
import { buildContextPack } from "./context-pack-builder.js";
import { getRetryPolicy } from "./heartbeat.js";
import { submitOp } from "./pool.js";
import { trackOpForSession } from "./session-bridge.js";
import type { Op, OpVisibility } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.auto-delegate");

// Mirrors the long-task heuristic in agent-request/prepare-request.ts.
// Kept independent (not imported) so a refactor of prepare-request can't
// accidentally change auto-delegate behavior. They serve different layers
// (provider routing vs work routing) and may diverge over time.
const LONG_TASK_VERB_RE = /\b(refactor|audit|investigate|implement|build|debug|trace|analyze|migrate|rewrite|fix\s+(all|the|every|every\s+\w+|multiple)|set\s+up|wire\s+up|bootstrap|design\s+(and|then)|review\s+the)\b/i;
const MULTI_FILE_CUE_RE = /(workspace\/|src\/|node_modules|\.ts\b|\.tsx\b|\.js\b|\.py\b|across|throughout|every\s+file|multiple\s+files|all\s+the\s+(files|tests|components))/i;
const SHORT_TASK_RE = /^(yes|no|ok|sure|thanks|hi|hello|what|when|where|why|how|who)\b|^.{0,30}$/i;

/**
 * Should we delegate this chat message to the worker pool instead of
 * running it inline?
 *
 * Conditions (all must be true):
 *   - Provider is Codex (this is the drift-prone provider; Anthropic stays inline)
 *   - Message looks like a long task (would otherwise burn context)
 *   - Channel is web (bridges/cron run their own loops; don't second-guess)
 */
export function shouldAutoDelegate(provider: string, message: string, channel: string): boolean {
  if (channel !== "web") return false;
  if (provider !== "codex") return false;
  if (SHORT_TASK_RE.test(message.trim())) return false;
  const wordCount = message.split(/\s+/).length;
  if (wordCount >= 50) return true;
  if (LONG_TASK_VERB_RE.test(message) && (wordCount >= 15 || MULTI_FILE_CUE_RE.test(message))) return true;
  return false;
}

/**
 * Submit the user's message as an op_submit_async-equivalent op to the
 * worker pool. Returns the opId and a user-facing reply explaining what
 * just happened. Caller streams the reply into the chat and ends the turn.
 */
export async function delegateMessageToWorker(
  message: string,
  sessionId: string,
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

  trackOpForSession(op.id, sessionId);
  // Fire and forget — the session bridge handles the completion notification.
  void submitOp(op).catch((e) => {
    logger.warn(`[auto-delegate] op ${op.id} submit threw: ${(e as Error).message}`);
  });

  logger.info(`[auto-delegate] submitted op ${op.id} for session ${sessionId} (${message.length}ch)`);

  const replyText =
    `🤖 This looks like a longer task — I'm running it in a worker so I stay responsive while you keep chatting.\n\n` +
    `**Op ${op.id}** started in the background. I'll surface the result here when it's done (usually 30s–3min).\n\n` +
    `_Routed to a worker because: long task on Codex (your default provider). Workers run with a fresh 5K-token context instead of the full chat history, which dramatically reduces drift on long tasks. Auto-routing engages when (a) message looks like a long task and (b) Anthropic isn't available as the default provider hop._`;

  return { opId: op.id, replyText };
}
