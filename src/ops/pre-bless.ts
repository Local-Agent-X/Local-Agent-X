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

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPS_BASE, TERMINAL_STATUSES, readOp } from "./op-store.js";
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

/**
 * A scan of the op store that re-reads only the operation.json files whose
 * size or mtime changed since its last call, and keeps just what the bless
 * needs: the names a running op blesses (empty for every other op).
 *
 * Why not listOps(): every vault destination check asks this question, and
 * each IMAP tool's availability predicate makes one, so a chat or voice turn
 * asked it six times while building its prompt. listOps() parses every op
 * ever run (2,095 files, 107 MB on the owner's machine), ~450 ms a call, and
 * that was 2.7 s of every turn's wait before its first word. Liveness still
 * comes from disk, so an op a worker process moves to or from "running" is
 * seen on the next call: the supervisor writes operation.json by tmp + rename,
 * which changes its mtime.
 *
 * An op read once in a terminal status is never looked at again: the state
 * machine has no transition out of one, so it can never bless. Without that a
 * stat of every op ever run was ~75 ms a call at 3,844 ops and grew with each
 * op, and a spoken turn made twelve calls. What is left is one directory
 * listing and a stat per op still in flight.
 */
export function createPreBlessScanner(
  opsDir: string,
  read: (opId: string) => Op | null,
): () => Set<string> {
  const seen = new Map<string, { mtimeMs: number; size: number; names: readonly string[]; settled: boolean }>();
  return () => {
    let ids: string[];
    try { ids = readdirSync(opsDir); } catch { return new Set(); } // no ops dir yet: nothing is running
    const present = new Set(ids);
    for (const id of seen.keys()) if (!present.has(id)) seen.delete(id);
    const result = new Set<string>();
    for (const id of ids) {
      let entry = seen.get(id);
      if (entry?.settled) continue;
      let stat;
      try { stat = statSync(join(opsDir, id, "operation.json")); } catch { seen.delete(id); continue; } // dir without a record yet
      if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
        const op = read(id);
        entry = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          names: op ? [...collectPreBlessedSecrets([op])] : [],
          settled: !!op && TERMINAL_STATUSES.includes(op.status),
        };
        seen.set(id, entry);
      }
      for (const name of entry.names) result.add(name);
    }
    return result;
  };
}

let scanOpStore: (() => Set<string>) | undefined;

/** The live set of pre-blessed secret names, read from the canonical op store. */
export function getActivePreBlessedSecrets(): Set<string> {
  scanOpStore ??= createPreBlessScanner(OPS_BASE, readOp);
  return scanOpStore();
}
