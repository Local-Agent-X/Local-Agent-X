/**
 * Multi-provider embedding system.
 *
 * Implements six embedding backends that conform to the EmbeddingProvider
 * interface used by memory.ts, plus a factory function and provider registry.
 */

import type { EmbeddingProvider } from "./memory.js";
import { getRuntimeConfig } from "./config.js";

// ── Provider type union ──

export type EmbeddingProviderType =
  | "openai"
  | "gemini"
  | "voyage"
  | "mistral"
  | "ollama"
  | "local";

// ── Extended provider interface (superset of memory.ts EmbeddingProvider) ──

export interface ExtendedEmbeddingProvider extends EmbeddingProvider {
  /** Embed a single query (may use a different task type than document embedding). */
  embedQuery(text: string): Promise<number[]>;
  /** Maximum texts per batch request. */
  maxBatchSize: number;
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
  baseDelay = 1000
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutSignal = AbortSignal.timeout(30_000);
    const mergedInit = { ...init };
    if (init.signal) {
      mergedInit.signal = AbortSignal.any([init.signal, timeoutSignal]);
    } else {
      mergedInit.signal = timeoutSignal;
    }
    const res = await fetch(url, mergedInit);
    if (res.status === 429 && attempt < retries) {
      const delay = baseDelay * 2 ** attempt + Math.random() * 500;
      console.warn(
        `[embeddings] Rate-limited (429), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries})`
      );
      await sleep(delay);
      continue;
    }
    return res;
  }
  // Unreachable, but satisfies TS
  throw new Error("fetchWithRetry: all retries exhausted");
}

function emptyVector(dims: number): number[] {
  return new Array(dims).fill(0);
}

// ── 1. OpenAI Embeddings ──

export class OpenAIEmbeddings implements ExtendedEmbeddingProvider {
  readonly name = "openai";
  model: string;
  readonly dimensions = 1536;
  readonly maxBatchSize = 2048;

  private apiKey: string;
  private baseUrl: string;
  private fallbackModel = "text-embedding-ada-002";

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      ""
    );
  }

  async embed(text: string): Promise<number[]> {
    const batch = await this.embedBatch([text]);
    return batch[0] ?? emptyVector(this.dimensions);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      return await this.requestEmbeddings(texts, this.model);
    } catch (err: any) {
      if (
        err?.modelUnavailable &&
        this.model !== this.fallbackModel
      ) {
        console.warn(
          `[openai-embed] Model ${this.model} unavailable, falling back to ${this.fallbackModel}`
        );
        this.model = this.fallbackModel;
        return this.requestEmbeddings(texts, this.fallbackModel);
      }
      console.warn(`[openai-embed] Embedding failed: ${err?.message ?? err}`);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }

  private async requestEmbeddings(
    texts: string[],
    model: string
  ): Promise<number[][]> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: texts, model }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 404 || body.includes("model_not_found")) {
        const err: any = new Error(`Model ${model} not available`);
        err.modelUnavailable = true;
        throw err;
      }
      throw new Error(`OpenAI embeddings HTTP ${res.status}: ${body}`);
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    // Sort by index to preserve input order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}

// ── 2. Gemini Embeddings ──

export class GeminiEmbeddings implements ExtendedEmbeddingProvider {
  readonly name = "gemini";
  model: string;
  readonly dimensions = 768;
  readonly maxBatchSize = 100;

  private apiKey: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-004";
    this.baseUrl = (
      opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, "");
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSingle(text, "RETRIEVAL_DOCUMENT");
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedSingle(text, "RETRIEVAL_QUERY");
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      const requests = texts.map((t) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text: t }] },
        taskType: "RETRIEVAL_DOCUMENT",
      }));
      const res = await fetchWithRetry(
        `${this.baseUrl}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Gemini embeddings HTTP ${res.status}: ${body}`);
      }
      const json = (await res.json()) as {
        embeddings: Array<{ values: number[] }>;
      };
      return json.embeddings.map((e) => e.values);
    } catch (err: any) {
      console.warn(`[gemini-embed] Batch failed: ${err?.message ?? err}`);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }

  private async embedSingle(
    text: string,
    taskType: string
  ): Promise<number[]> {
    try {
      const res = await fetchWithRetry(
        `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            taskType,
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Gemini embed HTTP ${res.status}: ${body}`);
      }
      const json = (await res.json()) as {
        embedding: { values: number[] };
      };
      return json.embedding.values;
    } catch (err: any) {
      console.warn(`[gemini-embed] Failed: ${err?.message ?? err}`);
      return emptyVector(this.dimensions);
    }
  }
}

// ── 3. Voyage Embeddings ──

export class VoyageEmbeddings implements ExtendedEmbeddingProvider {
  readonly name = "voyage";
  model: string;
  readonly dimensions = 512;
  readonly maxBatchSize = 128;

