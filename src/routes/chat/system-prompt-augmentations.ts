import type { PreparedAgentRequest } from "../../agent-request.js";
import type { ThreatEngine } from "../../threat-engine.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("routes.chat.system-prompt");

/**
 * Mutate `prepared.systemPrompt` to add:
 *  1. The threat-engine canary block (security: detects prompt-injection by
 *     watching model output for tokens that should never leak).
 *  2. A "PARALLEL CONTEXT" block when background workers are already running
 *     for this session, so the main agent doesn't try to redo their work.
 *
 * Mutates in place because `runChatViaCanonical` reads
 * `prepared.systemPrompt` directly downstream. If we built a separate local,
 * the canary would never reach the model and `threatEngine.checkOutput`
 * would run against text seeded with a canary the model never saw — false
 * negatives by design.
 */
export async function augmentSystemPrompt(
  prepared: Pick<PreparedAgentRequest, "systemPrompt">,
  threatEngine: ThreatEngine,
  sessionId: string,
): Promise<void> {
  prepared.systemPrompt += threatEngine.getCanaryBlock();

  try {
    const { listOpsForSession, getOpTask } = await import("../../workers/session-bridge.js");
    const activeOpIds = listOpsForSession(sessionId);
    if (activeOpIds.length > 0) {
      const taskLines = activeOpIds.map(id => {
        const t = getOpTask(id) || "(unknown task)";
        return `  - ${t.slice(0, 160)}`;
      }).join("\n");
      prepared.systemPrompt +=
        `\n\n[PARALLEL CONTEXT — ${activeOpIds.length} background worker${activeOpIds.length === 1 ? "" : "s"} active]\n` +
        `These workers are already running in separate processes for the user. You can SEE their progress streaming into the same chat. Do NOT try to do their work — they're already on it.\n\n` +
        `Active:\n${taskLines}\n\n` +
        `Respond to the user's CURRENT message normally. If they're asking something unrelated to the worker(s), answer it. If they're asking about a worker's status, you can refer to what you've seen in its progress stream. If they're giving feedback for a worker, that's already auto-routed via the redirect classifier — you don't need to handle it here. Speak naturally about the parallel context — like JARVIS would when Tony talks to him while a build is in progress.`;
    }
  } catch (e) {
    logger.warn(`[chat] parallel-worker awareness failed (proceeding without): ${(e as Error).message}`);
  }
}
