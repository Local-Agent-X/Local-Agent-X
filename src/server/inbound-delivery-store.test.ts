import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "lax-inbound-delivery-"));
process.env.LAX_DATA_DIR = dataDir;
const store = await import("./inbound-delivery-store.js");

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("durable inbound delivery claims", () => {
  it("suppresses duplicate and concurrent delivery while the exact owner is alive", () => {
    const input = { channel: "telegram" as const, deliveryId: "update:44", sessionId: "tg-7", text: "hello" };
    const first = store.claimInboundDelivery(input);
    expect(first.acquired).toBe(true);
    expect(store.claimInboundDelivery(input)).toEqual({ acquired: false, reason: "duplicate" });
  });

  it("fences stale generations and makes completion durable", () => {
    const input = { channel: "whatsapp" as const, deliveryId: "message:abc", sessionId: "wa-9", text: "build it" };
    const first = store.claimInboundDelivery(input);
    expect(first.acquired).toBe(true);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("gone") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    const replacement = store.claimInboundDelivery(input);
    kill.mockRestore();
    expect(replacement.acquired).toBe(true);
    if (!first.acquired || !replacement.acquired) throw new Error("claims expected");
    expect(store.completeInboundDelivery(first.claim)).toBe(false);
    expect(store.bindInboundOperation(replacement.claim, "op-chat-1")).toBe(true);
    expect(store.completeInboundDelivery(replacement.claim)).toBe(true);
    expect(store.claimInboundDelivery(input)).toEqual({ acquired: false, reason: "duplicate" });
  });

  it("never re-executes a delivery after its canonical operation was admitted", () => {
    const input = { channel: "telegram" as const, deliveryId: "update:bound", sessionId: "tg-8", text: "act once" };
    const first = store.claimInboundDelivery(input);
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("claim expected");
    expect(store.bindInboundOperation(first.claim, "op-chat-bound")).toBe(true);

    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("gone") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    expect(store.claimInboundDelivery(input)).toEqual({ acquired: false, reason: "duplicate" });
    kill.mockRestore();
  });

  it("does not alias channel identities or accept changed payload bytes", () => {
    const telegram = { channel: "telegram" as const, deliveryId: "same", sessionId: "tg-1", text: "one" };
    expect(store.claimInboundDelivery(telegram).acquired).toBe(true);
    expect(store.claimInboundDelivery({ ...telegram, text: "two" })).toEqual({ acquired: false, reason: "collision" });
    expect(store.claimInboundDelivery({ channel: "whatsapp", deliveryId: "same", sessionId: "wa-1", text: "one" }).acquired).toBe(true);
  });
});
