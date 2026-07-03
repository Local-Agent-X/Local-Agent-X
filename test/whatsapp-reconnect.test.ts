import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppBridge, WA_RECONNECT_BASE_MS, WA_RECONNECT_MAX_MS } from "../src/whatsapp-bridge/index.js";

// Seam: WhatsAppBridge reconnect supervisor (scheduleReconnect / reconnectDelayMs).
// BR-3 — a dropped connection must reconnect with CAPPED EXPONENTIAL BACKOFF and,
// critically, keep retrying FOREVER even when startSocket() THROWS (wake-from-sleep
// DNS error). The pre-fix code used a fixed 5s retry and set a terminal `disconnected`
// on the first throw, bricking the bridge until a manual reconnect.

function makeBridge(): { bridge: WhatsAppBridge; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "wa-reconnect-"));
  const bridge = new WhatsAppBridge({ dataDir: dir, onMessage: async () => "" });
  return { bridge, dir };
}

describe("WhatsAppBridge reconnect (BR-3)", () => {
  let created: string[] = [];
  beforeEach(() => {
    created = [];
    vi.useFakeTimers();
    // 0.5 → jitter factor (0.75 + 0.5*0.5) = 1.0, so delays land exactly on base*2^n.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const d of created) rmSync(d, { recursive: true, force: true });
  });

  it("grows the reconnect delay exponentially per attempt, capped at 60s", () => {
    const { bridge, dir } = makeBridge();
    created.push(dir);
    const delay = (n: number) => (bridge as any).reconnectDelayMs(n) as number;
    expect([1, 2, 3, 4, 5, 6].map(delay)).toEqual([
      WA_RECONNECT_BASE_MS, // 5000
      10_000,
      20_000,
      40_000,
      WA_RECONNECT_MAX_MS, // 60000 (would be 80000 uncapped)
      WA_RECONNECT_MAX_MS,
    ]);
  });

  it("keeps retrying after startSocket() throws — a wake-from-sleep DNS error does not brick the bridge", async () => {
    const { bridge, dir } = makeBridge();
    created.push(dir);
    let calls = 0;
    // Every reconnect attempt fails as if the network is still down.
    (bridge as any).startSocket = vi.fn(async () => {
      calls += 1;
      throw new Error("getaddrinfo ENOTFOUND (network not up yet after wake)");
    });

    // Simulate a non-loggedOut drop scheduling the first reconnect.
    (bridge as any).state = "connecting";
    (bridge as any).scheduleReconnect();

    // Attempt 1 fires at 5s, throws, and — this is the fix — schedules attempt 2.
    await vi.advanceTimersByTimeAsync(WA_RECONNECT_BASE_MS);
    expect(calls).toBe(1);
    expect(bridge.state).not.toBe("disconnected"); // pre-fix: terminal "disconnected" here
    expect((bridge as any).reconnectTimer).not.toBeNull(); // a next attempt is pending

    // Attempt 2 fires at +10s, throws, schedules attempt 3 — proving retry-forever.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(2);
    expect((bridge as any).reconnectTimer).not.toBeNull();

    // Attempt 3 fires, scheduling attempt 4 — then an explicit disconnect() must stop
    // the loop (cancel the pending timer, flip to "disconnected") and never resurrect.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(3);
    expect((bridge as any).reconnectTimer).not.toBeNull(); // attempt 4 is pending
    await bridge.disconnect();
    expect((bridge as any).reconnectTimer).toBeNull(); // cancelled
    (bridge as any).scheduleReconnect(); // gate (state === "disconnected") refuses
    expect((bridge as any).reconnectTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(WA_RECONNECT_MAX_MS);
    expect(calls).toBe(3); // no further attempts after disconnect
  });
});
