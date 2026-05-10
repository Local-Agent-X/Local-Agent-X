/**
 * Multi-provider embedding system.
 *
 * Six embedding backends conforming to the EmbeddingProvider interface used by
 * memory.ts, plus a factory that picks one from config. Each provider lives in
 * its own module under src/embedding-providers/:
 *   - openai.ts   — OpenAI text-embedding-3-* with ada-002 fallback
 *   - gemini.ts   — Google embedContent / batchEmbedContents
 *   - voyage.ts   — Voyage AI document/query input types
 *   - mistral.ts  — Mistral embeddings
 *   - ollama.ts   — Local Ollama (mxbai-embed-large + nomic fallback)
 *   - local.ts    — TF-IDF + feature hashing, zero network, deterministic
 */

import { createLogger } from "./logger.js";
import { GeminiEmbeddings } from "./embedding-providers/gemini.js";
import { LocalEmbeddings } from "./embedding-providers/local.js";
import { MistralEmbeddings } from "./embedding-providers/mistral.js";
import { OllamaEmbeddings } from "./embedding-providers/ollama.js";
import { OpenAIEmbeddings } from "./embedding-providers/openai.js";
import type {
  EmbeddingProviderConfig,
  EmbeddingProviderType,
  ExtendedEmbeddingProvider,
} from "./embedding-providers/types.js";
import { VoyageEmbeddings } from "./embedding-providers/voyage.js";

const logger = createLogger("embedding-providers");

export type { EmbeddingProviderConfig, EmbeddingProviderType, ExtendedEmbeddingProvider } from "./embedding-providers/types.js";
export { OpenAIEmbeddings } from "./embedding-providers/openai.js";
export { GeminiEmbeddings } from "./embedding-providers/gemini.js";
export { VoyageEmbeddings } from "./embedding-providers/voyage.js";
export { MistralEmbeddings } from "./embedding-providers/mistral.js";
export { OllamaEmbeddings } from "./embedding-providers/ollama.js";
export { LocalEmbeddings } from "./embedding-providers/local.js";

const PROVIDER_NAMES: EmbeddingProviderType[] = [
  "openai",
  "gemini",
  "voyage",
  "mistral",
  "ollama",
  "local",
];

export function listProviders(): string[] {
  return [...PROVIDER_NAMES];
}

/**
 * Create an embedding provider based on configuration.
 * Falls back to 'local' if no API key is provided and the requested provider needs one.
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig = {}): ExtendedEmbeddingProvider {
  const requested = config.provider ?? "local";

  const needsKey = ["openai", "gemini", "voyage", "mistral"].includes(requested);
  if (needsKey && !config.apiKey) {
    logger.warn(`[embeddings] Provider "${requested}" requires an API key — falling back to local`);
    return new LocalEmbeddings();
  }

  switch (requested) {
    case "openai":
      return new OpenAIEmbeddings({ apiKey: config.apiKey!, model: config.model, baseUrl: config.baseUrl });
    case "gemini":
      return new GeminiEmbeddings({ apiKey: config.apiKey!, model: config.model, baseUrl: config.baseUrl });
    case "voyage":
      return new VoyageEmbeddings({ apiKey: config.apiKey!, model: config.model, baseUrl: config.baseUrl });
    case "mistral":
      return new MistralEmbeddings({ apiKey: config.apiKey!, model: config.model, baseUrl: config.baseUrl });
    case "ollama":
      return new OllamaEmbeddings({ model: config.model, baseUrl: config.baseUrl });
    case "local":
    default:
      return new LocalEmbeddings();
  }
}
