/**
 * Who is using a local model's runtime slot right now, so a side call on the
 * same model can wait its turn instead of evicting a chat op's prompt cache.
 *
 * The local runtime (Ollama) caches by token prefix per slot, and a request
 * that lands on the slot between two rounds of a chat op leaves the next round
 * with nothing to reuse: the whole prompt, tools and history prefill again.
 * The memory pipeline (extract, consolidation, curate) and the classifiers all
 * run on the CHAT model by design (one model per session, never a weaker one
 * on the side), and they fired mid-op; on a six-message session that was the
 * difference between ~2k and ~9k tokens re-prefilled per message and, on the
 * worst rounds, zero reuse at all (EXP-12d, docs/harness/HARNESS_LOG.md).
 *
 * So the fix is scheduling, not routing. The worker holds a lease on the op's
 * model while it drives a foreground op; a side call on that model waits for
 * the lease to clear (with a cap, then proceeds — a late memory write beats a
 * dropped one). A call the op makes FOR ITSELF — the compaction summarizer, a
 * tool-result classifier — runs inside the op's async context and passes
 * straight through, or it would wait on its own op until the cap.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "../logger.js";

const logger = createLogger("llm-dispatch.foreground-lease");

/** Lanes whose op drives a user-facing turn and owns the model's slot. */
const FOREGROUND_LANES: ReadonlySet<string> = new Set(["interactive", "agent"]);

/** A side call waits at most this long, then runs anyway (logged). Long enough
 *  for a tool round and an approval card, short of a hung op. */
export const FOREGROUND_WAIT_CAP_MS = 5 * 60_000;
const POLL_MS = 250;

interface Lease { opId: string; model: string }

const leases = new Map<string, Lease>();
const context = new AsyncLocalStorage<Lease>();

/** Run `fn` as the driver of `op`: the model's slot is leased to the op for
 *  the duration, and everything `fn` awaits runs inside the op's context. */
export async function runAsForegroundOp<T>(
  op: { id: string; lane?: string | null; model?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  if (!op.model || !op.lane || !FOREGROUND_LANES.has(op.lane)) return fn();
  const lease: Lease = { opId: op.id, model: op.model };
  leases.set(op.id, lease);
  try {
    return await context.run(lease, fn);
  } finally {
    leases.delete(op.id);
  }
}

/** Foreground ops currently leasing `model`. */
export function foregroundOpsOn(model: string): number {
  let n = 0;
  for (const lease of leases.values()) if (lease.model === model) n++;
  return n;
}

/**
 * Resolve once no foreground op leases `model`, or after `maxWaitMs`.
 * Returns true when the model was idle (or became idle), false when the cap
 * was hit and the caller is proceeding into a live op. Passes straight
 * through for a call made inside an op's own context.
 */
export async function awaitForegroundModelIdle(
  model: string,
  maxWaitMs: number = FOREGROUND_WAIT_CAP_MS,
): Promise<boolean> {
  if (context.getStore()) return true;
  if (foregroundOpsOn(model) === 0) return true;
  const started = Date.now();
  logger.info(`side call on ${model} waiting for the foreground op to finish`);
  while (foregroundOpsOn(model) > 0) {
    if (Date.now() - started >= maxWaitMs) {
      logger.warn(`side call on ${model} waited ${Math.round(maxWaitMs / 1000)}s for the foreground op — proceeding anyway`);
      return false;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  logger.info(`side call on ${model} proceeding after ${Date.now() - started}ms`);
  return true;
}

/** Test-only. */
export function _resetForegroundLeasesForTests(): void {
  leases.clear();
}
