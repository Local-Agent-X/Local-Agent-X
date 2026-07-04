/**
 * Chunk C3 — scheduler resource locks (non-blocking) + gpu:0 stamp bridge.
 *
 * The canonical scheduler serializes ops that declare the same `resourceLocks`
 * key — non-blocking (skip + requeue, never awaited) — so two ops that both run
 * on the single local GPU can't contend on it. And the anti-inert bridge: an op
 * routed to the local model provider actually receives ["gpu:0"], stamped at
 * canonicalLoopEntry from provider-matrix's `resourceLocks` capability.
 *
 * Coverage:
 *   (a) two ops each with resourceLocks:["gpu:0"] → only ONE runs at a time;
 *       when the first completes the second launches (release re-pumps).
 *   (b) an op WITHOUT resourceLocks is never gated by a held lock — it runs
 *       concurrently alongside a gpu:0 op.
 *   (c) the bridge: resourceLocksForProvider("local") === ["gpu:0"] (hosted →
 *       []), and canonicalLoopEntry stamps a local-routed op with ["gpu:0"]
 *       while a hosted-routed op stays lock-free.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalLoopEntry,
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
  awaitIdle,
  resetBus,
  setLeaseConfig,
  resetLeaseConfig,
  schedulerSnapshot,
  evictWorker,
} from "../src/canonical-loop/index.js";
import { anyHeld } from "../src/canonical-loop/resource-locks.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import { bootstrapProviderMatrix, resourceLocksForProvider } from "../src/ops/provider-matrix.js";
import type { Op, OpLane } from "../src/ops/types.js";

import { FakeAdapter, scriptTurn, scriptLongStreamingTurn } from "./canonical-loop/fake-adapter.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  process.env.LAX_CANONICAL_LOOP_BUILD = "1";
  process.env.LAX_CANONICAL_LOOP_BACKGROUND = "1";
  process.env.LAX_CANONICAL_LOOP_IDE = "1";
  setLeaseConfig({ leaseDurationMs: 500, heartbeatIntervalMs: 100 });
});

afterEach(async () => {
  await awaitIdle(5_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetLeaseConfig();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
  delete process.env.LAX_CANONICAL_LOOP_BUILD;
  delete process.env.LAX_CANONICAL_LOOP_BACKGROUND;
  delete process.env.LAX_CANONICAL_LOOP_IDE;
});

interface MkOpOpts {
  lane?: OpLane;
  resourceLocks?: string[];
  preferredProvider?: string;
}

function mkOp(label: string, opts: MkOpOpts = {}): Op {
  const lane = opts.lane ?? "interactive";
  const contextPack = (opts.preferredProvider
    ? { routing: { lane, preferredProvider: opts.preferredProvider } }
    : {}) as Op["contextPack"];
  const op: Op = {
    id: track(newOpId(`it12rl_${label}`)),
    type: "freeform",
    task: `resource-lock ${label}`,
    contextPack,
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-c3-resource-locks",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
  if (opts.resourceLocks) op.resourceLocks = opts.resourceLocks;
  return op;
}

async function awaitTerminal(opId: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    const s = op?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") {
      if ((op?.canonical?.leaseOwner ?? null) === null) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`awaitTerminal timed out for ${opId} — state=${s}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

async function awaitRunning(opId: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readOp(opId)?.canonical?.state === "running") return;
    if (Date.now() > deadline) {
      throw new Error(`awaitRunning timed out for ${opId} — state=${readOp(opId)?.canonical?.state}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

// ── (a) two gpu:0 ops serialize; the second launches after the first ────────

describe("scheduler serializes ops that share a resource lock", () => {
  it("two ops each holding gpu:0 never run at once; the second launches when the first releases", async () => {
    // Both on `interactive` (cap 10) with no global-cap config, so the LANE
    // would happily run both at once — the ONLY thing that can serialize them
    // is the shared gpu:0 lock. Long streams so the first stays running long
    // enough to observe the second sitting queued behind the lock.
    const a = mkOp("gpuA", { resourceLocks: ["gpu:0"] });
    const b = mkOp("gpuB", { resourceLocks: ["gpu:0"] });
    for (const op of [a, b]) {
      const adapter = new FakeAdapter({
        script: [scriptLongStreamingTurn({ chunkIntervalMs: 15, maxChunks: 25 })],
      });
      registerAdapterForOp(op.id, () => adapter);
    }

    canonicalLoopEntry(a);
    canonicalLoopEntry(b);

    // Sample the scheduler: activeCount must NEVER exceed 1 (the lock caps
    // concurrent holders to one), and we must actually SEE 1 active with the
    // other queued — proving the lock, not a slow start, is the binding limit.
    let maxActive = 0;
    let sawOneActiveWithQueue = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !sawOneActiveWithQueue) {
      const snap = schedulerSnapshot();
      maxActive = Math.max(maxActive, snap.activeCount);
      if (snap.activeCount === 1 && snap.queueDepth >= 1) sawOneActiveWithQueue = true;
      await new Promise(r => setTimeout(r, 3));
    }
    expect(maxActive, `lock breached: ${maxActive} gpu:0 ops active at once`).toBeLessThanOrEqual(1);
    expect(sawOneActiveWithQueue, "never observed 1 active with the other queued behind the lock").toBe(true);

    // Both drain to terminal — the second only runs because releasing the lock
    // re-pumps the scheduler. Assert the ceiling held the whole way.
    while (schedulerSnapshot().queueDepth > 0 && Date.now() < deadline + 5_000) {
      maxActive = Math.max(maxActive, schedulerSnapshot().activeCount);
      await new Promise(r => setTimeout(r, 3));
    }
    expect(maxActive, `lock breached during drain: ${maxActive}`).toBeLessThanOrEqual(1);

    await Promise.all([awaitTerminal(a.id), awaitTerminal(b.id)]);
    expect(readOp(a.id)?.canonical?.state).toBe("succeeded");
    expect(readOp(b.id)?.canonical?.state).toBe("succeeded");
  });
});

// ── (b) a lock-free op is never gated by a held lock ────────────────────────

describe("a lock-free op is not gated by a held resource lock", () => {
  it("an op without resourceLocks runs concurrently with a gpu:0 op", async () => {
    // The gpu:0 op holds the lock for a while (long stream). A lock-free op on
    // the same lane must launch immediately alongside it — anyHeld(undefined)
    // is false, so the held gpu:0 never blocks it. Both reach `running` at once.
    const gpu = mkOp("gpuHolder", { resourceLocks: ["gpu:0"] });
    const free = mkOp("lockFree");
    for (const op of [gpu, free]) {
      const adapter = new FakeAdapter({
        script: [scriptLongStreamingTurn({ chunkIntervalMs: 20, maxChunks: 60 })],
      });
      registerAdapterForOp(op.id, () => adapter);
    }

    canonicalLoopEntry(gpu);
    canonicalLoopEntry(free);

    const bothRunning = async (timeoutMs = 2_500): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const sg = readOp(gpu.id)?.canonical?.state;
        const sf = readOp(free.id)?.canonical?.state;
        if (sg === "running" && sf === "running") return;
        if (Date.now() > deadline) {
          throw new Error(`both not running — gpu=${sg} free=${sf}`);
        }
        await new Promise(r => setTimeout(r, 5));
      }
    };

    await bothRunning();
    expect(readOp(gpu.id)?.canonical?.state).toBe("running");
    expect(readOp(free.id)?.canonical?.state).toBe("running");
  });
});

// ── (c) the anti-inert bridge: local provider → gpu:0, stamped at entry ──────

describe("gpu:0 stamp bridges the local provider through provider-matrix", () => {
  it("resourceLocksForProvider maps the local provider to gpu:0 and hosted to none", () => {
    bootstrapProviderMatrix();
    expect(resourceLocksForProvider("local")).toEqual(["gpu:0"]);
    expect(resourceLocksForProvider("xai")).toEqual([]);
    expect(resourceLocksForProvider("anthropic")).toEqual([]);
    expect(resourceLocksForProvider(undefined)).toEqual([]);
  });

  it("canonicalLoopEntry stamps a local-routed op with gpu:0 and leaves a hosted op lock-free", async () => {
    bootstrapProviderMatrix();

    const local = mkOp("localRouted", { preferredProvider: "local" });
    const hosted = mkOp("hostedRouted", { preferredProvider: "xai" });
    for (const op of [local, hosted]) {
      registerAdapterForOp(
        op.id,
        () => new FakeAdapter({ script: [scriptTurn({ streamChunks: ["x"], text: "ok", terminal: "done" })] }),
      );
    }

    canonicalLoopEntry(local);
    canonicalLoopEntry(hosted);

    // The stamp lands synchronously in canonicalLoopEntry's writeOp, before the
    // op is pumped — so it's readable immediately, independent of run outcome.
    expect(readOp(local.id)?.resourceLocks).toEqual(["gpu:0"]);
    expect(readOp(hosted.id)?.resourceLocks ?? []).toEqual([]);

    await Promise.all([awaitTerminal(local.id), awaitTerminal(hosted.id)]);
    expect(readOp(local.id)?.canonical?.state).toBe("succeeded");
    expect(readOp(hosted.id)?.canonical?.state).toBe("succeeded");
  });
});

// ── (d) recovery/evict path — the leak's actual home ────────────────────────

describe("evicting a resource-lock holder releases the lock (recovery path)", () => {
  it("frees gpu:0 for a queued holder and never double-holds through the handoff", async () => {
    // A holds gpu:0 (long stream, stays running); B (also gpu:0) is submitted
    // and SKIPPED behind the lock. Forcing A through evictWorker — the exact
    // bookkeeping-teardown recovery.ts calls on a lease-lost / crashed worker —
    // must release gpu:0 and re-pump so B launches. If the release ever leaked
    // (e.g. a null op re-read), B would queue forever = permanent local-model
    // deadlock. This is the path the skeptic flagged.
    const a = mkOp("evA", { resourceLocks: ["gpu:0"] });
    const b = mkOp("evB", { resourceLocks: ["gpu:0"] });
    registerAdapterForOp(a.id, () =>
      new FakeAdapter({ script: [scriptLongStreamingTurn({ chunkIntervalMs: 15, maxChunks: 40 })] }));
    registerAdapterForOp(b.id, () =>
      new FakeAdapter({ script: [scriptLongStreamingTurn({ chunkIntervalMs: 15, maxChunks: 25 })] }));

    canonicalLoopEntry(a);
    await awaitRunning(a.id);

    // B enqueues + pumps in canonicalLoopEntry, but gpu:0 is held → it is
    // skipped and sits queued, NOT running.
    canonicalLoopEntry(b);
    expect(schedulerSnapshot().queueDepth, "B should be queued behind the lock").toBeGreaterThanOrEqual(1);
    expect(readOp(b.id)?.canonical?.state).not.toBe("running");

    // Evict A. release() runs off the in-memory activeLocks map, so it frees the
    // lock even though A's op dir is untouched here — and would still free it if
    // a real recovery had deleted the dir (the null-readOp path).
    expect(evictWorker(a.id)).toBe(true);

    // Sample the handoff: activeCount must never exceed 1 (no double-hold of the
    // single GPU), and B must launch (proving release + re-pump fired).
    let maxActive = 0;
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && readOp(b.id)?.canonical?.state !== "running") {
      maxActive = Math.max(maxActive, schedulerSnapshot().activeCount);
      await new Promise(r => setTimeout(r, 3));
    }
    maxActive = Math.max(maxActive, schedulerSnapshot().activeCount);
    expect(readOp(b.id)?.canonical?.state, "B never launched — lock leaked or no re-pump").toBe("running");
    expect(maxActive, `double-hold: ${maxActive} gpu:0 holders active at once`).toBeLessThanOrEqual(1);

    await awaitTerminal(b.id);
    expect(readOp(b.id)?.canonical?.state).toBe("succeeded");
    await awaitTerminal(a.id); // drain A's orphaned worker so cleanup is clean
  });

  it("leaves gpu:0 free (anyHeld === false) after evicting a lone holder", async () => {
    // Directly observe the released lock: a single gpu:0 holder, no queued
    // contender, so evictWorker's internal re-pump has nothing to re-acquire —
    // the held-set must read empty immediately after eviction.
    const a = mkOp("loneGpu", { resourceLocks: ["gpu:0"] });
    registerAdapterForOp(a.id, () =>
      new FakeAdapter({ script: [scriptLongStreamingTurn({ chunkIntervalMs: 15, maxChunks: 40 })] }));

    canonicalLoopEntry(a);
    await awaitRunning(a.id);
    expect(anyHeld(["gpu:0"]), "holder should be holding gpu:0 while running").toBe(true);

    expect(evictWorker(a.id)).toBe(true);
    expect(anyHeld(["gpu:0"]), "gpu:0 must be free right after eviction").toBe(false);

    await awaitTerminal(a.id); // drain A's orphaned worker
  });
});
