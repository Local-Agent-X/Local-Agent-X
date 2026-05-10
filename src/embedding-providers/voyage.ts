import { createLogger } from "../logger.js";
import { emptyVector, fetchWithRetry } from "./helpers.js";
import type { ExtendedEmbeddingProvider } from "./types.js";

const logger = createLogger("embedding-providers");

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
    this.baseUrl = (opts.baseUrl ?? "https://api.voyageai.com/v1").replace(/\/$/, "");
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

  private async requestEmbeddings(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
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
        },
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
      logger.warn(`[voyage-embed] Failed: ${err?.message ?? err}`);
      return texts.map(() => emptyVector(this.dimensions));
    }
  }
}
