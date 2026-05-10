import { createLogger } from "../logger.js";
import { emptyVector, fetchWithRetry } from "./helpers.js";
import type { ExtendedEmbeddingProvider } from "./types.js";

const logger = createLogger("embedding-providers");

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
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
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
      if (err?.modelUnavailable && this.model !== this.fallbackModel) {
        logger.warn(
          `[openai-embed] Model ${this.model} unavailable, falling back to ${this.fallbackModel}`,
        );
        this.model = this.fallbackModel;
        return this.requestEmbeddings(texts, this.fallbackModel);
      }
      logger.warn(`[openai-embed] Embedding failed: ${err?.message ?? err}`);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }

  private async requestEmbeddings(texts: string[], model: string): Promise<number[][]> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: texts, model }),
      },
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
