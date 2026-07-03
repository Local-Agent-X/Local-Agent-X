/**
 * BR-4: the Telegram long-poll must survive an extended network outage.
 *
 * The old loop stopped after 10 consecutive poll errors (~6 min of backoff),
 * set state:error / polling:false and returned — so any router reboot or ISP
 * blip longer than a few minutes permanently killed the bridge with no retry
 * and no notification. Only a 401 (invalid/revoked token) is genuinely
 * terminal; every other failure must back off (capped at 60s) and keep polling
 * indefinitely. These tests lock that invariant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const apiCall = vi.fn();
vi.mock("./api.js", () => ({
  apiCall: (...args: unknown[]) => apiCall(...args),
  sendMessage: vi.fn(),
  sendVoice: vi.fn(),
  sendPhoto: vi.fn(),
  sendVideo: vi.fn(),
}));
vi.mock("./inbound.js", () => ({
  describeNonTextMessage: vi.fn(),
  dispatchReply: vi.fn(),
  transcribeInboundVoice: vi.fn(),
}));

import { TelegramBridge, pollBackoffDelay } from "./bridge.js";

function makeBridge(): any {
  const bridge = new TelegramBridge({
    dataDir: "/nonexistent-telegram-br4-test-dir",
    getToken: () => "TESTTOKEN",
    onMessage: async () => "",
  });
  const b = bridge as any;
  b.state = "connected";
  b.polling = true;
  b.pollAbort = new AbortController();
  return b;
}

/** Advance fake timers repeatedly until apiCall has been invoked `n` times
 *  (or we run out of the advance budget). Each advance fires the pending
 *  backoff timer and flushes the microtasks that schedule the next poll. */
async function drainUntilCalls(n: number, maxAdvances = 400): Promise<void> {
  for (let i = 0; i < maxAdvances && apiCall.mock.calls.length < n; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
}

describe("pollBackoffDelay", () => {
  it("grows exponentially then caps at 60s and never overflows", () => {
    expect(pollBackoffDelay(1)).toBe(5_000);
    expect(pollBackoffDelay(2)).toBe(10_000);
    expect(pollBackoffDelay(5)).toBe(60_000); // 5000 * 2^4 = 80000 -> cap
    expect(pollBackoffDelay(1000)).toBe(60_000);
    expect(Number.isFinite(pollBackoffDelay(1_000_000))).toBe(true);
  });
});

describe("TelegramBridge.pollLoop — outage resilience (BR-4)", () => {
  beforeEach(() => {
    apiCall.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps polling through far more than 10 consecutive errors (router/ISP outage)", async () => {
    // Every poll fails with a transient (non-401) error, forever.
    apiCall.mockResolvedValue({ ok: false, error_code: 502, description: "Bad Gateway" });

    const b = makeBridge();
    const loop = b.pollLoop("TESTTOKEN"); // runs forever; don't await

    // Drive well past the old MAX_ERRORS=10 cutoff.
    await drainUntilCalls(25);

    // Pre-fix code would have stopped at 10: polling=false, state="error".
    expect(apiCall.mock.calls.length).toBeGreaterThan(20);
    expect(b.polling).toBe(true);
    expect(b.state).toBe("connected");
    expect(b.lastError).toBeNull();

    // Clean shutdown so the loop terminates and the test can settle.
    b.polling = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await loop;
  });

  it("still treats a 401 as terminal (invalid/revoked token)", async () => {
    apiCall.mockResolvedValue({ ok: false, error_code: 401, description: "Unauthorized" });

    const b = makeBridge();
    await b.pollLoop("TESTTOKEN");

    expect(b.polling).toBe(false);
    expect(b.state).toBe("error");
    expect(b.lastError).toMatch(/invalid or revoked/i);
    expect(apiCall.mock.calls.length).toBe(1);
  });

  it("keeps polling through thrown network errors too (not just !ok responses)", async () => {
    apiCall.mockRejectedValue(new Error("ECONNREFUSED"));

    const b = makeBridge();
    const loop = b.pollLoop("TESTTOKEN");

    await drainUntilCalls(15);

    expect(apiCall.mock.calls.length).toBeGreaterThan(12);
    expect(b.polling).toBe(true);
    expect(b.state).toBe("connected");

    b.polling = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await loop;
  });
});
