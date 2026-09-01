import type Database from "better-sqlite3";
import type { EmbeddingProvider, MemoryConfig } from "./types.js";
import * as Embedding from "./index-embedding.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-core");

/**
 * What a re-embed pass reads from the index at the moment it runs. Read live,
 * never captured: the provider and the vector table change on re-attach.
 */
export interface ReembedContext {
  db(): InstanceType<typeof Database>;
  provider(): EmbeddingProvider | null;
  config(): MemoryConfig;
  hasVec(): boolean;
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
 */
export class BackgroundReembed {
  private inProgress = false;
  private rerun: string | null = null;
  private detachRecovery: (() => void) | null = null;

  constructor(private readonly ctx: ReembedContext) {}

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
    const missing = Embedding.countChunksMissingEmbedding(db);
    if (missing === 0) return;
    this.inProgress = true;
    logger.info(`[memory] Background re-embed of ${missing} chunks started (${reason})`);
    Embedding.reembedMissingChunks(db, provider, this.ctx.config(), this.ctx.hasVec())
      .then((r) => {
        logger.info(
          `[memory] Background re-embed done: ${r.embedded} embedded` +
          (r.missing > 0 ? `, ${r.missing} still missing (resumes when the provider recovers, or next boot)` : "")
        );
      })
      .catch((e) => logger.warn(`[memory] Background re-embed failed: ${(e as Error).message}`))
      .finally(() => {
        this.inProgress = false;
        const rerun = this.rerun;
        this.rerun = null;
        if (rerun) this.kick(rerun);
      });
  }
}
