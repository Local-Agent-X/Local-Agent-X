/**
 * CLASS INVARIANT: the bridge ops of ONE browser action share ONE budget.
 *
 * The instance (live 2026-09-20): `browser {action:"screenshot"}` issues a
 * lifecycle call, a credential-focus exec and a capture, each with its own
 * fixed ceiling from bridge-client-contract.ts. Individually all three fit
 * inside the tool's 30s; in sequence against an unresponsive desktop they ran
 * 31.9s, the tool blew its budget, and the innermost rejection won the race —
 * so the model read "capture timed out after 10000ms", treated 10s as a
 * transient hiccup, and retried for another 31.8s.
 *
 * So the test is not "capture times out". It is: a SEQUENCE cannot outlast the
 * action's budget, and what the model is told names the action.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const realSend = process.send;
const realFlag = process.env.LAX_DESKTOP_BRIDGE;

// A desktop that accepts every message and never replies — the shape of the
// incident, where each op ran to its own ceiling.
beforeAll(() => {
  process.env.LAX_DESKTOP_BRIDGE = "1";
  process.send = (() => true) as typeof process.send;
});
afterAll(() => {
  process.send = realSend;
  if (realFlag === undefined) delete process.env.LAX_DESKTOP_BRIDGE;
  else process.env.LAX_DESKTOP_BRIDGE = realFlag;
});

const { withBridgeDeadline, bridgeRemainingMs, bridgeElapsedMs } = await import("./bridge-deadline.js");
const { browserCapture, browserExec, BridgeDeadlineError, BridgeTimeoutError, CAPTURE_TIMEOUT_MS } =
  await import("./bridge-client.js");

const VIEW = "view-test";

describe("one action, one budget", () => {
  it("a sequence of ops cannot outlast the action's budget", async () => {
    const started = Date.now();
    const outcome = await withBridgeDeadline(300, "screenshot", async () => {
      // The screenshot shape: exec, then capture. Unbudgeted this is
      // EXEC_TIMEOUT_MS + CAPTURE_TIMEOUT_MS = 20s.
      try { await browserExec(VIEW, "1"); } catch { /* first op eats the budget */ }
      try { await browserCapture(VIEW); return "capture-returned"; } catch (e) { return e; }
    });
    const elapsed = Date.now() - started;

    expect(outcome).toBeInstanceOf(BridgeDeadlineError);
    expect(elapsed, `the sequence ran ${elapsed}ms against a 300ms budget`).toBeLessThan(2_000);
    expect(elapsed).toBeLessThan(CAPTURE_TIMEOUT_MS);
  });

  it("tells the model the ACTION ran out, not that one op hit its ceiling", async () => {
    const err = await withBridgeDeadline(120, "screenshot", async () => {
      try { await browserCapture(VIEW); return null; } catch (e) { return e as Error; }
    });
    expect(err).toBeInstanceOf(BridgeDeadlineError);
    // Names the action and the real wait — the two facts the 10000ms message
    // got wrong — and says a retry will not help.
    expect(err!.message).toContain("screenshot");
    expect(err!.message).toMatch(/ran out of time/);
    expect(err!.message).toMatch(/retrying this action will fail the same way/);
    expect(err!.message, "must not quote a per-op ceiling").not.toContain(String(CAPTURE_TIMEOUT_MS));
  });

  it("an op that starts with the budget already spent fails immediately", async () => {
    const started = Date.now();
    const err = await withBridgeDeadline(40, "snapshot", async () => {
      await new Promise((r) => setTimeout(r, 80));   // budget spent by earlier work
      try { await browserCapture(VIEW); return null; } catch (e) { return e as Error; }
    });
    expect(err).toBeInstanceOf(BridgeDeadlineError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("without a scope an op keeps its own ceiling, so non-tool callers are untouched", async () => {
    expect(bridgeRemainingMs()).toBeNull();
    expect(bridgeElapsedMs()).toBe(0);
    vi.useFakeTimers();
    try {
      const p = browserCapture(VIEW).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1);
      await vi.advanceTimersByTimeAsync(2);
      const err = await p;
      expect(err).toBeInstanceOf(BridgeTimeoutError);
      expect((err as Error).message).toContain(String(CAPTURE_TIMEOUT_MS));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a budget of 0 means unbounded — an exempt tool is not silently capped", async () => {
    await withBridgeDeadline(0, "navigate", async () => {
      expect(bridgeRemainingMs()).toBeNull();
    });
  });

  it("the outermost scope owns the budget, so a nested call cannot extend it", async () => {
    await withBridgeDeadline(5_000, "outer", async () => {
      const outer = bridgeRemainingMs()!;
      await withBridgeDeadline(60_000, "inner", async () => {
        expect(bridgeRemainingMs()!).toBeLessThanOrEqual(outer);
      });
    });
  });
});
