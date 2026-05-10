import { createLogger } from "../logger.js";
import { emptyVector, fetchWithRetry } from "./helpers.js";
import type { ExtendedEmbeddingProvider } from "./types.js";

const logger = createLogger("embedding-providers");

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
    this.baseUrl = (opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
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
        },
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
      logger.warn(`[gemini-embed] Batch failed: ${err?.message ?? err}`);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }

  private async embedSingle(text: string, taskType: string): Promise<number[]> {
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
        },
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
      logger.warn(`[gemini-embed] Failed: ${err?.message ?? err}`);
      return emptyVector(this.dimensions);
    }
  }
}
