/**
 * Telegram ownership.
 *
 * The bot token carries no identity, so an unowned bot must not accept
 * whoever messages it first — that was the auto-lock race removed in
 * 1012df99. But removing the race left NO way to become owner at all
 * (setAllowedChatIds had zero callers), which dead-locked inbound Telegram
 * entirely. Ownership is now claimed through an operator-opened window.
 * These tests lock both halves: closed = default-deny, open = claimable once.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sendMessage = vi.fn();
vi.mock("./api.js", () => ({
  apiCall: vi.fn(async () => ({ ok: true })),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
  sendVoice: vi.fn(), sendPhoto: vi.fn(), sendVideo: vi.fn(),
}));
vi.mock("./inbound.js", () => ({
  describeNonTextMessage: vi.fn(),
  dispatchReply: vi.fn(async () => true),
  transcribeInboundVoice: vi.fn(async () => ""),
}));

import { TelegramBridge } from "./bridge.js";
import { CLAIM_WINDOW_MS, sanitizeChatIds, loadAllowedChats } from "./allowed-chats.js";

let dataDir: string;
const onMessage = vi.fn(async () => null);

function makeBridge(): any {
  const b = new TelegramBridge({ dataDir, getToken: () => "TESTTOKEN", onMessage }) as any;
  b.state = "connected";
  return b;
}

function inbound(chatId: number, text = "hello") {
  return { update_id: 1, message: { chat: { id: chatId }, from: { first_name: "Peter" }, text } };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "tg-owner-"));
  sendMessage.mockReset().mockResolvedValue(true);
  onMessage.mockReset().mockResolvedValue(null);
});
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); vi.useRealTimers(); });

describe("unowned bot", () => {
  it("refuses every message while no claim window is open", async () => {
    const b = makeBridge();
    await b.handleUpdate(inbound(42), "TESTTOKEN");
    expect(onMessage).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][2]).toMatch(/no owner yet/i);
    expect(b.getStatus().allowedChatIds).toEqual([]);
  });

  it("does not auto-lock to the first sender", async () => {
    const b = makeBridge();
    await b.handleUpdate(inbound(42), "TESTTOKEN");
    await b.handleUpdate(inbound(99), "TESTTOKEN");
    expect(b.getStatus().allowedChatIds).toEqual([]);
  });
});

describe("claim window", () => {
  it("locks the bot to the next sender and processes that same message", async () => {
    const b = makeBridge();
    expect(b.openOwnerClaimWindow()).toEqual({ ok: true, msRemaining: CLAIM_WINDOW_MS });

    await b.handleUpdate(inbound(42), "TESTTOKEN");

    expect(b.getStatus().allowedChatIds).toEqual(["42"]);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ from: "42", text: "hello" }));
    expect(sendMessage.mock.calls[0][2]).toMatch(/Locked to your account/);
  });

  it("closes on claim, so a second chat cannot ride the same window", async () => {
    const b = makeBridge();
    b.openOwnerClaimWindow();
    await b.handleUpdate(inbound(42), "TESTTOKEN");
    onMessage.mockClear();

    await b.handleUpdate(inbound(99), "TESTTOKEN");

    expect(b.getStatus().allowedChatIds).toEqual(["42"]);
    expect(onMessage).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.at(-1)![2]).toMatch(/Access denied/);
  });

  it("expires, and an expired window does not grant ownership", async () => {
    vi.useFakeTimers();
    const b = makeBridge();
    b.openOwnerClaimWindow();
    vi.advanceTimersByTime(CLAIM_WINDOW_MS + 1);

    expect(b.getStatus().claimWindowMsRemaining).toBe(0);
    await b.handleUpdate(inbound(42), "TESTTOKEN");
    expect(b.getStatus().allowedChatIds).toEqual([]);
  });

  it("refuses to open while the bot already has an owner", () => {
    const b = makeBridge();
    b.setAllowedChatIds(["42"]);
    const r = b.openOwnerClaimWindow();
    expect(r.ok).toBe(false);
    expect(b.getStatus().claimWindowMsRemaining).toBe(0);
  });
});

describe("owner persistence", () => {
  it("survives a restart", async () => {
    const first = makeBridge();
    first.openOwnerClaimWindow();
    await first.handleUpdate(inbound(42), "TESTTOKEN");

    expect(makeBridge().getStatus().allowedChatIds).toEqual(["42"]);
  });

  it("writes the shape loadAllowedChats reads", async () => {
    const b = makeBridge();
    b.setAllowedChatIds(["-1001234567890"]);
    const cfg = join(dataDir, "telegram-config.json");
    expect(existsSync(cfg)).toBe(true);
    expect(JSON.parse(readFileSync(cfg, "utf-8"))).toEqual({ allowedChatIds: ["-1001234567890"] });
    expect([...loadAllowedChats(dataDir)]).toEqual(["-1001234567890"]);
  });

  it("re-opens claiming after the owner is cleared", async () => {
    const b = makeBridge();
    b.setAllowedChatIds(["42"]);
    expect(b.setAllowedChatIds([])).toEqual([]);
    expect(b.openOwnerClaimWindow().ok).toBe(true);
    await b.handleUpdate(inbound(99), "TESTTOKEN");
    expect(b.getStatus().allowedChatIds).toEqual(["99"]);
  });

  it("a corrupt config leaves the bot unowned rather than crashing the bridge", () => {
    writeFileSync(join(dataDir, "telegram-config.json"), "{ not json");
    expect(makeBridge().getStatus().allowedChatIds).toEqual([]);
  });
});

describe("sanitizeChatIds", () => {
  it("keeps user and group ids, drops anything not a plausible id", () => {
    expect([...sanitizeChatIds(["42", "-1001234567890", " 77 "])]).toEqual(["42", "-1001234567890", "77"]);
    expect([...sanitizeChatIds(["", "abc", "4.2", "0", "-0", "12a", "1e9"])]).toEqual([]);
  });
});
