import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildTurnContextCached, clearTurnContextCache } from "./turn-context-cache.js";
import type { MemoryManager, TurnContext, TurnContextInput } from "../memory/index.js";

// Locks CM-1: the cache used to anchor its invalidation hash on the FIRST user
// message of the window, so for any short session it never changed and served
// the full TTL. The fix fingerprints the CURRENT query (SimHash + Hamming) and
// bounds the TTL so a pivot rebuilds and the clock stays fresh.

function ctx(tag: string): TurnContext {
  return {
    contextBlock: `<current_datetime>${tag}</current_datetime>`,
    relevantMemories: tag,
    smartContext: "",
    memoryContext: tag,
    notifications: [],
    knownProjectsFound: false,
  };
}

function fakeManager(): { mgr: MemoryManager; build: ReturnType<typeof vi.fn> } {
  let n = 0;
  const build = vi.fn(async (_input: TurnContextInput) => ctx(`build-${++n}`));
  const mgr = { buildTurnContext: build } as unknown as MemoryManager;
  return { mgr, build };
}

function input(userMessage: string, priorUserMsgs: string[] = []): TurnContextInput {
  return {
    userMessage,
    sessionId: "sess-1",
    sessionMessages: priorUserMsgs.map(c => ({ role: "user", content: c })),
  };
}

describe("buildTurnContextCached invalidation (CM-1)", () => {
  beforeEach(() => clearTurnContextCache());
  afterEach(() => {
    clearTurnContextCache();
    vi.useRealTimers();
  });

  it("rebuilds when the current turn pivots to a different project (no stale replay)", async () => {
    const { mgr, build } = fakeManager();

    const first = "Let's work on the billing service invoice PDF export layout";
    const pivot = "Now switch to the mobile app push notification permission prompt flow";

    const r1 = await buildTurnContextCached(mgr, input(first));
    expect(build).toHaveBeenCalledTimes(1);
    expect(r1.memoryContext).toBe("build-1");

    const r2 = await buildTurnContextCached(mgr, input(pivot, [first]));
    expect(build).toHaveBeenCalledTimes(2);
    expect(r2.memoryContext).toBe("build-2");
    expect(r2.contextBlock).not.toBe(r1.contextBlock);
  });

  it("reuses the cached context for a near-identical same-topic follow-up", async () => {
    const { mgr, build } = fakeManager();

    const q = "How does the billing service invoice PDF export layout work here";
    const r1 = await buildTurnContextCached(mgr, input(q));
    expect(build).toHaveBeenCalledTimes(1);

    const r2 = await buildTurnContextCached(mgr, input(q, [q]));
    expect(build).toHaveBeenCalledTimes(1);
    expect(r2.memoryContext).toBe(r1.memoryContext);
  });

  it("does not serve an entry older than the TTL (bounds the frozen clock)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T10:00:00Z"));
    const { mgr, build } = fakeManager();

    const q = "Explain the billing service invoice PDF export layout in detail";
    await buildTurnContextCached(mgr, input(q));
    expect(build).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6 * 60 * 1000);
    await buildTurnContextCached(mgr, input(q, [q]));
    expect(build).toHaveBeenCalledTimes(2);
  });
});

// Locks the 2026-07-14 hang: a wedged retrieval dependency (Ollama embed,
// reranker load) made buildTurnContext block chat prepare for 95-200s. The
// wallclock backstop ships the turn without memory context instead of
// freezing, and the late build still warms the cache for the next turn.
describe("buildTurnContextCached wallclock backstop", () => {
  beforeEach(() => clearTurnContextCache());
  afterEach(() => {
    clearTurnContextCache();
    vi.useRealTimers();
  });

  it("ships an empty context when the build exceeds the wallclock, then serves the late build from cache", async () => {
    vi.useFakeTimers();
    let resolveBuild: (c: TurnContext) => void;
    const slow = new Promise<TurnContext>((r) => { resolveBuild = r; });
    const build = vi.fn(async (_input: TurnContextInput) => slow);
    const mgr = { buildTurnContext: build } as unknown as MemoryManager;

    const q = "Change the background pattern on the sip dirty landing page hero";
    const pending = buildTurnContextCached(mgr, input(q));
    await vi.advanceTimersByTimeAsync(10_100);
    const degraded = await pending;
    expect(degraded.contextBlock).toBe("");
    expect(degraded.relevantMemories).toBe("");
    expect(degraded.notifications).toEqual([]);

    // The wedged build completes late — it must warm the cache, not vanish.
    resolveBuild!(ctx("late"));
    await vi.advanceTimersByTimeAsync(0);

    const next = await buildTurnContextCached(mgr, input(q, [q]));
    expect(next.memoryContext).toBe("late");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("a build under the wallclock is returned and cached as before", async () => {
    const { mgr, build } = fakeManager();
    const q = "How does the billing service invoice PDF export layout work here";
    const r = await buildTurnContextCached(mgr, input(q));
    expect(r.memoryContext).toBe("build-1");
    expect(build).toHaveBeenCalledTimes(1);
  });
});
