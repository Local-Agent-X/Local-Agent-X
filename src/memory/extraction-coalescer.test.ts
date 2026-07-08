/**
 * Pins the coalescer contract in front of runEndOfTurnMemoryWrite:
 *
 *   - idle session → run starts immediately
 *   - mid-run requests → single pending slot, latest ctx wins, exactly one
 *     trailing run
 *   - cursor advances on success (and on mutex skip), never on a throw
 *   - "tool"-source memory write since cursor → skip without an LLM call
 *   - trigger gate: no curate signal → nothing enqueues at all
 *   - drainPendingExtractions: bounded, never hangs
 *
 * The three collaborators are mocked at their module boundaries so each test
 * scripts run duration (deferred promises), gate signal, and write-clock
 * ticks directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryIndex } from "./index-core.js";
import type { EndOfTurnContext, EndOfTurnWriteOutcome } from "./end-of-turn-write.js";

const runMock = vi.fn<(ctx: EndOfTurnContext) => Promise<EndOfTurnWriteOutcome | void>>(
  async () => "completed",
);
vi.mock("./end-of-turn-write.js", () => ({
  runEndOfTurnMemoryWrite: (ctx: EndOfTurnContext) => runMock(ctx),
}));

let curateSignal = true;
vi.mock("./curate-nudge.js", () => ({
  hasCurateSignal: () => curateSignal,
}));

let globalTick = 0;
let toolTick = 0;
vi.mock("./write-safely.js", () => ({
  getMemoryWriteTick: () => globalTick,
  getLastWriteTick: (source: string) => (source === "tool" ? toolTick : 0),
}));

const { requestEndOfTurnExtraction, drainPendingExtractions, _internals } =
  await import("./extraction-coalescer.js");

function makeCtx(over: Partial<EndOfTurnContext> = {}): EndOfTurnContext {
  return {
    sessionId: "sess-1",
    userMessage: "user text",
    assistantReply: "agent text",
    memory: {} as unknown as MemoryIndex,
    ...over,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  _internals.reset();
  runMock.mockReset();
  runMock.mockImplementation(async () => {});
  curateSignal = true;
  globalTick = 0;
  toolTick = 0;
});

describe("requestEndOfTurnExtraction — coalescing", () => {
  it("runs immediately when the session is idle", async () => {
    const ctx = makeCtx();
    requestEndOfTurnExtraction(ctx);
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    expect(runMock).toHaveBeenCalledWith(ctx);
  });

  it("two mid-run requests collapse to exactly one trailing run with the LATEST ctx", async () => {
    const gate = deferred();
    runMock.mockImplementationOnce(() => gate.promise);

    requestEndOfTurnExtraction(makeCtx({ userMessage: "first" }));
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));

    // Both arrive while the first run is in flight — single pending slot.
    requestEndOfTurnExtraction(makeCtx({ userMessage: "stale-stash" }));
    requestEndOfTurnExtraction(makeCtx({ userMessage: "latest-stash" }));

    gate.resolve();
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(2));
    expect(runMock.mock.calls[1][0].userMessage).toBe("latest-stash");

    // No third run appears after the loop drains.
    await drainPendingExtractions(500);
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("keeps independent sessions independent (a run in one does not stash the other)", async () => {
    const gate = deferred();
    runMock.mockImplementationOnce(() => gate.promise);
    requestEndOfTurnExtraction(makeCtx({ sessionId: "sess-a" }));
    requestEndOfTurnExtraction(makeCtx({ sessionId: "sess-b" }));
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(2));
    gate.resolve();
    await drainPendingExtractions(500);
    expect(runMock).toHaveBeenCalledTimes(2);
  });
});

describe("cursor semantics", () => {
  it("advances on success, holds on a throwing run, then retries on the next request", async () => {
    globalTick = 3;
    requestEndOfTurnExtraction(makeCtx());
    await drainPendingExtractions(500);
    expect(_internals.states.get("sess-1")?.cursorTick).toBe(3);

    globalTick = 6;
    runMock.mockImplementationOnce(async () => { throw new Error("classifier down"); });
    requestEndOfTurnExtraction(makeCtx());
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(2));
    await drainPendingExtractions(500);
    // Cursor deliberately held at the last processed tick.
    expect(_internals.states.get("sess-1")?.cursorTick).toBe(3);

    requestEndOfTurnExtraction(makeCtx());
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(3));
    await drainPendingExtractions(500);
    expect(_internals.states.get("sess-1")?.cursorTick).toBe(6);
  });

  it("holds cursor on an 'unavailable' run, then advances when a later run completes", async () => {
    globalTick = 3;
    requestEndOfTurnExtraction(makeCtx());
    await drainPendingExtractions(500);
    expect(_internals.states.get("sess-1")?.cursorTick).toBe(3);

    // Classifier can't run at all (env-disabled / no credentialed provider).
    globalTick = 6;
    runMock.mockImplementationOnce(async () => "unavailable");
    requestEndOfTurnExtraction(makeCtx());
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(2));
    await drainPendingExtractions(500);
    // Cursor held — unavailable is NOT success; the delta stays retryable.
    expect(_internals.states.get("sess-1")?.cursorTick).toBe(3);
    expect(_internals.states.get("sess-1")?.inProgress).toBe(false); // no wedge

    // Provider back: the next curate turn retries and the cursor advances.
    requestEndOfTurnExtraction(makeCtx());
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(3));
    await drainPendingExtractions(500);
    expect(_internals.states.get("sess-1")?.cursorTick).toBe(6);
  });

  it("an 'unavailable' in-flight run still processes its trailing stashed run", async () => {
    let release!: () => void;
    runMock.mockImplementationOnce(
      () => new Promise<EndOfTurnWriteOutcome>((res) => { release = () => res("unavailable"); }),
    );
    requestEndOfTurnExtraction(makeCtx({ userMessage: "in-flight-unavailable" }));
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    requestEndOfTurnExtraction(makeCtx({ userMessage: "stashed" }));

    release();
    await drainPendingExtractions(500);
    // Stash-one-trailing semantics intact across the unavailable outcome.
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock.mock.calls[1][0].userMessage).toBe("stashed");
    expect(_internals.states.get("sess-1")?.inProgress).toBe(false);
  });

  it("skips WITHOUT an LLM call and advances when a tool-source write landed since the cursor", async () => {
    globalTick = 4;
    requestEndOfTurnExtraction(makeCtx());
    await drainPendingExtractions(500);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(_internals.states.get("sess-1")?.cursorTick).toBe(4);

    // Main agent curates memory itself (memory_update_profile → tick 5).
    toolTick = 5;
    globalTick = 6;
    requestEndOfTurnExtraction(makeCtx());
    await drainPendingExtractions(500);
    expect(runMock).toHaveBeenCalledTimes(1); // no second LLM pass
    expect(_internals.states.get("sess-1")?.cursorTick).toBe(6); // skip AND advance
  });
});

describe("trigger gate", () => {
  it("a session without a curate signal never enqueues (no state, no run)", async () => {
    curateSignal = false;
    requestEndOfTurnExtraction(makeCtx());
    await drainPendingExtractions(100);
    expect(runMock).not.toHaveBeenCalled();
    expect(_internals.states.size).toBe(0);
  });

  it("ignores contexts missing sessionId/userMessage/assistantReply", async () => {
    requestEndOfTurnExtraction(makeCtx({ sessionId: "" }));
    requestEndOfTurnExtraction(makeCtx({ userMessage: "" }));
    requestEndOfTurnExtraction(makeCtx({ assistantReply: "" }));
    await drainPendingExtractions(100);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe("drainPendingExtractions — shutdown boundary", () => {
  it("waits for the in-flight run AND its trailing stashed run", async () => {
    const gate = deferred();
    runMock.mockImplementationOnce(() => gate.promise);
    requestEndOfTurnExtraction(makeCtx({ userMessage: "in-flight" }));
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    requestEndOfTurnExtraction(makeCtx({ userMessage: "stashed" }));

    const drain = drainPendingExtractions(2000);
    setTimeout(() => gate.resolve(), 20);
    await drain;
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock.mock.calls[1][0].userMessage).toBe("stashed");
  });

  it("returns after the timeout when a run never settles — never hangs shutdown", async () => {
    const stuck = deferred(); // never resolved before drain returns
    runMock.mockImplementationOnce(() => stuck.promise);
    requestEndOfTurnExtraction(makeCtx());
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));

    const started = Date.now();
    await drainPendingExtractions(50);
    expect(Date.now() - started).toBeLessThan(1500);

    stuck.resolve(); // let the chain settle so nothing leaks past the test
    await drainPendingExtractions(500);
  });

  it("resolves immediately when nothing is in flight", async () => {
    const started = Date.now();
    await drainPendingExtractions(5000);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
