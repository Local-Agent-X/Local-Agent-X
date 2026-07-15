import type { EmbeddingProvider } from "../memory/index.js";

export type EmbeddingProviderType =
  | "openai"
  | "gemini"
  | "ollama"
  | "local";

/**
 * The one default embedding provider, read by every site that resolves an
 * unset `settings.embeddingProvider` (installer seed, boot, setup-status probe,
 * settings UI). `"local"` is the built-in TF-IDF/feature-hashing embedder:
 * zero network, zero extra install, works out of the box. Ollama and the cloud
 * providers are opt-in *upgrades* selected explicitly — never the silent
 * default, so a fresh install needs no 670 MB model pull and no Ollama daemon.
 *
 * Kept here in the leaf types module (not index.ts) so lightweight readers can
 * import the constant without dragging in every provider class. Do not fork a
 * second literal — every default flows from this one.
 */
export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProviderType = "local";

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
