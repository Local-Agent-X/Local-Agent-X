/**
 * A search waits only briefly for the index to catch up. Re-indexing used to
 * run inside whichever search came first after a change: the nightly dream's
 * searches timed out at 30 s seventeen times (2026-09..11) and one chat turn
 * in ten waited over 2 s for its memory lookup. Now every caller shares one
 * pass, a search answers after SEARCH_SYNC_WAIT_MS from the index as it
 * stands while the pass carries on, and a change made during a pass is still
 * indexed by the next one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gate = vi.hoisted(() => ({ calls: 0, release: [] as Array<() => void> }));
vi.mock("./index-sync.js", async (orig) => {
  const real = await orig<typeof import("./index-sync.js")>();
  return {
    ...real,
    // A pass that takes as long as the test says: it ends when released.
    syncIndex: async (deps: { dirtyRef: { value: boolean } }) => {
      gate.calls++;
      deps.dirtyRef.value = false;
      await new Promise<void>((r) => gate.release.push(r));
    },
  };
});

const { MemoryIndex, SEARCH_SYNC_WAIT_MS } = await import("./index-core.js");

let dir: string;
let memory: InstanceType<typeof MemoryIndex>;

beforeEach(() => {
  gate.calls = 0; gate.release.length = 0;
  dir = mkdtempSync(join(tmpdir(), "lax-sync-wait-"));
  mkdirSync(join(dir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(dir, { minScore: -1 });
});

afterEach(() => {
  gate.release.forEach((r) => r());
  vi.useRealTimers();
  try { memory.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const releaseAll = async () => { while (gate.release.length) gate.release.shift()!(); await Promise.resolve(); };

describe("index pass and search", () => {
  it("answers a search after the wait while a long pass carries on", async () => {
    vi.useFakeTimers();
    memory.markDirty();
    let answered = false;
    const search = memory.search("anything").then(() => { answered = true; });
    await vi.advanceTimersByTimeAsync(SEARCH_SYNC_WAIT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await search;
    expect(answered).toBe(true);
    expect(gate.release).toHaveLength(1); // the pass is still running
  });

  it("runs one pass for every caller that arrives while it runs", async () => {
    memory.markDirty();
    const a = memory.sync();
    const b = memory.sync();
    expect(gate.calls).toBe(1);
    await releaseAll();
    await Promise.all([a, b]);
    expect(gate.calls).toBe(1);
  });

  it("indexes a change made during a pass on the next one", async () => {
    memory.markDirty();
    const first = memory.sync();
    memory.markDirty(); // a memory written mid-pass
    await releaseAll();
    await first;
    const second = memory.sync();
    expect(gate.calls).toBe(2);
    await releaseAll();
    await second;
    await memory.sync();
    expect(gate.calls).toBe(2); // clean now: nothing left to do
  });
});
