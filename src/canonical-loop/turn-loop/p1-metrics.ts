/**
 * P-1 durable measurement sink.
 *
 * The `[p1-mutation-wrapup]` log line in decide-outcome.ts is greppable per-op,
 * but the server log lives at /tmp and clears on restart — useless for a
 * decision that needs weeks of real usage. This persists the aggregate counts
 * to ~/.lax/p1-metrics.json so they survive restarts. See the memory note
 * "p1-mutation-wrapup-measurement".
 *
 * `terminated`      = the mutation wrap-up shortcut was the SOLE reason the op
 *                     terminated and it stood — a promised post-mutation
 *                     follow-up MAY have been cut off (the P-1 symptom).
 * `reopenedByGate`  = same sole-decider shape, but a completion gate (build-
 *                     verify etc.) drove another turn anyway — nothing lost.
 *
 * A high terminated:reopenedByGate ratio argues for the surgical fix (honor the
 * model's tool_use "continue" signal); mostly reopened means the gates already
 * cover it and P-1 is largely moot.
 *
 * Behavior-neutral: every write is best-effort and swallowed — a metrics IO
 * failure must NEVER perturb the turn outcome.
 */
import { join } from "node:path";

import { getLaxDir } from "../../lax-data-dir.js";
import { createJsonStore } from "../../util/json-store.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.turn-loop.p1-metrics");

export type P1Outcome = "terminated" | "reopened-by-gate";

export interface P1Metrics extends Record<string, unknown> {
  terminated: number;
  reopenedByGate: number;
  /** ISO timestamp of the first recorded fire (empty until the first). */
  firstSeen: string;
  /** ISO timestamp of the most recent fire. */
  lastSeen: string;
}

function store() {
  // Resolve the path per call so a test that sets LAX_DATA_DIR before invoking
  // is honored, and nothing binds ~/.lax at module load.
  return createJsonStore<P1Metrics>(join(getLaxDir(), "p1-metrics.json"), {
    defaults: () => ({ terminated: 0, reopenedByGate: 0, firstSeen: "", lastSeen: "" }),
  });
}

/**
 * Increment the durable counter for one sole-decider fire. Best-effort: any IO
 * or serialization error is logged and swallowed so the turn is untouched.
 */
export function recordP1Outcome(outcome: P1Outcome): void {
  try {
    const now = new Date().toISOString();
    store().mutate((m) => {
      if (outcome === "terminated") m.terminated += 1;
      else m.reopenedByGate += 1;
      if (!m.firstSeen) m.firstSeen = now;
      m.lastSeen = now;
    });
  } catch (e) {
    logger.warn(`[p1-metrics] durable write failed (non-fatal): ${(e as Error).message}`);
  }
}

/** Read the accumulated counts (defaults when the file is absent/corrupt). */
export function readP1Metrics(): P1Metrics {
  return store().load();
}
