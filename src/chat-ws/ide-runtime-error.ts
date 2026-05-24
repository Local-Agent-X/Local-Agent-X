// Forward a preview-iframe runtime error into the render-verify buffer
// for whatever op is currently running on this session. Client (see
// public/js/apps-ide-errors.js) posts these as it captures them so the
// canonical loop's post-turn gate can detect a broken preview within a
// few hundred ms of the model saying "done". Silently no-ops when no op
// is bound to the session — late deliveries from a previous turn are
// fine to drop.

import { createLogger } from "../logger.js";

const logger = createLogger("chat-ws");

export async function handleIdeRuntimeError(
  sessionId: string,
  msg: Record<string, unknown>,
): Promise<void> {
  try {
    const { listOpsForSession } = await import("../ops/session-bridge.js");
    const liveOps = listOpsForSession(sessionId);
    if (liveOps.length === 0) return;
    const { pushPreviewRuntimeError } = await import("../canonical-loop/turn-loop/render-verify.js");
    const kind = typeof msg.kind === "string" ? msg.kind : "error";
    const message = typeof msg.message === "string" ? msg.message : "";
    if (!message) return;
    const source = typeof msg.source === "string" ? msg.source : undefined;
    const line = typeof msg.line === "number" ? msg.line : undefined;
    const col = typeof msg.col === "number" ? msg.col : undefined;
    const stack = typeof msg.stack === "string" ? msg.stack : undefined;
    const ts = typeof msg.ts === "number" ? msg.ts : Date.now();
    for (const opId of liveOps) {
      pushPreviewRuntimeError(opId, { kind, message, source, line, col, stack, ts });
    }
  } catch (e) {
    logger.warn(`[ws-chat] ide_runtime_error failed: ${(e as Error).message}`);
  }
}
