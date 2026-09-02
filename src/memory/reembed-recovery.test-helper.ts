/**
 * Shared fixtures for the re-embed lane's provider seam
 * (index-core-reembed-on-recovery.test.ts, index-core-embedding-swap.test.ts).
 */
import type { MemoryIndex } from "./index.js";
import type { EmbeddingProvider } from "./types.js";

export const DIMS = 4;
export const realVector = () => Array.from({ length: DIMS }, (_, i) => (i + 1) / DIMS);
export const degradedVector = () => new Array<number>(DIMS).fill(0);

export interface RecoverableProvider extends EmbeddingProvider {
  /** What the provider answers for calls made from now on. */
  serving: boolean;
  /** Batches observed, in call order. */
  batches: string[][];
  /** Park every in-flight batch until release(). */
  hold(): void;
  release(): void;
  fireRecovery(): void;
  /** Whether a listener is currently attached. */
  subscribed(): boolean;
  /** When set, setEmbeddingProvider's attach await is parked on it (swap tests' mock seam). */
  attachGate?: Promise<void>;
}

/**
 * A provider with Ollama's degraded contract — zero vectors while down — plus
 * test-driven recovery and a gate to freeze a pass mid-batch. The answer is
 * decided at call time, so a batch held while "down" stays a failed batch
 * even if the provider comes back before it is released.
 */
export function recoverableProvider(): RecoverableProvider {
  let listener: (() => void) | null = null;
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => {};
  const provider: RecoverableProvider = {
    name: "fake", model: "m1", dimensions: DIMS,
    serving: true,
    batches: [],
    embed: async () => (provider.serving ? realVector() : degradedVector()),
    embedBatch: async (texts) => {
      provider.batches.push(texts);
      const answer = provider.serving ? realVector : degradedVector;
      await gate;
      return texts.map(() => answer());
    },
    onRecovered(l) {
      listener = l;
      return () => { if (listener === l) listener = null; };
    },
    hold() { gate = new Promise<void>((resolve) => { open = resolve; }); },
    release() { open(); },
    fireRecovery() { listener?.(); },
    subscribed: () => listener !== null,
  };
  return provider;
}

/** A chunk indexed while the provider was down: text on disk, no vector. */
export function insertUnembeddedChunk(memory: MemoryIndex, text: string): void {
  memory["db"].prepare(`
    INSERT INTO chunks (path, source, start_line, end_line, text, hash, content_hash, embedding, updated_at)
    VALUES ('t.md', 'personality', 1, 1, ?, ?, ?, NULL, ?)
  `).run(text, `h-${text}`, `h-${text}`, Date.now());
}

/** Long enough for a pass that was going to start to have reached embedBatch. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
