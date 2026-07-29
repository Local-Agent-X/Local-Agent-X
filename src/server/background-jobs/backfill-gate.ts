/**
 * memory-backfill scheduling gate — when a corpus-wide scan is allowed to start.
 *
 * Split out of ./index.ts (which re-exports this surface) because it is a
 * single responsibility with its own test file: index.ts wires every background
 * job, this file only decides the timing of one of them.
 *
 * What this file is NOT: the thing that keeps the app responsive DURING a scan.
 * That is the paced walk in memory/universal-index-backfill.ts, which yields
 * the event loop between files. These gates only pick a starting moment.
 */

import { createLogger } from "../../logger.js";

// Same namespace as ./index.ts on purpose: these log lines were emitted from
// there before the split and should read identically in server.log.
const logger = createLogger("server.background-jobs");

/** How long a deferred backfill waits before deciding again. Both reasons are
 *  transient contention that clears within a minute, so both re-check on the
 *  same bounded delay. NEITHER value is what keeps the app responsive DURING a
 *  run — the walk itself yields between files (see
 *  memory/universal-index-backfill.ts). Stretching them would only move a
 *  freeze, not remove one. */
export const BACKFILL_RETRY_MS = {
  "foreground-busy": 30_000,
  "server-starting": 30_000,
} as const;

/** How long after the server starts the backfill still counts the box as busy.
 *  Boot is the one busy moment isForegroundBusy structurally CANNOT see: it
 *  infers activity from session `updatedAt`, and at boot no session has been
 *  written yet — so "nothing is running" reads as idle at precisely the moment
 *  the user is waiting on first paint.
 *
 *  This is NOT what stops the scan from monopolising the loop; the paced walk
 *  is. It only keeps a corpus-wide re-embed off the disk while the app is still
 *  coming up. Deliberately just over one re-check past a boot measured at ~15s
 *  to port-listening: the 15s arm defers once, the 30s re-check then runs. It
 *  is bounded and self-clearing, so it can never turn into an indefinite skip.
 *
 *  ACCEPTED COST, stated plainly: the first backfill of a session therefore
 *  lands ~45s after boot rather than the ~15s of the bare arm, so freshly
 *  written content stays unindexed for about 30s longer. That trade is the
 *  whole point — boot is exactly when the user is sitting in front of a
 *  half-painted window waiting to type, and a scan they never asked for must
 *  not be competing for disk and embedding CPU at that moment. Nothing is
 *  lost, only deferred by one re-check. */
export const BACKFILL_BOOT_SETTLE_MS = 45_000;

export type BackfillSkipReason = keyof typeof BACKFILL_RETRY_MS;

export type BackfillDecision =
  | { run: true }
  | { run: false; reason: BackfillSkipReason; retryMs: number };

/**
 * Should the memory backfill scan run right now?
 *
 * Two reasons not to, and both are about CONTENTION — never about whether the
 * scan would produce vectors:
 *
 *   foreground-busy — the scan re-embeds, so it competes with a live turn for
 *     the same embedding CPU / provider key.
 *
 *   server-starting — see BACKFILL_BOOT_SETTLE_MS. Boot is the busy moment the
 *     foreground check cannot observe, and the one the user actually feels.
 *
 * NOT a reason: embedding-provider availability. An earlier revision of this
 * gate skipped the walk whenever probeEmbeddingsDegraded() reported the
 * embedder down. That was wrong twice over. It misdiagnosed the freeze — the
 * boot scan stalled the app because the walk ran unpaced on the main loop, and
 * that is fixed where it happens (memory/universal-index-backfill.ts), not by
 * declining to start. And the signal itself was unsound: the probe reported
 * Ollama unreachable while Ollama was in fact up and serving, so the gate
 * silently skipped legitimate indexing.
 *
 * Skipping is not the safe direction. Indexing is idempotent and hash-deduped,
 * and chunks written with a NULL embedding are still keyword-searchable
 * immediately and get their vectors from reembedMissingChunks once a provider
 * is healthy (memory/index-embedding-reconcile.ts). So a pass that cannot embed
 * costs one walk and still lands the content; a pass refused on a bad probe
 * leaves that content unsearchable indefinitely.
 */
export function decideBackfill(input: {
  foregroundBusy: boolean;
  serverStarting: boolean;
}): BackfillDecision {
  if (input.foregroundBusy) {
    return { run: false, reason: "foreground-busy", retryMs: BACKFILL_RETRY_MS["foreground-busy"] };
  }
  if (input.serverStarting) {
    return { run: false, reason: "server-starting", retryMs: BACKFILL_RETRY_MS["server-starting"] };
  }
  return { run: true };
}

/** One backfill attempt: decide, then either scan or re-arm. Split from the
 *  wiring in ./index.ts (and injected) so a test can assert the scan is never
 *  even reached when the gate says no — the whole point of the gate. */
export async function attemptBackfill(deps: {
  foregroundBusy: () => boolean;
  serverStarting: () => boolean;
  scan: () => Promise<void>;
  retry: (ms: number) => void;
}): Promise<BackfillDecision> {
  const decision = decideBackfill({
    foregroundBusy: deps.foregroundBusy(),
    serverStarting: deps.serverStarting(),
  });
  if (!decision.run) {
    logger.info(`[memory-backfill] deferred (${decision.reason}) — re-checking in ${Math.round(decision.retryMs / 1000)}s`);
    deps.retry(decision.retryMs);
    return decision;
  }
  await deps.scan();
  return decision;
}
