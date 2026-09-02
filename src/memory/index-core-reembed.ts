import type Database from "better-sqlite3";
import type { EmbeddingProvider, MemoryConfig } from "./types.js";
import * as Embedding from "./index-embedding.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-core");

// Flap backoff bounds. A provider that oscillates serving↔non-serving fires
// onRecovered on every upswing; without a floor between unsuccessful passes
// each flap re-ran a full missing-vector scan back-to-back. The FIRST retry
// after a failure stays immediate — a recovery that lands mid-pass is the one
// moment a rerun is known to be worth it (see class doc) — then every further
// consecutive failure doubles the wait. A pass that embeds everything resets.
const BACKOFF_INITIAL_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * What a re-embed pass reads from the index at the moment it runs. Read live,
 * never captured: the provider and the vector table change on re-attach.
 */
export interface ReembedContext {
  db(): InstanceType<typeof Database>;
  provider(): EmbeddingProvider | null;
  config(): MemoryConfig;
  hasVec(): boolean;
  /** Clock for the flap-backoff window; injected in tests so backoff is driven, not slept. */
  now?(): number;
}

/** Staleness probe handed to the swap that owns the current epoch. */
export interface SwapToken {
  stale(): boolean;
}

/**
 * The one background re-embed lane of a MemoryIndex. Chunks indexed while the
 * embedding provider was down (or still probing at boot) land with a NULL
 * vector — keyword-searchable, vector-invisible. Two things bring them back:
 * the attach-time kick in setEmbeddingProvider, and the provider's own
 * recovery signal (EmbeddingProvider.onRecovered), which is exactly the
 * moment a pass can succeed. Before the recovery hook, a chunk that missed
 * the attach-time pass waited for the next boot.
 *
 * Kicks coalesce: one pass at a time, and a kick that lands mid-pass is
 * honoured once the pass settles — a recovery that arrives while a pass is
 * still failing on the old outage must not be dropped. Bounded: a rerun
 * consumes its request, and only a fresh external kick can queue another.
 *
 * Swap-safe: beginSwap() bumps the epoch, which stops the in-flight pass at
 * its next batch boundary and inert-s the superseded attach's tail — a stale
 * setEmbeddingProvider call resumed after a newer one must neither
 * re-subscribe its provider nor fire its kick.
 */
export class BackgroundReembed {
  private inProgress = false;
  private rerun: string | null = null;
  private detachRecovery: (() => void) | null = null;
  /** Bumped by beginSwap()/dispose(); a pass and an attach tail belong to the epoch they started in. */
  private epoch = 0;
  /** Delay applied before the NEXT pass after the current consecutive-failure streak. */
  private backoffMs = 0;
  /** Epoch-ms floor before which no new pass may start (0 = none). */
  private notBefore = 0;
  private deferredKick: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly ctx: ReembedContext) {
    this.now = ctx.now?.bind(ctx) ?? Date.now;
  }

  /**
   * Supersede everything tied to the current provider: detach its recovery
   * listener, stop the in-flight pass at its next batch boundary, drop the
   * queued rerun and any deferred kick (both describe the old provider's
   * outage), and reset the flap backoff — a fresh provider earns immediate
   * service. Returns a staleness probe for the caller's own await points.
   */
  beginSwap(): SwapToken {
    const epoch = ++this.epoch;
    this.unwatch();
    this.rerun = null;
    if (this.deferredKick) {
      clearTimeout(this.deferredKick);
      this.deferredKick = null;
    }
    this.backoffMs = 0;
    this.notBefore = 0;
    return { stale: () => this.epoch !== epoch };
  }

  /** Terminal beginSwap: close() detaches, cancels and never re-attaches. */
  dispose(): void {
    this.beginSwap();
  }

  /**
   * Re-embed whenever this provider reports it can serve again. Replaces the
   * previous subscription: the index re-attaches on the boot retry loop,
   * /api/memory/reinit and the local-only teardown, and a stale provider's
   * recheck must not drive passes for its successor.
   */
  watchProvider(provider: EmbeddingProvider): void {
    this.unwatch();
    this.detachRecovery = provider.onRecovered?.(() => this.kick("provider recovered")) ?? null;
  }

  unwatch(): void {
    this.detachRecovery?.();
    this.detachRecovery = null;
  }

  kick(reason: string): void {
    const db = this.ctx.db();
    const provider = this.ctx.provider();
    // `db.open`: a rerun queued behind a pass that outlived close() must not
    // touch a closed handle.
    if (!provider || !db.open) return;
    if (this.inProgress) {
      this.rerun = reason;
      return;
    }
    // Flap backoff: inside the window, coalesce into one deferred retry
    // instead of scanning — the scan itself is what a flapping provider
    // multiplied. Outside it, a pending deferred retry is consumed by this
    // pass rather than firing a duplicate later.
    const waitMs = this.notBefore - this.now();
    if (waitMs > 0) {
      if (!this.deferredKick) {
        logger.info(`[memory] Background re-embed deferred ${Math.round(waitMs / 1000)}s (${reason}) — provider is flapping`);
        this.deferredKick = setTimeout(() => {
          this.deferredKick = null;
          this.kick(reason);
        }, waitMs);
        this.deferredKick.unref?.();
      }
      return;
    }
    if (this.deferredKick) {
      clearTimeout(this.deferredKick);
      this.deferredKick = null;
    }
    const missing = Embedding.countChunksMissingEmbedding(db);
    if (missing === 0) return;
    const passEpoch = this.epoch;
    this.inProgress = true;
    logger.info(`[memory] Background re-embed of ${missing} chunks started (${reason})`);
    Embedding.reembedMissingChunks(db, provider, this.ctx.config(), this.ctx.hasVec(), () => this.epoch === passEpoch)
      .then((r) => {
        if (this.epoch !== passEpoch) {
          logger.info(`[memory] Background re-embed superseded (provider swapped or index closed) after ${r.embedded} embedded`);
          return;
        }
        logger.info(
          `[memory] Background re-embed done: ${r.embedded} embedded` +
          (r.missing > 0 ? `, ${r.missing} still missing (resumes when the provider recovers, or next boot)` : "")
        );
        if (r.missing > 0) this.armBackoff();
        else this.resetBackoff();
      })
      .catch((e) => {
        // Expected at shutdown: close() disposes mid-pass and a tail statement
        // trips over the already-closed handle (the epoch probe only runs at
        // batch boundaries). Nothing failed and nothing resumes — keep it out
        // of warn.
        if (!this.ctx.db().open) {
          logger.debug(`[memory] Background re-embed stopped by close: ${(e as Error).message}`);
          return;
        }
        logger.warn(`[memory] Background re-embed failed: ${(e as Error).message}`);
        if (this.epoch === passEpoch) this.armBackoff();
      })
      .finally(() => {
        this.inProgress = false;
        // Anything queued here postdates the last beginSwap (which clears the
        // slot), so it always belongs to the current provider — honour it.
        const rerun = this.rerun;
        this.rerun = null;
        if (rerun) this.kick(rerun);
      });
  }

  /** Apply the current streak's delay, then double it (bounded) for the next failure. */
  private armBackoff(): void {
    this.notBefore = this.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs === 0 ? BACKOFF_INITIAL_MS : this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private resetBackoff(): void {
    this.backoffMs = 0;
    this.notBefore = 0;
  }
}
