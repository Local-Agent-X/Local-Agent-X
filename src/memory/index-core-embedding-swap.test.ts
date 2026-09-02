/**
 * setEmbeddingProvider must be reentrant. Two hazards, both hit in production
 * shapes (runtime provider swap racing the boot retry loop; test teardown
 * racing a live re-embed):
 *
 * 1. A call superseded while awaiting attachEmbeddingProvider used to resume
 *    and re-subscribe its (stale) provider's onRecovered over the winner's —
 *    the old provider's flaps then drove passes while the live provider's
 *    recoveries went unheard.
 * 2. An in-flight BackgroundReembed pass captured the old provider at kick
 *    time and kept embedding with it after the swap, writing the superseded
 *    provider's vectors after the new provider's signature reconcile.
 *
 * The attach-await is gated per provider via a partial module mock so the
 * adversarial resume order (first call finishes LAST) is driven, not raced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./index-embedding.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./index-embedding.js")>();
  const attachEmbeddingProvider: typeof mod.attachEmbeddingProvider = async (db, provider) => {
    const out = await mod.attachEmbeddingProvider(db, provider);
    // Undefined for every provider that doesn't opt in — resolves immediately.
    await (provider as typeof provider & { attachGate?: Promise<void> }).attachGate;
    return out;
  };
  return { ...mod, attachEmbeddingProvider };
});

import { MemoryIndex } from "./index.js";
import { countChunksMissingEmbedding } from "./index-embedding.js";
import {
  recoverableProvider, insertUnembeddedChunk, settle,
} from "./reembed-recovery.test-helper.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-embedding-swap-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const missing = () => countChunksMissingEmbedding(memory["db"]);

describe("reentrant setEmbeddingProvider", () => {
  it("a swap that completes while an earlier attach is still awaited wins — the stale tail neither re-subscribes nor kicks", async () => {
    const p1 = recoverableProvider();
    let openGate!: () => void;
    p1.attachGate = new Promise<void>((resolve) => { openGate = resolve; });
    const p2 = recoverableProvider();
    insertUnembeddedChunk(memory, "alpha");

    const first = memory.setEmbeddingProvider(p1); // parked at its attach await
    await memory.setEmbeddingProvider(p2);         // completes fully first
    await vi.waitFor(() => expect(missing()).toBe(0)); // p2's attach kick ran

    openGate();
    await first;
    await settle();

    expect(p2.subscribed()).toBe(true);   // the winner's listener survived
    expect(p1.subscribed()).toBe(false);  // the stale tail stayed inert
    expect(p1.batches).toHaveLength(0);
    expect(memory["embeddingProvider"]).toBe(p2);

    // The live listener still drives passes for the current provider.
    insertUnembeddedChunk(memory, "beta");
    p2.fireRecovery();
    await vi.waitFor(() => expect(missing()).toBe(0));
  });

  it("swapping mid-re-embed stops the old provider's pass at its batch boundary and the new provider finishes the backlog", async () => {
    const p1 = recoverableProvider();
    await memory.setEmbeddingProvider(p1);
    for (let i = 0; i < 40; i++) insertUnembeddedChunk(memory, `chunk-${i}`); // 2 batches (32 + 8)

    p1.hold();
    p1.fireRecovery();
    await vi.waitFor(() => expect(p1.batches).toHaveLength(1)); // frozen inside batch 1

    const p2 = recoverableProvider();
    await memory.setEmbeddingProvider(p2); // attach kick coalesces behind the in-flight pass
    p1.release();

    await vi.waitFor(() => expect(missing()).toBe(0));
    expect(p1.batches).toHaveLength(1); // old pass never took batch 2
    expect(p2.batches.length).toBeGreaterThan(0); // successor re-embedded the backlog
    expect(p1.subscribed()).toBe(false);
    expect(p2.subscribed()).toBe(true);
  });

  it("attaching the same provider twice is idempotent — one listener, no duplicate pass", async () => {
    const provider = recoverableProvider();
    insertUnembeddedChunk(memory, "gamma");
    await memory.setEmbeddingProvider(provider);
    await vi.waitFor(() => expect(missing()).toBe(0));
    const batches = provider.batches.length;

    await memory.setEmbeddingProvider(provider);
    await settle();
    expect(provider.subscribed()).toBe(true);
    expect(provider.batches).toHaveLength(batches); // nothing missing → no second pass

    provider.fireRecovery();
    await settle();
    expect(provider.batches).toHaveLength(batches);
  });
});
