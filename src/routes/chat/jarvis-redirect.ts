import { createLogger } from "../../logger.js";
import type { ServerEvent } from "../../types.js";

const logger = createLogger("routes.chat.jarvis-redirect");

interface JarvisRedirectArgs {
  sessionId: string;
  message: string;
  recentSessionMessages: Array<{ role: string; content?: unknown }>;
  /** Transport-agnostic emitter for the redirect ack + terminal done —
   *  the orchestrator wires it to sseSink on HTTP and to chatWs.emit
   *  (broadcastToSession) on WS, same as emitTurnError. It must reach the
   *  client on EVERY transport: the browser's send path optimistically
   *  starts a local turn (placeholder bubble, STREAMING state, no opId), so
   *  a redirect that consumes the message without a chat-lane `done` leaves
   *  that turn spinning forever — no chat op ever starts, the stuck-stream
   *  watchdog only watches ops with an opId, and the finally's failChat net
   *  no-ops because no ActiveChat was registered. Live failure 2026-07-13:
   *  "can we use photos?" redirected to a running app_build; WS client sat
   *  on the thinking placeholder for the rest of the build. */
  emit: (event: ServerEvent) => void;
  ingressKey?: string;
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
  const { sessionId, message, recentSessionMessages, emit, ingressKey } = args;
  try {
    const { listOpsForSession, getOpTask } = await import("../../ops/session-bridge.js");
    const activeOps = listOpsForSession(sessionId);
    if (activeOps.length === 0) return false;

    // Redirect only to a LIVE background worker — same filter op_kill applies.
    // The session map also tracks the interactive host turn itself
    // (chat_turn/voice_turn) and ops that are cancelling/terminal; without
    // this filter a still-streaming chat turn can be the newest tracked op
    // and the user's message ("make the header blue") is redirected into the
    // dying turn and lost.
    const { readOp, isInteractiveHostOpType } = await import("../../ops/op-store.js");
    const liveWorkers = activeOps
      .map(id => readOp(id))
      .filter((o): o is NonNullable<typeof o> => !!o)
      .filter(o => (o.status === "running" || o.status === "pending") && !isInteractiveHostOpType(o.type));
    if (liveWorkers.length === 0) return false;

    const { opRedirect, opRedirectOnce } = await import("../../canonical-loop/index.js");
    const { classifyWorkerRedirect } = await import("../../routing/worker-redirect-classifier.js");

    // Pick the most recently submitted live worker as the redirect target
    // (Set iteration preserves insertion order in JS).
    const targetOpId = liveWorkers[liveWorkers.length - 1].id;
    const taskHint = getOpTask(targetOpId);

    // Feed the classifier the last few main-agent turns. Without this, it
    // sees only (workerTask, message) and a "yes" answering the MAIN agent's
    // question gets misrouted to the worker. With recent turns, it can see the
    // question that "yes" is answering and route to MAIN_AGENT.
    const recentTurns = recentSessionMessages
      .filter((m): m is { role: "user" | "assistant"; content: string } =>
        (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
      )
      .slice(-4)
      .map(m => ({ role: m.role, content: m.content }));

    const cls = await classifyWorkerRedirect(message, taskHint, recentTurns);
    if (!cls?.redirect) return false;

    const res = ingressKey
      ? opRedirectOnce(targetOpId, message, "jarvis-redirect", ingressKey)
      : opRedirect(targetOpId, message, "jarvis-redirect");
    logger.info(`[router] worker-redirect → op=${targetOpId} ok=${res.ok} reason="${cls.reason}"`);
    if (!res.ok) return false;

    // Emit an inline ack so the user sees their message landed, then the
    // terminal done so the client's optimistic turn ends cleanly (the
    // worker narrates its acknowledgement via the worker_stream channel on
    // its next iteration). This must fire on every transport — see the
    // `emit` doc comment above for the WS stranded-turn failure this closes.
    emit({
      type: "stream",
      delta: `*→ telling the worker:* "${message.slice(0, 200)}"\n\n`,
    });
    emit({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as ServerEvent);
    return true;
  } catch (e) {
    logger.warn(`[router] worker-redirect check failed (falling through): ${(e as Error).message}`);
    return false;
  }
}
