/**
 * Bridge-side adapter for the canonical op control-plane.
 *
 * Lets Telegram/WhatsApp steer or kill the turn that's currently running for
 * a chat — the same primitives the web UI drives through jarvis-redirect:
 *   - opCancel  (hard stop)
 *   - opRedirect (latest-wins mid-turn injection)
 *
 * Op lookup goes through resolveSession so we find the op under the key it
 * was actually tracked under. For linked identities that key is
 * `linked:<peer>`, NOT `tg-<chat>` / `wa-<phone>`, so the bridge can't
 * reconstruct it from the chat id alone.
 *
 * Dynamic imports mirror jarvis-redirect: keep the heavy canonical-loop
 * subsystem out of the bridge module-init graph.
 */

import { createLogger } from "./logger.js";
import type { ChannelType } from "./session/router.js";

const logger = createLogger("bridge-control");

async function resolveOps(channel: ChannelType, from: string, fallbackSessionId: string): Promise<string[]> {
  const { resolveSession } = await import("./session/router.js");
  const { listOpsForSession } = await import("./ops/session-bridge.js");
  const { sessionKey } = resolveSession(channel, from, fallbackSessionId);
  return listOpsForSession(sessionKey);
}

/** Hard-cancel every live op for this bridge session. Returns how many were
 *  cancelled (0 = nothing was running). The worker aborts within ~1s and the
 *  bridge's processingLock self-clears when its onMessage loop unwinds. */
export async function stopBridgeTurn(
  channel: ChannelType,
  from: string,
  fallbackSessionId: string,
  actor: string,
): Promise<number> {
  const ops = await resolveOps(channel, from, fallbackSessionId);
  if (ops.length === 0) return 0;
  const { opCancel } = await import("./canonical-loop/index.js");
  let cancelled = 0;
  for (const opId of ops) {
    const res = opCancel(opId, actor);
    if (res.ok) cancelled++;
    logger.info(`[${actor}] /stop → opCancel ${opId} ok=${res.ok}`);
  }
  return cancelled;
}

/** Inject a mid-turn instruction into the latest live op for this bridge
 *  session (latest-wins). Returns true if an op took it — false means
 *  nothing was running (caller should fall back to the normal flow). */
export async function injectBridgeTurn(
  channel: ChannelType,
  from: string,
  fallbackSessionId: string,
  text: string,
  actor: string,
): Promise<boolean> {
  const ops = await resolveOps(channel, from, fallbackSessionId);
  if (ops.length === 0) return false;
  const { opRedirect } = await import("./canonical-loop/index.js");
  const targetOpId = ops[ops.length - 1];
  const res = opRedirect(targetOpId, text, actor);
  logger.info(`[${actor}] inject → opRedirect ${targetOpId} ok=${res.ok}`);
  return res.ok;
}
