// Forward a preview runtime error into the render-verify buffer. Two ingress
// surfaces feed the same gate:
//   - desktop preview iframe → WS `ide_runtime_error` (session-keyed) — the
//     client (public/js/apps-ide-errors.js) posts as it captures
//   - phone-served app over the broker → POST /api/apps/<id>/runtime-error
//     (app-keyed) — the server-injected capture core posts (error-pipe-inject.ts)
// Both silently no-op when no live op is bound — late deliveries from a
// previous turn are fine to drop.

import { createLogger } from "../logger.js";
import type { PreviewRuntimeError } from "../canonical-loop/turn-loop/render-verify.js";

const logger = createLogger("chat-ws");

function parseRuntimeError(msg: Record<string, unknown>): PreviewRuntimeError | null {
  const message = typeof msg.message === "string" ? msg.message : "";
  if (!message) return null;
  return {
    kind: typeof msg.kind === "string" ? msg.kind : "error",
    message,
    source: typeof msg.source === "string" ? msg.source : undefined,
    line: typeof msg.line === "number" ? msg.line : undefined,
    col: typeof msg.col === "number" ? msg.col : undefined,
    stack: typeof msg.stack === "string" ? msg.stack : undefined,
    ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
  };
}

export async function handleIdeRuntimeError(
  sessionId: string,
  msg: Record<string, unknown>,
): Promise<void> {
  try {
    const { listOpsForSession } = await import("../ops/session-bridge.js");
    const liveOps = listOpsForSession(sessionId);
    if (liveOps.length === 0) return;
    const err = parseRuntimeError(msg);
    if (!err) return;
    const { pushPreviewRuntimeError } = await import("../canonical-loop/turn-loop/render-verify.js");
    for (const opId of liveOps) {
      pushPreviewRuntimeError(opId, err);
    }
  } catch (e) {
    logger.warn(`[ws-chat] ide_runtime_error failed: ${(e as Error).message}`);
  }
}

export async function handleAppRuntimeError(
  appId: string,
  msg: Record<string, unknown>,
): Promise<void> {
  try {
    const err = parseRuntimeError(msg);
    if (!err) return;
    const { listOpsForApp, pushPreviewRuntimeError } = await import("../canonical-loop/turn-loop/render-verify.js");
    for (const opId of listOpsForApp(appId)) {
      pushPreviewRuntimeError(opId, err);
    }
  } catch (e) {
    logger.warn(`[ws-chat] app runtime_error failed: ${(e as Error).message}`);
  }
}
