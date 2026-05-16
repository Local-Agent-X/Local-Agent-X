import { createLogger } from "../../logger.js";
import type { ServerEvent } from "../../types.js";
import type { SseSink } from "./run-chat-turn.js";

const logger = createLogger("routes.chat.jarvis-redirect");

interface JarvisRedirectArgs {
  sessionId: string;
  message: string;
  recentSessionMessages: Array<{ role: string; content?: unknown }>;
  /** SSE side-channel sink — null for WS-only callers. The redirect ack
   *  delta goes here when present; WS subscribers receive it via the
   *  normal chat-ws pub/sub on subsequent worker_stream events. */
  sseSink: SseSink;
}

/**
 * Step 2 of JARVIS-mode: redirect-to-active-worker.
 *
 * If a worker is already running for this session, the user's new message
 * might be feedback for the worker ("make it blue") rather than a new chat
 * turn. Classify it; if the LLM says REDIRECT, forward to the worker via
 * `redirectOp()` and emit a small ack into chat. Returns `true` if the
 * message was redirected (caller should return immediately and skip the
 * normal chat flow).
 */
export async function tryWorkerRedirect(args: JarvisRedirectArgs): Promise<boolean> {
  const { sessionId, message, recentSessionMessages, sseSink } = args;
  try {
    const { listOpsForSession, getOpTask } = await import("../../workers/session-bridge.js");
    const activeOps = listOpsForSession(sessionId);
    if (activeOps.length === 0) return false;

    const { opRedirect } = await import("../../canonical-loop/index.js");
    const { classifyWorkerRedirect } = await import("../../routing/worker-redirect-classifier.js");

    // Pick the most recently submitted op as the redirect target
    // (Set iteration preserves insertion order in JS).
    const targetOpId = activeOps[activeOps.length - 1];
    const taskHint = getOpTask(targetOpId);

    // Feed the classifier the last few main-agent turns. Without this,
    // Haiku sees only (workerTask, message) and a "yes" answering the MAIN
    // agent's question gets misrouted to the worker. With recent turns,
    // Haiku can see the question that "yes" is answering and route to
    // MAIN_AGENT.
    const recentTurns = recentSessionMessages
      .filter((m): m is { role: "user" | "assistant"; content: string } =>
        (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
      )
      .slice(-4)
      .map(m => ({ role: m.role, content: m.content }));

    const cls = await classifyWorkerRedirect(message, taskHint, recentTurns);
    if (!cls?.redirect) return false;

    const res = opRedirect(targetOpId, message, "jarvis-redirect");
    logger.info(`[router] worker-redirect → op=${targetOpId} ok=${res.ok} reason="${cls.reason}"`);
    if (!res.ok) return false;

    // Emit an inline ack so the user sees their message landed.
    // Worker will narrate its acknowledgement via the worker_stream channel
    // (Step 1) on its next iteration. WS-only callers get no ack here
    // (sseSink === null) — they still see the worker_stream events that
    // follow, which is the same observable behavior as the previous
    // HTTP-self-loop implementation (WS clients didn't subscribe to the
    // drained SSE body either).
    if (sseSink) {
      sseSink({
        type: "stream",
        delta: `*→ telling the worker:* "${message.slice(0, 200)}"\n\n`,
      });
      sseSink({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as ServerEvent);
    }
    return true;
  } catch (e) {
    logger.warn(`[router] worker-redirect check failed (falling through): ${(e as Error).message}`);
    return false;
  }
}
