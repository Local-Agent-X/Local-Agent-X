/**
 * Enumerate active canonical-loop ops on disk.
 *
 * Active = `canonical.flagValue === true` AND `canonical.state` is one of
 * `queued | running | paused | cancelling`. Terminal states (`succeeded`,
 * `failed`, `cancelled`) are excluded.
 *
 * Used by the ops/health JSON endpoint and by `op_status` (no-opId
 * branch) so both legacy worker-pool ops AND canonical-loop ops are
 * visible in the agent activity surface. UI-only addition — does not
 * change loop behavior, signals, or events.
 */
import { opsWhere } from "../ops/op-index.js";
import { readLatestOpTurn } from "./store.js";
import type { PendingApprovalRecord } from "./types.js";

const ACTIVE_STATES = new Set(["queued", "running", "paused", "cancelling"]);

export interface ActiveCanonicalOp {
  /** Marker so callers can distinguish canonical rows from legacy pool rows. */
  path: "canonical";
  opId: string;
  lane: string | null;
  state: string;
  /** Adapter that's serving the op (e.g. "anthropic"), or null if no turn committed yet. */
  adapter: string | null;
  adapterVersion: string | null;
  startedAt: string | null;
  /** Lease expiry — null when the op is queued or paused with no live worker. */
  leaseExpiresAt: string | null;
  workerId: string | null;
  /** Chat session the op belongs to, or null for headless/cron ops. */
  sessionId: string | null;
  /**
   * Durable approval card the op is blocked on (canonical-loop/types.ts
   * PendingApprovalRecord), or null when nothing is pending. Pass-through of
   * the signal column — expiry (requestedAt + timeout) is the READER's
   * concern (routes/approvals.ts), not this listing's.
   */
  pendingApproval: PendingApprovalRecord | null;
}

/** Nearly all of the thousands of ops on disk are finished, and reading and parsing
 *  every one (144 MB on one install) froze the server ~0.5 s on each listing, which
 *  runs each time a chat connects: a voice call cut out (2026-11-05). The op index
 *  (ops/op-index.ts) knows which ops are still in flight without reading the rest. */
export function listActiveCanonicalOps(): ActiveCanonicalOp[] {
  const out: ActiveCanonicalOp[] = [];
  for (const op of opsWhere((facts) => facts.open)) {
    const opId = op.id;
    const c = op.canonical;
    if (!c || c.flagValue !== true || typeof c.state !== "string" || !ACTIVE_STATES.has(c.state)) continue;

    let adapter: string | null = null;
    let adapterVersion: string | null = null;
    try {
      const t = readLatestOpTurn(opId);
      const ps = t?.providerState;
      if (ps && typeof ps.adapterName === "string") adapter = ps.adapterName;
      if (ps && typeof ps.adapterVersion === "string") adapterVersion = ps.adapterVersion;
    } catch { /* swallow */ }

    out.push({
      path: "canonical",
      opId: op.id,
      lane: typeof op.lane === "string" ? op.lane : null,
      state: c.state,
      adapter,
      adapterVersion,
      startedAt: typeof op.startedAt === "string" ? op.startedAt : null,
      leaseExpiresAt: typeof c.leaseExpiresAt === "string" ? c.leaseExpiresAt : null,
      workerId: typeof c.leaseOwner === "string" ? c.leaseOwner : null,
      sessionId: typeof c.sessionId === "string" ? c.sessionId : null,
      pendingApproval: c.pendingApproval ?? null,
    });
  }
  return out;
}
