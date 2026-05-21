// Audit-only observation for internal-class tools.
//
// Routes the call into the kernel's hash-chained audit DB AND feeds it
// through the behavioral-rules pipeline — internal calls land in the same
// tamper-evident store as gated calls and count toward rate/anomaly
// thresholds. A session that calls `app_delete` 50 times in 30 seconds
// trips the same quarantine that an over-eager bash session would.
//
// Always allows the underlying call; the kernel-side decision is fixed
// "allow / audit-only". If the firewall isn't initialized yet, falls back
// to a logger.info side-channel so coverage isn't lost during early boot.
//
// Distinct from ariEvaluate:
//   - ariEvaluate: gated I/O classes — taint analysis, capability check, can deny.
//   - ariObserve: internal class — kernel audit + behavioral observation
//     without I/O gating (none applies).

import { createLogger } from "../logger.js";
import { getFirewall, isAriActive } from "./state.js";

const logger = createLogger("ari-kernel");

export function ariObserve(
  toolName: string,
  action: string,
  params: Record<string, unknown>,
  opts: { sessionId?: string } = {},
): void {
  if (!isAriActive()) return;

  // Strip executor-injected keys (_sessionId etc.) and truncate large values
  // so the audit row stays small. The kernel's auditStore serializes
  // toolCall+decision as JSON; bloated parameters blow up row size and
  // make replays slow.
  const sampled: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith("_")) continue;
    let s: string;
    try { s = typeof v === "string" ? v : JSON.stringify(v); }
    catch { s = "<unserializable>"; }
    sampled[k] = s.length > 200 ? s.slice(0, 197) + "..." : s;
  }

  // Hash-chained audit entry + behavioral evaluation. Best-effort: if the
  // kernel call throws (DB locked, schema mismatch on hot-reload), fall back
  // to the logger so the trail isn't lost.
  try {
    const fw = getFirewall();
    const qi = fw!.audit({
      toolClass: "internal",
      action,
      parameters: { ...sampled, _tool: toolName, ...(opts.sessionId ? { _sess: opts.sessionId.slice(0, 12) } : {}) },
    });
    if (qi) {
      logger.warn(`[ari-observe] quarantine triggered by ${toolName}/${action}: ${qi.reason}`);
    }
  } catch (e) {
    logger.warn(`[ari-observe] kernel audit failed for ${toolName}: ${(e as Error).message} — falling back to log`);
  }

  // Keep the human-readable side-channel for grep convenience. The audit DB
  // is the authoritative tamper-evident record; this is just operator UX.
  const sess = opts.sessionId ? `sess=${opts.sessionId.slice(0, 12)} ` : "";
  logger.info(`[ari-observe] ${toolName}/${action} ${sess}params=${JSON.stringify(sampled)}`);
}
