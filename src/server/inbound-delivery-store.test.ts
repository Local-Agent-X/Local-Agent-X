import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "lax-inbound-delivery-"));
process.env.LAX_DATA_DIR = dataDir;
const store = await import("./inbound-delivery-store.js");
const { opDir } = await import("../ops/event-log.js");

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function deadOwner() {
  return vi.spyOn(process, "kill").mockImplementation(() => {
    const error = new Error("gone") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  });
}

describe("durable inbound delivery outbox", () => {
  it.each(["telegram", "whatsapp"] as const)("suppresses a concurrent %s duplicate while execution owns the receipt", (channel) => {
    const input = { channel, deliveryId: `${channel}:44`, sessionId: `${channel}-7`, text: "hello" };
    const first = store.claimInboundDelivery(input);
    expect(first).toMatchObject({ acquired: true, mode: "execute" });
    expect(store.claimInboundDelivery(input)).toEqual({ acquired: false, reason: "in_progress" });
  });

  it("reclaims only pre-admission work after a dead process and fences its generation", () => {
    const input = { channel: "whatsapp" as const, deliveryId: "message:abc", sessionId: "wa-9", text: "build it" };
    const first = store.claimInboundDelivery(input);
    const kill = deadOwner();
    const replacement = store.claimInboundDelivery(input);
    kill.mockRestore();
    expect(replacement).toMatchObject({ acquired: true, mode: "execute" });
    if (!first.acquired || !replacement.acquired) throw new Error("claims expected");
    expect(store.bindInboundOperation(first.claim, "op-stale")).toBe(false);
    expect(store.bindInboundOperation(replacement.claim, "op-chat-1")).toBe(true);
  });

  it("hands a stale canonical operation to recovery without re-executing it", () => {
    const input = { channel: "telegram" as const, deliveryId: "update:bound", sessionId: "tg-8", text: "act once" };
    const first = store.claimInboundDelivery(input);
    if (!first.acquired) throw new Error("claim expected");
    expect(store.bindInboundOperation(first.claim, "op-chat-bound")).toBe(true);
    const kill = deadOwner();
    expect(store.claimInboundDelivery(input)).toMatchObject({ acquired: true, mode: "recover", opId: "op-chat-bound" });
    kill.mockRestore();
  });

  it("does not mistake a reused live PID for the prior process owner", () => {
    const input = { channel: "telegram" as const, deliveryId: "update:pid", sessionId: "tg-11", text: "hello" };
    expect(store.claimInboundDelivery(input).acquired).toBe(true);
    const digest = createHash("sha256").update(input.channel).update("\0").update(input.deliveryId).digest("hex").slice(0, 40);
    const path = join(opDir(`op_inbound_${digest}`), "inbound-delivery.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...receipt, ownerId: "previous-boot" }));
    expect(store.claimInboundDelivery(input)).toMatchObject({ acquired: true, mode: "execute" });
  });

  it.each(["telegram", "whatsapp"] as const)("replays an unsent %s reply without a new execution", (channel) => {
    const input = { channel, deliveryId: `${channel}:ready`, sessionId: `${channel}-1`, text: "once" };
    const first = store.claimInboundDelivery(input);
    if (!first.acquired) throw new Error("claim expected");
    expect(store.bindInboundOperation(first.claim, "op-ready")).toBe(true);
    expect(store.markInboundResponseReady(first.claim, { text: "wire", speakable: "raw" })).toBe(true);
    expect(store.claimInboundDelivery(input)).toEqual({ acquired: false, reason: "in_progress" });
    expect(store.acknowledgeInboundDelivery(first.claim, false)).toBe(true);
    const replay = store.claimInboundDelivery(input);
    expect(replay).toMatchObject({ acquired: true, mode: "replay", reply: { text: "wire", speakable: "raw" } });
    if (!replay.acquired) throw new Error("replay expected");
    expect(store.acknowledgeInboundDelivery(replay.claim, true)).toBe(true);
    expect(store.claimInboundDelivery(input)).toEqual({ acquired: false, reason: "delivered_duplicate" });
  });

  it.each(["telegram", "whatsapp"] as const)("recovers a response-ready %s send lease after process death", (channel) => {
    const input = { channel, deliveryId: `${channel}:crash`, sessionId: `${channel}-9`, text: "reply" };
    const first = store.claimInboundDelivery(input);
    if (!first.acquired) throw new Error("claim expected");
    store.markInboundResponseReady(first.claim, { text: "durable", speakable: "durable" });
    const kill = deadOwner();
    expect(store.claimInboundDelivery(input)).toMatchObject({ acquired: true, mode: "replay" });
    kill.mockRestore();
  });

  it("discovers a persisted WhatsApp envelope for startup recovery", () => {
    const request = {
      from: "1555", name: "Peter", text: "resume", sessionId: "wa-restart",
      deliveryId: "message:startup", deliveryFingerprint: "stable-bytes",
    };
    const first = store.claimInboundDelivery({
      channel: "whatsapp", deliveryId: request.deliveryId,
      sessionId: request.sessionId, text: request.deliveryFingerprint, request,
    });
    if (!first.acquired) throw new Error("claim expected");
    store.markInboundResponseReady(first.claim, { text: "saved", speakable: "saved" });
    store.acknowledgeInboundDelivery(first.claim, false);

    expect(store.listRecoverableInboundRequests("whatsapp")).toContainEqual(request);
    expect(store.listRecoverableInboundRequests("telegram")).not.toContainEqual(request);
  });

  it("checkpoints multipart transport progress across a reply replay", () => {
    const input = { channel: "telegram" as const, deliveryId: "update:parts", sessionId: "tg-parts", text: "reply" };
    const first = store.claimInboundDelivery(input);
    if (!first.acquired) throw new Error("claim expected");
    store.markInboundResponseReady(first.claim, { text: "two parts", speakable: "two parts" });
    expect(store.markInboundDeliveryPart(first.claim, "text:0")).toBe(true);
    expect(store.hasInboundDeliveryPart(first.claim, "text:0")).toBe(true);
    store.acknowledgeInboundDelivery(first.claim, false);
    const replay = store.claimInboundDelivery(input);
    if (!replay.acquired) throw new Error("replay expected");
    expect(store.hasInboundDeliveryPart(replay.claim, "text:0")).toBe(true);
    expect(store.hasInboundDeliveryPart(replay.claim, "text:1")).toBe(false);
  });

  it("preserves the selected voice fallback payload across a reply replay", () => {
    const input = { channel: "whatsapp" as const, deliveryId: "message:voice-plan", sessionId: "wa-voice", text: "voice" };
    const first = store.claimInboundDelivery(input);
    if (!first.acquired) throw new Error("claim expected");
    store.markInboundResponseReady(first.claim, { text: "wire", speakable: "raw" });
    const plan = { mode: "fallback" as const, fallbackText: "wire\n\n--- stable hint" };
    expect(store.writeInboundDeliveryPlan(first.claim, plan)).toBe(true);
    expect(store.readInboundDeliveryPlan(first.claim)).toEqual(plan);
    store.acknowledgeInboundDelivery(first.claim, false);
    const replay = store.claimInboundDelivery(input);
    if (!replay.acquired) throw new Error("replay expected");
    expect(store.readInboundDeliveryPlan(replay.claim)).toEqual(plan);
  });

  it("recovers the exact write-ahead command plan after an apply crash", () => {
    const input = { channel: "telegram" as const, deliveryId: "update:plan", sessionId: "tg-plan", text: "/stop" };
    const first = store.claimInboundDelivery(input);
    if (!first.acquired) throw new Error("claim expected");
    const plan = { kind: "stop", targetOpIds: ["op-original"], actor: "telegram-stop" };
    expect(store.prepareInboundCommand(first.claim, plan)).toBe(true);
    expect(store.readInboundCommandPlan({ ...input })).toEqual(plan);
    expect(store.releaseInboundClaim(first.claim)).toBe(true);
    expect(store.claimInboundDelivery(input)).toMatchObject({ acquired: true, mode: "command", plan });
  });

  it("does not alias channel identities or accept changed payload bytes", () => {
    const telegram = { channel: "telegram" as const, deliveryId: "same", sessionId: "tg-1", text: "one" };
    expect(store.claimInboundDelivery(telegram).acquired).toBe(true);
    expect(store.claimInboundDelivery({ ...telegram, text: "two" })).toEqual({ acquired: false, reason: "collision" });
    expect(store.claimInboundDelivery({ channel: "whatsapp", deliveryId: "same", sessionId: "wa-1", text: "one" }).acquired).toBe(true);
  });
});
