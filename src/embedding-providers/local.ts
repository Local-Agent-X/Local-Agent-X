import { emptyVector } from "./helpers.js";
import type { ExtendedEmbeddingProvider } from "./types.js";

/** TF-IDF embedding with feature hashing — pure local, zero network, deterministic. */
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
