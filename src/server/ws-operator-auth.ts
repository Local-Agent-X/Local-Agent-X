// WebSocket-upgrade authorization for the local operator.
//
// The desktop server accepts WS upgrades (/ws/chat, /ws/voice) from ONE
// principal: the local operator (the Electron UI and the broker phone both
// reach the desktop over loopback as the operator — the broker chat/voice
// bridges connect with the operator token). This is the single place that
// decides whether an upgrade is allowed: a timing-safe operator-token compare,
// nothing else. Rejections carry an actionable reason so the caller can close
// with a clear message instead of a silent hang.

import { timingSafeEqual } from "node:crypto";

/** WS close code for an unauthorized/rejected upgrade. */
export const WS_UNAUTHORIZED = 4401;

export interface UpgradeAuthResult {
  ok: boolean;
  /** Principal kind for an accepted connection. */
  principal?: "operator";
  /** Actionable reason on rejection (sent as the WS close message). */
  reason?: string;
}

function constTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Authorize a WS upgrade. Accepts ONLY the operator token (timing-safe compare).
 * Returns an actionable reason on rejection so the caller can close with a clear
 * message instead of a silent hang.
 */
export function authorizeUpgrade(token: string, operatorToken: string): UpgradeAuthResult {
  if (token && operatorToken && constTimeEq(token, operatorToken)) {
    return { ok: true, principal: "operator" };
  }
  return { ok: false, reason: "Unauthorized" };
}
