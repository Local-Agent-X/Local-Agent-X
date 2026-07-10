import { isLocalOnlyMode } from "../local-only-policy.js";
import { emptyVector } from "./helpers.js";
import type { ExtendedEmbeddingProvider } from "./types.js";

/** Keeps a provider selected for later restoration while preventing a live
 * remote provider object from making calls after strict mode is enabled. */
export class LocalOnlyEmbeddingGuard implements ExtendedEmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;

  constructor(private readonly inner: ExtendedEmbeddingProvider) {
    this.name = inner.name;
    this.model = inner.model;
    this.dimensions = inner.dimensions;
    this.maxBatchSize = inner.maxBatchSize;
  }

  embed(text: string): Promise<number[]> {
    return isLocalOnlyMode() ? Promise.resolve(emptyVector(this.dimensions)) : this.inner.embed(text);
  }

  embedQuery(text: string): Promise<number[]> {
    return isLocalOnlyMode() ? Promise.resolve(emptyVector(this.dimensions)) : this.inner.embedQuery(text);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return isLocalOnlyMode()
      ? Promise.resolve(texts.map(() => emptyVector(this.dimensions)))
      : this.inner.embedBatch(texts);
  }
}
