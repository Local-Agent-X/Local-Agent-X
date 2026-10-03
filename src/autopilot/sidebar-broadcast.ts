/**
 * Sidebar broadcast helpers for autopilot ops.
 *
 * Autopilot ops were previously invisible to the AGENTS sidebar — they ran
 * for hours emitting nothing the user could watch. The worker pool's
 * session-bridge handles bg_op_* events for op_* IDs, but autopilot uses
 * op_ap_* IDs and runs its own loop, bypassing that bridge entirely.
 * These helpers wire autopilot directly into broadcastAll so the sidebar
 * card surfaces start / per-round progress / completion in real time.
 */

import { createLogger } from "../logger.js";
const logger = createLogger("autopilot.loop");

// Autopilot ops aren't tied to a single chat session — pass null so the
// envelope matches the worker pool's bg_op_* broadcast shape that chat.js
// expects: { type: "event", sessionId, event: { type: "bg_op_*", ... } }.
// Earlier I was sending { type: "bg_op_*", ... } at the top level, which
// chat.js silently dropped because it checks msg.event.type, not msg.type.
async function broadcast(event: Record<string, unknown>): Promise<void> {
  try {
    const { broadcastAll } = await import("../chat-ws/index.js");
    // chat.js requires sessionId TRUTHY (`if (msg.type === 'event' && msg.sessionId && msg.event)`).
    // null is falsy so it'd skip the whole bg_op handler block. Use "autopilot"
    // as a sentinel session id — chat.js doesn't route bg_op_* per-session
    // anyway (sidebar is global).
    broadcastAll({ type: "event", sessionId: "autopilot", event });
  } catch (e) {
    logger.warn(`[autopilot.loop] broadcast threw: ${(e as Error).message}`);
  }
}

export async function broadcastStarted(opId: string, topic: string): Promise<void> {
  await broadcast({ type: "bg_op_started", opId, task: topic, provider: "autopilot" });
}

export async function broadcastProgress(opId: string, line: string): Promise<void> {
  await broadcast({ type: "bg_op_progress", opId, line });
}

export async function broadcastCompleted(opId: string, summary: string, ok: boolean): Promise<void> {
  await broadcast({ type: "bg_op_completed", opId, status: ok ? "completed" : "failed", summary });
}