  private apiKey: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "voyage-3-lite";
    this.baseUrl = (opts.baseUrl ?? "https://api.voyageai.com/v1").replace(
      /\/$/,
      ""
    );
  }

  async embed(text: string): Promise<number[]> {
    const batch = await this.requestEmbeddings([text], "document");
    return batch[0] ?? emptyVector(this.dimensions);
  }

  async embedQuery(text: string): Promise<number[]> {
    const batch = await this.requestEmbeddings([text], "query");
    return batch[0] ?? emptyVector(this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.requestEmbeddings(texts, "document");
  }

  private async requestEmbeddings(
    texts: string[],
    inputType: "document" | "query"
  ): Promise<number[][]> {
    try {
      const res = await fetchWithRetry(
        `${this.baseUrl}/embeddings`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            input: texts,
            model: this.model,
            input_type: inputType,
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Voyage embeddings HTTP ${res.status}: ${body}`);
      }
      const json = (await res.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (err: any) {
      console.warn(`[voyage-embed] Failed: ${err?.message ?? err}`);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }
}

// ── 4. Mistral Embeddings ──

export class MistralEmbeddings implements ExtendedEmbeddingProvider {
  readonly name = "mistral";
  model: string;
  readonly dimensions = 1024;
  readonly maxBatchSize = 512;

  private apiKey: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "mistral-embed";
    this.baseUrl = (opts.baseUrl ?? "https://api.mistral.ai/v1").replace(
      /\/$/,
      ""
    );
  }

  async embed(text: string): Promise<number[]> {
    const batch = await this.embedBatch([text]);
    return batch[0] ?? emptyVector(this.dimensions);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      const res = await fetchWithRetry(
        `${this.baseUrl}/embeddings`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            input: texts,
            model: this.model,
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Mistral embeddings HTTP ${res.status}: ${body}`);
      }
      const json = (await res.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (err: any) {
      console.warn(`[mistral-embed] Failed: ${err?.message ?? err}`);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }
}

// ── 5. Ollama Embeddings ──

export class OllamaEmbeddings implements ExtendedEmbeddingProvider {
  readonly name = "ollama";
  model: string;
  dimensions: number;
  readonly maxBatchSize = 10;

  private baseUrl: string;
  private healthy: boolean | null = null;
  private dimensionsDetected = false;

  constructor(opts?: { model?: string; baseUrl?: string }) {
    this.model = opts?.model ?? "nomic-embed-text";
    this.baseUrl = (opts?.baseUrl ?? getRuntimeConfig().ollamaUrl).replace(
      /\/$/,
      ""
    );
    // Default dimensions per known model, auto-detected on first embed call
    const knownDims: Record<string, number> = {
      "nomic-embed-text": 768, "mxbai-embed-large": 1024,
      "snowflake-arctic-embed:335m": 768, "all-minilm": 384,
      "bge-large": 1024, "bge-base": 768,
    };
    this.dimensions = knownDims[this.model] || 768;
  }

  async embed(text: string): Promise<number[]> {
    if (!(await this.ensureHealthy())) return emptyVector(this.dimensions);
    if (!text || !text.trim()) return emptyVector(this.dimensions);
    // Truncate to ~512 tokens (~2000 chars) for models with smaller context windows
    const truncated = text.trim().slice(0, 2000);
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: truncated }),
      });
      if (!res.ok) {
        throw new Error(`Ollama embed HTTP ${res.status}`);
      }
      const json = (await res.json()) as { embeddings: number[][] };
      const vec = json.embeddings?.[0] ?? emptyVector(this.dimensions);
      // Auto-detect dimensions from first result
      if (!this.dimensionsDetected && vec.length > 0) {
        this.dimensions = vec.length;
        this.dimensionsDetected = true;
      }
      return vec;
    } catch (err: any) {
      // Suppress noisy per-chunk errors — batch fallback handles it
      return emptyVector(this.dimensions);
    }
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!(await this.ensureHealthy())) {
      return texts.map(() => emptyVector(this.dimensions));
    }
    // Filter out empty strings and truncate long text
    const cleaned = texts.map(t => (t && t.trim()) ? t.trim().slice(0, 2000) : null);
    const validTexts = cleaned.filter((t): t is string => t !== null);
    if (validTexts.length === 0) return texts.map(() => emptyVector(this.dimensions));
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: validTexts }),
      });
      if (!res.ok) {
        throw new Error(`Ollama batch embed HTTP ${res.status}`);
      }
      const json = (await res.json()) as { embeddings: number[][] };
      const validResults = json.embeddings ?? validTexts.map(() => emptyVector(this.dimensions));
      // Map results back to original positions
      let vi = 0;
      return cleaned.map(t => t !== null ? validResults[vi++] || emptyVector(this.dimensions) : emptyVector(this.dimensions));
    } catch (err: any) {
      // Batch failed — fall back silently to individual embeds
      // Fallback: embed one at a time
      const results: number[][] = [];
      for (const text of texts) {
        results.push(await this.embed(text));
      }
      return results;
    }
  }

  private async ensureHealthy(): Promise<boolean> {
    if (this.healthy !== null) return this.healthy;
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      this.healthy = res.ok;
      if (!this.healthy) {
        console.warn(`[ollama-embed] Server responded with ${res.status}`);
      }
    } catch {
      this.healthy = false;
      console.warn(
        `[ollama-embed] Server at ${this.baseUrl} not reachable`
      );
    }
    return this.healthy;
  }
}

