import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensureDurableDirectory, fsyncDirectory } from "../persistence/durable-directory.js";
import { opDir } from "../ops/event-log.js";
import { tryWithOpLock } from "../ops/op-store.js";
import type { MessagingChannelId } from "../session/channel-registry.js";

interface InboundReceipt {
  schemaVersion: 1;
  channel: MessagingChannelId;
  deliveryId: string;
  sessionId: string;
  messageHash: string;
  generation: number;
  ownerPid: number;
  status: "running" | "complete";
  claimedAt: number;
  opId?: string;
}

export interface InboundDeliveryClaim {
  receiptId: string;
  generation: number;
}

export type InboundClaimResult =
  | { acquired: true; claim: InboundDeliveryClaim }
  | { acquired: false; reason: "duplicate" | "collision" | "lock_unavailable" };

function receiptIdentity(channel: MessagingChannelId, deliveryId: string): string {
  const digest = createHash("sha256").update(channel).update("\0").update(deliveryId).digest("hex");
  return `op_inbound_${digest.slice(0, 40)}`;
}

function receiptPath(receiptId: string): string {
  return join(opDir(receiptId), "inbound-delivery.json");
}

function messageHash(sessionId: string, text: string): string {
  return createHash("sha256").update(sessionId).update("\0").update(text).digest("hex");
}

function readReceipt(receiptId: string): InboundReceipt | null {
  const path = receiptPath(receiptId);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as InboundReceipt;
    return value.schemaVersion === 1 && value.generation > 0 ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function writeReceipt(receiptId: string, receipt: InboundReceipt): void {
  const dir = opDir(receiptId);
  ensureDurableDirectory(dir);
  const target = receiptPath(receiptId);
  const stage = `${target}.${process.pid}-${randomUUID()}.stage`;
  let fd: number | null = null;
  try {
    fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const bytes = Buffer.from(JSON.stringify(receipt));
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error("inbound receipt write made no progress");
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(stage, target);
    fsyncDirectory(dir);
  } finally {
    if (fd !== null) try { closeSync(fd); } catch {}
    try { rmSync(stage, { force: true }); } catch {}
  }
}

export function claimInboundDelivery(input: {
  channel: MessagingChannelId;
  deliveryId: string;
  sessionId: string;
  text: string;
}): InboundClaimResult {
  const receiptId = receiptIdentity(input.channel, input.deliveryId);
  const expectedHash = messageHash(input.sessionId, input.text);
  const locked = tryWithOpLock(receiptId, () => {
    const prior = readReceipt(receiptId);
    if (prior && (prior.channel !== input.channel || prior.deliveryId !== input.deliveryId
      || prior.sessionId !== input.sessionId || prior.messageHash !== expectedHash)) {
      return { acquired: false as const, reason: "collision" as const };
    }
    if (prior?.status === "complete" || prior?.opId
      || (prior?.status === "running" && processIsAlive(prior.ownerPid))) {
      return { acquired: false as const, reason: "duplicate" as const };
    }
    const generation = (prior?.generation ?? 0) + 1;
    writeReceipt(receiptId, {
      schemaVersion: 1,
      channel: input.channel,
      deliveryId: input.deliveryId,
      sessionId: input.sessionId,
      messageHash: expectedHash,
      generation,
      ownerPid: process.pid,
      status: "running",
      claimedAt: Date.now(),
      ...(prior?.opId ? { opId: prior.opId } : {}),
    });
    return { acquired: true as const, claim: { receiptId, generation } };
  });
  return locked.acquired ? locked.value : { acquired: false, reason: "lock_unavailable" };
}

export function bindInboundOperation(claim: InboundDeliveryClaim, opId: string): boolean {
  return updateClaim(claim, (receipt) => ({ ...receipt, opId }));
}

export function completeInboundDelivery(claim: InboundDeliveryClaim): boolean {
  return updateClaim(claim, (receipt) => ({ ...receipt, status: "complete" }));
}

function updateClaim(
  claim: InboundDeliveryClaim,
  update: (receipt: InboundReceipt) => InboundReceipt,
): boolean {
  const locked = tryWithOpLock(claim.receiptId, () => {
    const receipt = readReceipt(claim.receiptId);
    if (!receipt || receipt.generation !== claim.generation || receipt.ownerPid !== process.pid) return false;
    writeReceipt(claim.receiptId, update(receipt));
    return true;
  });
  return locked.acquired && locked.value;
}
