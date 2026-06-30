/**
 * Pre-blessed secrets — the canonical source for browser_fill_from_secret's
 * approval ladder (guardrail 3c).
 *
 * A user pre-blesses secret NAMES when delegating an op (op_submit_async's
 * `pre_blessed_secrets`); those names are normalized and stored on
 * op.contextPack.secrets.preBlessed. While that op's status is "running",
 * the fill gate may auto-fill the named secret WITHOUT stopping for first-use
 * approval.
 *
 * Why this is safe — the bypass is narrow by construction:
 *   - It only skips the *first-use approval* rung. Origin binding and the
 *     selector whitelist still run, and the plaintext never reaches the model.
 *   - Liveness is scoped to "running" only, so the bypass closes the instant
 *     the op finishes. A crashed op whose record is stuck at "running" can at
 *     worst auto-fill its secret onto that secret's OWN bound origin — it can
 *     never move the value off-origin or surface it to the model.
 *
 * Disk-based liveness (reading op.status from the store) intentionally replaces
 * the fork's in-process executor map: it works across the supervisor/worker
 * process boundary, where the fork's map did not.
 */

import { listOps } from "./op-store.js";
import type { Op } from "./types.js";

/**
 * Pure core: union the preBlessed secret names across the RUNNING ops in `ops`.
 * Exported so the gate logic is unit-testable without touching the op store.
 */
export function collectPreBlessedSecrets(ops: Iterable<Op>): Set<string> {
  const result = new Set<string>();
  for (const op of ops) {
    if (op.status !== "running") continue;
    const blessed = op.contextPack?.secrets?.preBlessed;
    if (blessed) for (const name of blessed) result.add(name);
  }
  return result;
}

/** The live set of pre-blessed secret names, read from the canonical op store. */
export function getActivePreBlessedSecrets(): Set<string> {
  return collectPreBlessedSecrets(listOps());
}
