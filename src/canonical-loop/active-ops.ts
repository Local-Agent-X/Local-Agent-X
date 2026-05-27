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
import { existsSync, readdirSync } from "node:fs";
import { getLaxDir } from "../lax-data-dir.js";
import { join } from "node:path";
import { readOp } from "../ops/op-store.js";
import { readLatestOpTurn } from "./store.js";

const ACTIVE_STATES = new Set(["queued", "running", "paused", "cancelling"]);
const OPS_BASE = join(getLaxDir(), "operations");

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
}

export function listActiveCanonicalOps(): ActiveCanonicalOp[] {
  if (!existsSync(OPS_BASE)) return [];
  let dirs: string[];
  try { dirs = readdirSync(OPS_BASE); } catch { return []; }

  const out: ActiveCanonicalOp[] = [];
  for (const opId of dirs) {
    const op = readOp(opId);
    if (!op) continue;
    const c = op.canonical;
    if (!c || c.flagValue !== true) continue;
    if (typeof c.state !== "string" || !ACTIVE_STATES.has(c.state)) continue;

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
    });
  }
  return out;
}
