import type { EmbeddingProvider } from "../memory.js";

export type EmbeddingProviderType =
  | "openai"
  | "gemini"
  | "voyage"
  | "mistral"
  | "ollama"
  | "local";

/** Extended provider interface (superset of memory.ts EmbeddingProvider). */
export interface ExtendedEmbeddingProvider extends EmbeddingProvider {
  /** Embed a single query (may use a different task type than document embedding). */
  embedQuery(text: string): Promise<number[]>;
  /** Maximum texts per batch request. */
  maxBatchSize: number;
}

export interface EmbeddingProviderConfig {
  provider?: EmbeddingProviderType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}
