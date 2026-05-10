import { createLogger } from "../logger.js";
import { emptyVector, fetchWithRetry } from "./helpers.js";
import type { ExtendedEmbeddingProvider } from "./types.js";

const logger = createLogger("embedding-providers");

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
    this.baseUrl = (opts.baseUrl ?? "https://api.mistral.ai/v1").replace(/\/$/, "");
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
        },
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
      logger.warn(`[mistral-embed] Failed: ${err?.message ?? err}`);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }
}
