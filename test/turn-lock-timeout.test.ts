/**
 * Regression suite for tryAcquireOrReplace's async commit-wait + deadlock guard.
 *
 * tryAcquireOrReplace is the high-level chat-route policy. The three behaviors
 * pinned here:
 *   1. No prior turn  -> acquires immediately (reason "no-active").
 *   2. Prior turn in-flight, non-committing -> aborts it, AWAITS the prior
 *      turn's `completion` promise (so fresh session state is read), then
 *      acquires (reason "aborted-non-committing").
 *   3. Prior turn that never releases -> after the 5s bound it force-releases
 *      the stuck slot and acquires anyway (no deadlock).
 *
 * The timeout is hardcoded to 5000ms inside the module (not injectable), so the
 * stuck-turn case uses vitest fake timers to drive the setTimeout race without
 * a real 5s wall-clock wait.
 *
 * The registry is a module-level singleton shared across tests, so every test
 * cleans up its session slot in afterEach.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  tryAcquireOrReplace,
  getTurnRegistry,
  releaseTurn,
  getActiveTurn,
} from "../src/session/turn-lock.js";

const registry = getTurnRegistry();
const SESSION = "sess-timeout-test";

afterEach(() => {
  // Always drop the slot so the next test starts clean.
  releaseTurn(SESSION);
  vi.useRealTimers();
});

describe("tryAcquireOrReplace — no prior turn", () => {
  it("acquires immediately with reason no-active", async () => {
    expect(getActiveTurn(SESSION)).toBeNull();

    const ac = new AbortController();
    const decision = await tryAcquireOrReplace(SESSION, ac, "first");

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("no-active");
    expect(decision.previous).toBeUndefined();
    expect(getActiveTurn(SESSION)).not.toBeNull();
  });
});

describe("tryAcquireOrReplace — prior turn in flight (non-committing)", () => {
  it("aborts the prior turn, awaits its completion, then acquires", async () => {
    // Seed an in-flight prior turn directly on the registry.
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "prior")).toBe(true);
    expect(priorAc.signal.aborted).toBe(false);

    const newAc = new AbortController();
    const decisionPromise = tryAcquireOrReplace(SESSION, newAc, "second");

    // The prior turn's controller should be aborted by the replace logic.
    // tryAcquireOrReplace is now awaiting the prior turn's completion promise,
    // which resolves only when the prior handler calls releaseTurn. Simulate
    // that handler finishing its commit.
    expect(priorAc.signal.aborted).toBe(true);
    releaseTurn(SESSION); // settles the completion promise

    const decision = await decisionPromise;
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("aborted-non-committing");
    expect(decision.previous?.sessionId).toBe(SESSION);

    // The NEW turn now owns the slot (not aborted).
    expect(newAc.signal.aborted).toBe(false);
    expect(getActiveTurn(SESSION)).not.toBeNull();
  });
});

describe("tryAcquireOrReplace — prior turn refuses to release (deadlock guard)", () => {
  it("force-releases the stuck slot after the 5s bound and acquires the new turn", async () => {
    vi.useFakeTimers();

    // A prior turn whose handler never calls releaseTurn -> its completion
    // promise never resolves on its own.
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "stuck")).toBe(true);

    const newAc = new AbortController();
    const decisionPromise = tryAcquireOrReplace(SESSION, newAc, "rescue");

    // The prior turn is aborted, but its completion never settles. The function
    // is parked on Promise.race([completion, setTimeout(5000)]). Drive the fake
    // clock past the bound; advanceTimersByTimeAsync also flushes the resolved
    // microtasks so the race settles.
    expect(priorAc.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5001);

    const decision = await decisionPromise;
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("aborted-non-committing");

    // No deadlock: the new turn holds the slot and is not aborted.
    expect(newAc.signal.aborted).toBe(false);
    expect(getActiveTurn(SESSION)).not.toBeNull();
  });
});

describe("tryAcquireOrReplace — prior turn already committed", () => {
  it("refuses with details and leaves the prior turn untouched", async () => {
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "committed")).toBe(true);
    // Drive it to a committed state via a real committing tool call.
    // `bash` is a committing-risk tool per committing-tool-check.
    registry.markIteration(SESSION, ["bash"]);
    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(true);

    const newAc = new AbortController();
    const decision = await tryAcquireOrReplace(SESSION, newAc, "blocked");

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("refused-committing");
    expect(decision.previous?.hasCommitted).toBe(true);

    // Prior turn is NOT aborted; new controller did not take the slot.
    expect(priorAc.signal.aborted).toBe(false);
    expect(newAc.signal.aborted).toBe(false);
  });
});