// ── 6. Local TF-IDF Embeddings ──

export class LocalEmbeddings implements ExtendedEmbeddingProvider {
  readonly name = "local";
  readonly model = "tfidf-256";
  readonly dimensions = 256;
  readonly maxBatchSize = Infinity;

  /** Global vocabulary: word -> index */
  private vocab = new Map<string, number>();
  /** Document frequency: word -> number of docs containing it */
  private df = new Map<string, number>();
  /** Total documents seen for IDF computation */
  private totalDocs = 0;

  async embed(text: string): Promise<number[]> {
    this.addToCorpus([text]);
    return this.tfidfVector(text);
  }

  async embedQuery(text: string): Promise<number[]> {
    // Query uses current vocabulary but doesn't expand it
    return this.tfidfVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.addToCorpus(texts);
    return texts.map((t) => this.tfidfVector(t));
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && w.length < 40);
  }

  private addToCorpus(texts: string[]): void {
    for (const text of texts) {
      this.totalDocs++;
      const words = new Set(this.tokenize(text));
      for (const w of words) {
        if (!this.vocab.has(w)) {
          this.vocab.set(w, this.vocab.size);
        }
        this.df.set(w, (this.df.get(w) ?? 0) + 1);
      }
    }
  }

  private tfidfVector(text: string): number[] {
    const tokens = this.tokenize(text);
    if (tokens.length === 0) return emptyVector(this.dimensions);

    // Term frequency
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    // Build a sparse vector in full vocab space, then hash-project to fixed dimensions
    const vec = new Float64Array(this.dimensions);
    const maxTf = Math.max(...tf.values());

    for (const [word, count] of tf) {
      const termFreq = 0.5 + (0.5 * count) / maxTf; // augmented TF
      const docFreq = this.df.get(word) ?? 1;
      const idf = Math.log(1 + (this.totalDocs || 1) / docFreq);
      const weight = termFreq * idf;

      // Hash the word to one or more dimension slots (feature hashing)
      const h1 = this.hashWord(word, 0) % this.dimensions;
      const h2 = this.hashWord(word, 7) % this.dimensions;
      const sign = this.hashWord(word, 13) % 2 === 0 ? 1 : -1;

      vec[h1] += weight * sign;
      vec[h2] += weight * -sign;
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) vec[i] /= norm;
    }

    return Array.from(vec);
  }

  /** Simple string hash (djb2 variant with seed). */
  private hashWord(word: string, seed: number): number {
    let hash = 5381 + seed;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) + hash + word.charCodeAt(i)) >>> 0;
    }
    return hash;
  }
}

// ── Factory & Registry ──

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

export interface EmbeddingProviderConfig {
  provider?: EmbeddingProviderType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Create an embedding provider based on configuration.
 * Falls back to 'local' if no API key is provided and the requested provider needs one.
 */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig = {}
): ExtendedEmbeddingProvider {
  const requested = config.provider ?? "local";

  const needsKey = ["openai", "gemini", "voyage", "mistral"].includes(requested);
  if (needsKey && !config.apiKey) {
    console.warn(
      `[embeddings] Provider "${requested}" requires an API key — falling back to local`
    );
    return new LocalEmbeddings();
  }

  switch (requested) {
    case "openai":
      return new OpenAIEmbeddings({
        apiKey: config.apiKey!,
        model: config.model,
        baseUrl: config.baseUrl,
      });

    case "gemini":
      return new GeminiEmbeddings({
        apiKey: config.apiKey!,
        model: config.model,
        baseUrl: config.baseUrl,
      });

    case "voyage":
      return new VoyageEmbeddings({
        apiKey: config.apiKey!,
        model: config.model,
        baseUrl: config.baseUrl,
      });

    case "mistral":
      return new MistralEmbeddings({
        apiKey: config.apiKey!,
        model: config.model,
        baseUrl: config.baseUrl,
      });

    case "ollama":
      return new OllamaEmbeddings({
        model: config.model,
        baseUrl: config.baseUrl,
      });

    case "local":
    default:
      return new LocalEmbeddings();
  }
}
