import { getRuntimeConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { emptyVector } from "./helpers.js";
import type { ExtendedEmbeddingProvider } from "./types.js";

const logger = createLogger("embedding-providers");

export class OllamaEmbeddings implements ExtendedEmbeddingProvider {
  readonly name = "ollama";
  model: string;
  dimensions: number;
  readonly maxBatchSize = 10;

  private baseUrl: string;
  private healthy: boolean | null = null;
  private dimensionsDetected = false;

  constructor(opts?: { model?: string; baseUrl?: string }) {
    // mxbai-embed-large (1024d) scored 97.0% R@5 on LongMemEval — #1 zero-cost.
    // nomic-embed-text (768d) scored ~95.5% R@5 — fallback if mxbai not available.
    // Strip ":latest" suffix — Ollama adds it but our knownDims don't include it.
    this.model = (opts?.model ?? "mxbai-embed-large").replace(/:latest$/, "");
    this.baseUrl = (opts?.baseUrl ?? getRuntimeConfig().ollamaUrl).replace(/\/$/, "");
    // Default dimensions per known model, auto-detected on first embed call
    const knownDims: Record<string, number> = {
      "nomic-embed-text": 768, "mxbai-embed-large": 1024,
      "snowflake-arctic-embed:335m": 768, "all-minilm": 384,
      "bge-large": 1024, "bge-base": 768,
      "gte-large": 1024, "thenlper/gte-large": 1024,
      "BAAI/bge-large-en-v1.5": 1024, "e5-large": 1024,
    };
    this.dimensions = knownDims[this.model] || 768;
  }

  async embed(text: string): Promise<number[]> {
    if (!(await this.ensureHealthy())) return emptyVector(this.dimensions);
    if (!text || !text.trim()) return emptyVector(this.dimensions);
    // Truncate to ~512 tokens (~2000 chars) for models with smaller context windows
    const truncated = text.trim().slice(0, 2000);
    // 30s wallclock cap. Without this, a wedged Ollama request blocks chat
    // prepare-request indefinitely (the fetch had no timeout). Returning an
    // empty vector lets semantic-search/tool-RAG degrade gracefully instead
    // of stalling the whole turn.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: truncated }),
        signal: ac.signal,
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
    } catch {
      // Suppress noisy per-chunk errors — batch fallback handles it
      return emptyVector(this.dimensions);
    } finally {
      clearTimeout(timer);
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
    // 60s wallclock cap for batches (10 items max per maxBatchSize). Same
    // rationale as embed() — never let Ollama hang the caller.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: validTexts }),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new Error(`Ollama batch embed HTTP ${res.status}`);
      }
      const json = (await res.json()) as { embeddings: number[][] };
      const validResults = json.embeddings ?? validTexts.map(() => emptyVector(this.dimensions));
      // Auto-detect dimensions from first successful result
      if (!this.dimensionsDetected && validResults[0]?.length > 0) {
        this.dimensions = validResults[0].length;
        this.dimensionsDetected = true;
      }
      // Map results back to original positions
      let vi = 0;
      return cleaned.map(t => t !== null ? validResults[vi++] || emptyVector(this.dimensions) : emptyVector(this.dimensions));
    } catch {
      // Batch failed — fall back silently to individual embeds
      const results: number[][] = [];
      for (const text of texts) {
        results.push(await this.embed(text));
      }
      return results;
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureHealthy(): Promise<boolean> {
    if (this.healthy !== null) return this.healthy;
    try {
      const { fetchLocalOllamaTags } = await import("../ollama-cloud.js");
      const { reachable } = await fetchLocalOllamaTags(this.baseUrl);
      if (!reachable) {
        logger.warn(`[ollama-embed] Server at ${this.baseUrl} not reachable`);
        this.healthy = false;
        return false;
      }
      // Verify the model is actually available — do a quick test embed.
      // First call to a large model (mxbai-embed-large = 1.3GB) can take 30-60s to load into GPU/RAM.
      try {
        const testRes = await fetch(`${this.baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, input: ["test"] }),
          signal: AbortSignal.timeout(60000), // 60s for first model load
        });
        if (!testRes.ok) {
          // Model not available — try fallback to nomic-embed-text
          if (this.model !== "nomic-embed-text") {
            logger.warn(`[ollama-embed] Model "${this.model}" not available (HTTP ${testRes.status}) — falling back to nomic-embed-text`);
            this.model = "nomic-embed-text";
            this.dimensions = 768;
            const fallbackRes = await fetch(`${this.baseUrl}/api/embed`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: this.model, input: ["test"] }),
              signal: AbortSignal.timeout(30000),
            });
            this.healthy = fallbackRes.ok;
          } else {
            this.healthy = false;
          }
        } else {
          this.healthy = true;
        }
      } catch {
        this.healthy = false;
      }
    } catch {
      this.healthy = false;
      logger.warn(`[ollama-embed] Server at ${this.baseUrl} not reachable`);
    }
    return this.healthy;
  }
}
