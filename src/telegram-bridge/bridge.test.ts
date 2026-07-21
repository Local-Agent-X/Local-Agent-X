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
const { dispatchReply } = vi.hoisted(() => ({ dispatchReply: vi.fn() }));
vi.mock("./api.js", () => ({
  apiCall: (...args: unknown[]) => apiCall(...args),
  sendMessage: vi.fn(),
  sendVoice: vi.fn(),
  sendPhoto: vi.fn(),
  sendVideo: vi.fn(),
}));
vi.mock("./inbound.js", () => ({
  describeNonTextMessage: vi.fn(),
  dispatchReply,
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

  it("does not advance provider offset until a failed outbound send is redelivered", async () => {
    const update = { update_id: 994, message: { chat: { id: 42 }, from: { first_name: "Peter" }, text: "hello" } };
    apiCall.mockImplementation(async (_token, _method, args) => Number(args?.offset) >= 995
      ? { ok: false, error_code: 401, description: "test stop" }
      : { ok: true, result: [update] });
    dispatchReply.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const acknowledgeDelivery = vi.fn().mockResolvedValue(undefined);
    const onMessage = vi.fn().mockResolvedValue({ text: "wire", speakable: "raw", acknowledgeDelivery });
    const b = makeBridge();
    b.onMessage = onMessage;
    b.allowedChatIds = new Set(["42"]);
    b.ownerVerified = true;
    const loop = b.pollLoop("TESTTOKEN");
    await vi.advanceTimersByTimeAsync(1_000);
    await loop;
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(acknowledgeDelivery.mock.calls).toEqual([[false], [true]]);
    expect(b.offset).toBe(995);
  });
});

describe("TelegramBridge inbound identity", () => {
  beforeEach(() => dispatchReply.mockReset());

  it("forwards the stable update id to the canonical inbound runner", async () => {
    apiCall.mockResolvedValue({ ok: true });
    const onMessage = vi.fn().mockResolvedValue(null);
    const bridge = new TelegramBridge({
      dataDir: "/nonexistent-telegram-delivery-test-dir",
      getToken: () => "TESTTOKEN",
      onMessage,
    }) as any;
    bridge.state = "connected";
    bridge.allowedChatIds = new Set(["42"]);
    bridge.ownerVerified = true;
    await bridge.handleUpdate({
      update_id: 991,
      message: { chat: { id: 42 }, from: { first_name: "Peter" }, text: "hello" },
    }, "TESTTOKEN");
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "tg-42",
      deliveryId: "update:991",
    }));
  });

  it.each([true, false])("acknowledges durable reply only with Telegram send result %s", async (delivered) => {
    apiCall.mockResolvedValue({ ok: true });
    dispatchReply.mockResolvedValue(delivered);
    const acknowledgeDelivery = vi.fn().mockResolvedValue(undefined);
    const bridge = new TelegramBridge({
      dataDir: "/nonexistent-telegram-ack-test-dir",
      getToken: () => "TESTTOKEN",
      onMessage: async () => ({ text: "wire", speakable: "raw", acknowledgeDelivery }),
    }) as any;
    bridge.state = "connected";
    bridge.allowedChatIds = new Set(["42"]);
    bridge.ownerVerified = true;
    await bridge.handleUpdate({
      update_id: delivered ? 992 : 993,
      message: { chat: { id: 42 }, from: { first_name: "Peter" }, text: "hello" },
    }, "TESTTOKEN");
    expect(acknowledgeDelivery).toHaveBeenCalledWith(delivered);
  });

  it("redelivers the same Telegram update after a failed transport send", async () => {
    apiCall.mockResolvedValue({ ok: true });
    dispatchReply.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const acknowledgeDelivery = vi.fn().mockResolvedValue(undefined);
    const onMessage = vi.fn().mockResolvedValue({ text: "wire", speakable: "raw", acknowledgeDelivery });
    const bridge = new TelegramBridge({
      dataDir: "/nonexistent-telegram-redelivery-test-dir", getToken: () => "TESTTOKEN", onMessage,
    }) as any;
    bridge.state = "connected";
    bridge.allowedChatIds = new Set(["42"]);
    bridge.ownerVerified = true;
    const update = { update_id: 994, message: { chat: { id: 42 }, from: { first_name: "Peter" }, text: "hello" } };
    await bridge.handleUpdate(update, "TESTTOKEN");
    await bridge.handleUpdate(update, "TESTTOKEN");
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(acknowledgeDelivery.mock.calls).toEqual([[false], [true]]);
    expect(onMessage.mock.calls[0][0].deliveryFingerprint).toBe(onMessage.mock.calls[1][0].deliveryFingerprint);
  });

  it("keeps a failed steering acknowledgement pending for durable retry", async () => {
    apiCall.mockResolvedValue({ ok: true });
    dispatchReply.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const acknowledgeDelivery = vi.fn().mockResolvedValue(undefined);
    const onMessage = vi.fn().mockResolvedValue({ text: "steered", speakable: "steered", acknowledgeDelivery });
    const bridge = new TelegramBridge({
      dataDir: "/nonexistent-telegram-steer-test-dir", getToken: () => "TESTTOKEN", onMessage,
    }) as any;
    bridge.state = "connected";
    bridge.allowedChatIds = new Set(["42"]);
    bridge.ownerVerified = true;
    bridge.processingLock.add("42");
    const update = { update_id: 995, message: { chat: { id: 42 }, from: { first_name: "Peter" }, text: "make it blue" } };
    await expect(bridge.handleUpdate(update, "TESTTOKEN")).resolves.toBe(false);
    await expect(bridge.handleUpdate(update, "TESTTOKEN")).resolves.toBe(true);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ intent: "steer", deliveryId: "update:995" }));
    expect(acknowledgeDelivery.mock.calls).toEqual([[false], [true]]);
  });

  it.each([
    ["/st\u200Bop", "/stop"], ["/ca\u202Encel", "/cancel"], ["/st\u2028op", "/stop"],
    ["/ca\u2029ncel", "/cancel"], ["/st\u202Fop", "/stop"], ["/st\u200Cop", "/stop"],
    ["/ca\u200Dncel", "/cancel"],
  ])(
    "routes hidden-format control %s before active-turn steering",
    async (text, command) => {
      apiCall.mockResolvedValue({ ok: true });
      dispatchReply.mockResolvedValue(true);
      const onMessage = vi.fn().mockResolvedValue({ text: "stopped", speakable: "stopped" });
      const bridge = new TelegramBridge({
        dataDir: "/nonexistent-telegram-control-test-dir", getToken: () => "TESTTOKEN", onMessage,
      }) as any;
      bridge.state = "connected";
      bridge.allowedChatIds = new Set(["42"]);
      bridge.ownerVerified = true;
      bridge.processingLock.add("42");

      await bridge.handleUpdate({
        update_id: 996,
        message: { chat: { id: 42 }, from: { first_name: "Peter" }, text },
      }, "TESTTOKEN");

      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: command,
        deliveryId: "update:996", deliveryTarget: "42",
      }));
      expect(onMessage.mock.calls[0][0]).not.toHaveProperty("intent");
    },
  );

  it("preserves legitimate Unicode formatting in ordinary active-turn steering", async () => {
    apiCall.mockResolvedValue({ ok: true });
    const text = "line one\u2028line two\u2029paragraph\u202Fspace\u200Cjoin\u200D";
    const onMessage = vi.fn().mockResolvedValue(null);
    const bridge = new TelegramBridge({
      dataDir: "/nonexistent-telegram-unicode-test-dir", getToken: () => "TESTTOKEN", onMessage,
    }) as any;
    bridge.state = "connected";
    bridge.allowedChatIds = new Set(["42"]);
    bridge.ownerVerified = true;
    bridge.processingLock.add("42");

    await bridge.handleUpdate({
      update_id: 997,
      message: { chat: { id: 42 }, from: { first_name: "Peter" }, text },
    }, "TESTTOKEN");

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text, intent: "steer" }));
  });

  it("does not reinterpret a sentence containing a hidden-format control word as a command", async () => {
    apiCall.mockResolvedValue({ ok: true });
    const text = "please /st\u200Bop after this step";
    const onMessage = vi.fn().mockResolvedValue(null);
    const bridge = new TelegramBridge({
      dataDir: "/nonexistent-telegram-exact-control-test-dir", getToken: () => "TESTTOKEN", onMessage,
    }) as any;
    bridge.state = "connected";
    bridge.allowedChatIds = new Set(["42"]);
    bridge.ownerVerified = true;
    bridge.processingLock.add("42");

    await bridge.handleUpdate({
      update_id: 998,
      message: { chat: { id: 42 }, from: { first_name: "Peter" }, text },
    }, "TESTTOKEN");

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text, intent: "steer" }));
  });

  it("does not discard queued updates when reconnecting after a crash", async () => {
    apiCall.mockImplementation(async (_token, method) => method === "getMe"
      ? { ok: true, result: { id: 1, is_bot: true, first_name: "LAX", username: "lax" } }
      : { ok: false, error_code: 401, description: "test terminal" });
    const bridge = new TelegramBridge({
      dataDir: "/nonexistent-telegram-reconnect-test-dir",
      getToken: () => "TESTTOKEN",
      onMessage: async () => null,
    });
    await bridge.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.disconnect();
    expect(apiCall.mock.calls.some((call) => call[1] === "getUpdates" && call[2]?.offset === -1)).toBe(false);
  });
});
