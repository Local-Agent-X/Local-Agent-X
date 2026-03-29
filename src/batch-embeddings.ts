/**
 * Batch embedding API support with provider-specific strategies,
 * concurrency control, caching, rate-limit handling, and cost tracking.
 */

import type { EmbeddingProvider } from "./memory.js";

// ── Types ──

interface BatchOptions {
  maxBatchSize?: number;
  concurrency?: number;
  retryAttempts?: number;
}

interface BatchStats {
  totalEmbedded: number;
  cacheHits: number;
  cacheMisses: number;
  averageLatency: number;
  totalCost: number;
}

type ProgressCallback = (completed: number, total: number) => void;

// ── Provider batch size limits ──

const PROVIDER_BATCH_LIMITS: Record<string, number> = {
  openai: 2048,
  gemini: 100,
  voyage: 128,
  mistral: 512,
  ollama: 1,
  local: Infinity,
};

// ── Cost per million tokens by provider ──

const PROVIDER_COST_PER_M_TOKENS: Record<string, number> = {
  openai: 0.02,
  gemini: 0.004,
  voyage: 0.10,
  mistral: 0.01,
  ollama: 0,
  local: 0,
};

// ── Helpers ──

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size === Infinity) return [arr];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function detectProviderName(provider: EmbeddingProvider): string {
  const name = (provider.name || "").toLowerCase();
  for (const key of Object.keys(PROVIDER_BATCH_LIMITS)) {
    if (name.includes(key)) return key;
  }
  return "openai"; // default fallback
}

// ── BatchEmbeddingManager ──

export class BatchEmbeddingManager {
  private provider: EmbeddingProvider;
  private maxBatchSize: number;
  private concurrency: number;
  private retryAttempts: number;
  private providerName: string;

  private stats: BatchStats = {
    totalEmbedded: 0,
    cacheHits: 0,
    cacheMisses: 0,
    averageLatency: 0,
    totalCost: 0,
  };
  private totalLatencyMs = 0;
  private latencyCount = 0;

  onProgress: ProgressCallback | null = null;

  constructor(provider: EmbeddingProvider, options?: BatchOptions) {
    this.provider = provider;
    this.providerName = detectProviderName(provider);

    const providerLimit = PROVIDER_BATCH_LIMITS[this.providerName] ?? 2048;
    this.maxBatchSize = options?.maxBatchSize
      ? Math.min(options.maxBatchSize, providerLimit)
      : providerLimit;
    this.concurrency = options?.concurrency ?? 3;
    this.retryAttempts = options?.retryAttempts ?? 3;
  }

  /**
   * Embed an array of texts using provider-appropriate batching and concurrency.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const chunks = chunkArray(texts, this.maxBatchSize);
    const results: number[][] = new Array(texts.length);
    let completed = 0;

    // Process chunks with concurrency control
    const queue = chunks.map((chunk, chunkIdx) => ({
      chunk,
      startIndex: chunkIdx * this.maxBatchSize,
    }));

    const workers: Promise<void>[] = [];
    let queueIdx = 0;

    const processNext = async (): Promise<void> => {
      while (queueIdx < queue.length) {
        const current = queue[queueIdx++];
        if (!current) break;

        const embeddings = await this.embedChunkWithRetry(current.chunk);
        for (let i = 0; i < embeddings.length; i++) {
          results[current.startIndex + i] = embeddings[i];
        }

        completed += current.chunk.length;
        this.stats.totalEmbedded += current.chunk.length;
        this.trackCost(current.chunk);

        if (this.onProgress) {
          this.onProgress(completed, texts.length);
        }
      }
    };

    const workerCount = Math.min(this.concurrency, queue.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(processNext());
    }

    await Promise.all(workers);
    return results;
  }

  /**
   * Embed texts with a cache layer. Only calls the provider for cache misses.
   */
  async embedWithCache(
    texts: string[],
    cache: Map<string, number[]>,
  ): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const misses: { index: number; text: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = cache.get(texts[i]);
      if (cached) {
        results[i] = cached;
        this.stats.cacheHits++;
      } else {
        misses.push({ index: i, text: texts[i] });
        this.stats.cacheMisses++;
      }
    }

    if (misses.length > 0) {
      const missTexts = misses.map((m) => m.text);
      const embeddings = await this.embedBatch(missTexts);

      for (let i = 0; i < misses.length; i++) {
        results[misses[i].index] = embeddings[i];
        cache.set(misses[i].text, embeddings[i]);
      }
    }

    return results;
  }

  getStats(): BatchStats {
    return {
      ...this.stats,
      averageLatency:
        this.latencyCount > 0 ? this.totalLatencyMs / this.latencyCount : 0,
    };
  }

  // ── Internal ──

  private async embedChunkWithRetry(texts: string[]): Promise<number[][]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        const start = Date.now();
        const embeddings = await this.provider.embedBatch(texts);
        const elapsed = Date.now() - start;

        this.totalLatencyMs += elapsed;
        this.latencyCount++;

        return embeddings;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Check for rate limit (429)
        const is429 =
          lastError.message.includes("429") ||
          lastError.message.toLowerCase().includes("rate limit");

        if (is429 && attempt < this.retryAttempts - 1) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
          await sleep(backoffMs);
          continue;
        }

        // For non-429 errors, retry with backoff too (transient failures)
        if (attempt < this.retryAttempts - 1) {
          const backoffMs = Math.min(500 * Math.pow(2, attempt), 10_000);
          await sleep(backoffMs);
          continue;
        }
      }
    }

    throw lastError ?? new Error("embedBatch failed after retries");
  }

  private trackCost(texts: string[]): void {
    const costPerM = PROVIDER_COST_PER_M_TOKENS[this.providerName] ?? 0;
    if (costPerM === 0) return;

    let totalTokens = 0;
    for (const t of texts) totalTokens += estimateTokens(t);

    this.stats.totalCost += (totalTokens / 1_000_000) * costPerM;
  }
}

// ── Factory ──

export function createBatchManager(
  provider: EmbeddingProvider,
  options?: BatchOptions,
): BatchEmbeddingManager {
  return new BatchEmbeddingManager(provider, options);
}
