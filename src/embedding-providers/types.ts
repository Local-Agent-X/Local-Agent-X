import type { EmbeddingProvider } from "../memory/index.js";

export type EmbeddingProviderType =
  | "openai"
  | "gemini"
  | "ollama"
  | "local";

/** Extended provider interface (superset of memory.ts EmbeddingProvider). */
export interface ExtendedEmbeddingProvider extends EmbeddingProvider {
  /** Embed a single query (may use a different task type than document embedding). */
  embedQuery(text: string): Promise<number[]>;
  /** Maximum texts per batch request. */
  maxBatchSize: number;
  /**
   * Resolve whether this provider can actually serve embeddings right now,
   * running a probe if health isn't yet known. Optional: only providers with a
   * backing service that can be DOWN implement it (Ollama). Providers that
   * can't fail independently — built-in TF-IDF, or a remote API whose failure
   * is per-request — omit it, and callers must read `undefined` as "unknown",
   * never as "unhealthy".
   *
   * Declared here rather than duck-typed at the call site so /api/setup/status
   * gets a compile-time contract instead of a cast that silently rots if the
   * method is renamed.
   */
  ensureHealthy?(): Promise<boolean>;
}

export interface EmbeddingProviderConfig {
  provider?: EmbeddingProviderType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}
