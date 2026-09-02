/**
 * Chunks indexed while the embedding provider was down land with a NULL
 * vector — keyword-searchable, vector-invisible. Until the recovery hook the
 * only re-embed pass ran at attach time, so a chunk that missed it waited for
 * the next boot (17× in one night's logs). These lock the seam on one real
 * MemoryIndex: the provider's recovery signal starts exactly one pass, a
 * second signal mid-pass coalesces instead of running in parallel, and it is
 * honoured once the pass settles rather than dropped. The backoff suite locks
 * the flap bound: consecutive unsuccessful passes space out exponentially
 * instead of re-scanning back-to-back on every serving↔non-serving flap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { countChunksMissingEmbedding } from "./index-embedding.js";
import { BackgroundReembed } from "./index-core-reembed.js";
import type { MemoryConfig } from "./types.js";
import {
  recoverableProvider, insertUnembeddedChunk, settle,
} from "./reembed-recovery.test-helper.js";

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

const missing = () => countChunksMissingEmbedding(memory["db"]);

describe("re-embed on provider recovery", () => {
  it("provider down at attach: recovery triggers exactly one pass; a further recovery with nothing missing is a no-op", async () => {
    const provider = recoverableProvider();
    provider.serving = false;
    insertUnembeddedChunk(memory, "alpha");
    insertUnembeddedChunk(memory, "beta");

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
    insertUnembeddedChunk(memory, "gamma");
    insertUnembeddedChunk(memory, "delta");
    insertUnembeddedChunk(memory, "epsilon");

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

    insertUnembeddedChunk(memory, "zeta");
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

describe("re-embed flap backoff", () => {
  it("consecutive failed passes back off exponentially to the cap, kicks inside the window coalesce without scanning, and a full success resets", async () => {
    const provider = recoverableProvider();
    provider.serving = false;
    let nowMs = 1_000_000;
    const reembed = new BackgroundReembed({
      db: () => memory["db"],
      provider: () => provider,
      config: () => memory.getConfig() as MemoryConfig,
      hasVec: () => false,
      now: () => nowMs,
    });
    insertUnembeddedChunk(memory, "alpha");
    insertUnembeddedChunk(memory, "beta");

    const settled = async (batchCount: number) => {
      await vi.waitFor(() => expect(provider.batches).toHaveLength(batchCount));
      await vi.waitFor(() => expect(reembed["inProgress"]).toBe(false));
    };

    // Failure #1 runs immediately; so does #2 — the mid-pass-recovery rerun
    // contract keeps the FIRST retry after a failure undeferred.
    reembed.kick("recovered (flap 1)");
    await settled(1);
    expect(reembed["backoffMs"]).toBe(60_000);
    reembed.kick("recovered (flap 2)");
    await settled(2);
    expect(reembed["backoffMs"]).toBe(120_000);

    // Inside the 60s window armed by failure #2: no scan, one deferred retry.
    reembed.kick("recovered (flap 3)");
    reembed.kick("recovered (flap 4)");
    await settle();
    expect(provider.batches).toHaveLength(2);

    // Drive the ladder to the cap: each failure doubles the next window.
    const expectedBackoffs = [240_000, 480_000, 900_000, 900_000];
    for (const expected of expectedBackoffs) {
      nowMs += 15 * 60_000 + 1; // past any window
      reembed.kick("recovered (still flapping)");
      await settled(provider.batches.length + 1);
      expect(reembed["backoffMs"]).toBe(expected);
    }

    // Real recovery: the pass embeds everything and the ladder resets.
    provider.serving = true;
    nowMs += 15 * 60_000 + 1;
    reembed.kick("recovered for real");
    await vi.waitFor(() => expect(missing()).toBe(0));
    await vi.waitFor(() => expect(reembed["inProgress"]).toBe(false));
    expect(reembed["backoffMs"]).toBe(0);
    expect(reembed["notBefore"]).toBe(0);

    // Nothing missing → later kicks are no-ops regardless of backoff state.
    const batches = provider.batches.length;
    reembed.kick("recovered again");
    await settle();
    expect(provider.batches).toHaveLength(batches);
    reembed.dispose();
    expect(reembed["deferredKick"]).toBeNull();
  });

  it("dispose() cancels a deferred retry so it cannot fire against a closed index", async () => {
    const provider = recoverableProvider();
    provider.serving = false;
    let nowMs = 1_000_000;
    const reembed = new BackgroundReembed({
      db: () => memory["db"],
      provider: () => provider,
      config: () => memory.getConfig() as MemoryConfig,
      hasVec: () => false,
      now: () => nowMs,
    });
    insertUnembeddedChunk(memory, "gamma");

    reembed.kick("flap 1");
    await vi.waitFor(() => expect(reembed["inProgress"]).toBe(false));
    reembed.kick("flap 2"); // immediate retry, fails again → 60s window armed
    await vi.waitFor(() => expect(reembed["inProgress"]).toBe(false));
    nowMs += 1; // still inside the window
    reembed.kick("flap 3");
    expect(reembed["deferredKick"]).not.toBeNull();

    reembed.dispose();
    expect(reembed["deferredKick"]).toBeNull();
    expect(reembed["backoffMs"]).toBe(0);
  });
});
