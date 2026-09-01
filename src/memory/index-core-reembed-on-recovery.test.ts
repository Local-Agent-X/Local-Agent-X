/**
 * Chunks indexed while the embedding provider was down land with a NULL
 * vector — keyword-searchable, vector-invisible. Until the recovery hook the
 * only re-embed pass ran at attach time, so a chunk that missed it waited for
 * the next boot (17× in one night's logs). These lock the seam on one real
 * MemoryIndex: the provider's recovery signal starts exactly one pass, a
 * second signal mid-pass coalesces instead of running in parallel, and it is
 * honoured once the pass settles rather than dropped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { countChunksMissingEmbedding } from "./index-embedding.js";
import type { EmbeddingProvider } from "./types.js";

const DIMS = 4;
const realVector = () => Array.from({ length: DIMS }, (_, i) => (i + 1) / DIMS);
const degradedVector = () => new Array<number>(DIMS).fill(0);

interface RecoverableProvider extends EmbeddingProvider {
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
}

/**
 * A provider with Ollama's degraded contract — zero vectors while down — plus
 * test-driven recovery and a gate to freeze a pass mid-batch. The answer is
 * decided at call time, so a batch held while "down" stays a failed batch
 * even if the provider comes back before it is released.
 */
function recoverableProvider(): RecoverableProvider {
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

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-reembed-recovery-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

/** A chunk indexed while the provider was down: text on disk, no vector. */
function insertUnembeddedChunk(text: string): void {
  memory["db"].prepare(`
    INSERT INTO chunks (path, source, start_line, end_line, text, hash, content_hash, embedding, updated_at)
    VALUES ('t.md', 'personality', 1, 1, ?, ?, ?, NULL, ?)
  `).run(text, `h-${text}`, `h-${text}`, Date.now());
}

const missing = () => countChunksMissingEmbedding(memory["db"]);

/** Long enough for a pass that was going to start to have reached embedBatch. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

describe("re-embed on provider recovery", () => {
  it("provider down at attach: recovery triggers exactly one pass; a further recovery with nothing missing is a no-op", async () => {
    const provider = recoverableProvider();
    provider.serving = false;
    insertUnembeddedChunk("alpha");
    insertUnembeddedChunk("beta");

    await memory.setEmbeddingProvider(provider);
    expect(provider.subscribed()).toBe(true);
    // The attach-time pass ran against a down provider and left both NULL.
    await vi.waitFor(() => expect(provider.batches).toHaveLength(1));
    await settle();
    expect(missing()).toBe(2);

    provider.serving = true;
    provider.fireRecovery();
    await vi.waitFor(() => expect(missing()).toBe(0));
    expect(provider.batches).toHaveLength(2);

    provider.fireRecovery();
    await settle();
    expect(provider.batches).toHaveLength(2);
  });

  it("a recovery during a running pass does not start a parallel pass, and is honoured once the pass settles", async () => {
    const provider = recoverableProvider();
    await memory.setEmbeddingProvider(provider);
    insertUnembeddedChunk("gamma");
    insertUnembeddedChunk("delta");
    insertUnembeddedChunk("epsilon");

    // Freeze the first pass inside its (failing) batch.
    provider.serving = false;
    provider.hold();
    provider.fireRecovery();
    await vi.waitFor(() => expect(provider.batches).toHaveLength(1));

    provider.fireRecovery();
    provider.fireRecovery();
    await settle();
    expect(provider.batches).toHaveLength(1); // coalesced, not parallel

    // The server is back by the time the frozen batch returns its zeros. The
    // queued recovery re-runs and lands every vector; nothing waited for boot.
    provider.serving = true;
    provider.release();
    await vi.waitFor(() => expect(missing()).toBe(0));
    expect(provider.batches).toHaveLength(2);
  });

  it("re-attaching detaches the previous provider's signal, and close() detaches the current one", async () => {
    const stale = recoverableProvider();
    const current = recoverableProvider();
    await memory.setEmbeddingProvider(stale);
    await memory.setEmbeddingProvider(current);
    expect(stale.subscribed()).toBe(false);
    expect(current.subscribed()).toBe(true);

    insertUnembeddedChunk("zeta");
    stale.fireRecovery();
    await settle();
    expect(missing()).toBe(1);
    expect(current.batches).toHaveLength(0);

    current.fireRecovery();
    await vi.waitFor(() => expect(missing()).toBe(0));

    memory.close();
    expect(current.subscribed()).toBe(false);
    expect(() => current.fireRecovery()).not.toThrow();
  });
});
