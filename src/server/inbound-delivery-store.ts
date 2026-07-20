import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { ensureDurableDirectory, fsyncDirectory } from "../persistence/durable-directory.js";
import { opDir } from "../ops/event-log.js";
import { tryWithOpLock } from "../ops/op-store.js";
import type { MessagingChannelId } from "../session/channel-registry.js";

export interface DurableInboundReply {
  text: string;
  speakable: string;
}

export interface DurableInboundDeliveryPlan {
  mode: "text" | "voice" | "fallback";
  fallbackText?: string;
}

interface InboundReceipt {
  schemaVersion: 2;
  channel: MessagingChannelId;
  deliveryId: string;
  sessionId: string;
  messageHash: string;
  generation: number;
  ownerPid: number;
  ownerId: string;
  status: "admitted" | "response_ready" | "delivered";
  claimedAt: number;
  opId?: string;
  reply?: DurableInboundReply;
  request?: PersistedInboundRequest;
  deliveredParts?: string[];
  deliveryPlan?: DurableInboundDeliveryPlan;
  commandPlan?: DurableInboundCommandPlan;
}

export interface DurableInboundCommandPlan {
  kind: string;
  [key: string]: string | string[] | boolean | null;
}

export interface PersistedInboundRequest {
  from: string;
  name: string;
  text: string;
  sessionId: string;
  deliveryId: string;
  deliveryFingerprint?: string;
  deliveryTarget?: string;
  preferVoiceReply?: boolean;
  intent?: "turn" | "steer";
}

export interface InboundDeliveryClaim {
  receiptId: string;
  generation: number;
}

export type InboundClaimResult =
  | { acquired: true; mode: "execute"; claim: InboundDeliveryClaim }
  | { acquired: true; mode: "replay"; claim: InboundDeliveryClaim; reply: DurableInboundReply; opId?: string }
  | { acquired: true; mode: "recover"; claim: InboundDeliveryClaim; opId: string }
  | { acquired: true; mode: "command"; claim: InboundDeliveryClaim; plan: DurableInboundCommandPlan }
  | { acquired: false; reason: "delivered_duplicate" | "in_progress" | "awaiting_recovery" | "collision" | "lock_unavailable" };

const PROCESS_OWNER_ID = randomUUID();

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
    return value.schemaVersion === 2 && value.generation > 0 ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number, ownerId: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    const marker = join(opDir("op_inbound_owners"), `${pid}.owner`);
    return existsSync(marker) && readFileSync(marker, "utf8") === ownerId;
  }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function registerProcessOwner(): void {
  const dir = opDir("op_inbound_owners");
  ensureDurableDirectory(dir);
  const target = join(dir, `${process.pid}.owner`);
  const stage = `${target}.${PROCESS_OWNER_ID}.stage`;
  writeFileSync(stage, PROCESS_OWNER_ID, { mode: 0o600 });
  renameSync(stage, target);
  fsyncDirectory(dir);
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
  request?: PersistedInboundRequest;
}): InboundClaimResult {
  registerProcessOwner();
  const receiptId = receiptIdentity(input.channel, input.deliveryId);
  const expectedHash = messageHash(input.sessionId, input.text);
  const locked = tryWithOpLock(receiptId, () => {
    const prior = readReceipt(receiptId);
    if (prior && (prior.channel !== input.channel || prior.deliveryId !== input.deliveryId
      || prior.sessionId !== input.sessionId || prior.messageHash !== expectedHash)) {
      return { acquired: false as const, reason: "collision" as const };
    }
    if (prior?.status === "delivered") return { acquired: false as const, reason: "delivered_duplicate" as const };
    if (prior && processIsAlive(prior.ownerPid, prior.ownerId)) {
      return { acquired: false as const, reason: "in_progress" as const };
    }
    const generation = (prior?.generation ?? 0) + 1;
    const claim = { receiptId, generation };
    if (prior?.status === "response_ready" && prior.reply) {
      writeReceipt(receiptId, { ...prior, generation, ownerPid: process.pid, ownerId: PROCESS_OWNER_ID, claimedAt: Date.now() });
      return { acquired: true as const, mode: "replay" as const, claim, reply: prior.reply, opId: prior.opId };
    }
    if (prior?.status === "admitted" && prior.opId) {
      writeReceipt(receiptId, { ...prior, generation, ownerPid: process.pid, ownerId: PROCESS_OWNER_ID, claimedAt: Date.now() });
      return { acquired: true as const, mode: "recover" as const, claim, opId: prior.opId };
    }
    if (prior?.status === "admitted" && prior.commandPlan) {
      writeReceipt(receiptId, { ...prior, generation, ownerPid: process.pid, ownerId: PROCESS_OWNER_ID, claimedAt: Date.now() });
      return { acquired: true as const, mode: "command" as const, claim, plan: prior.commandPlan };
    }
    writeReceipt(receiptId, {
      schemaVersion: 2,
      channel: input.channel,
      deliveryId: input.deliveryId,
      sessionId: input.sessionId,
      messageHash: expectedHash,
      generation,
      ownerPid: process.pid,
      ownerId: PROCESS_OWNER_ID,
      status: "admitted",
      claimedAt: Date.now(),
      request: input.request,
    });
    return { acquired: true as const, mode: "execute" as const, claim };
  });
  return locked.acquired ? locked.value : { acquired: false, reason: "lock_unavailable" };
}

export function listRecoverableInboundRequests(channel: MessagingChannelId): PersistedInboundRequest[] {
  registerProcessOwner();
  const base = join(getLaxDir(), "operations");
  if (!existsSync(base)) return [];
  const requests: PersistedInboundRequest[] = [];
  for (const name of readdirSync(base)) {
    if (!name.startsWith("op_inbound_")) continue;
    const receipt = readReceipt(name);
    if (!receipt?.request || receipt.channel !== channel || receipt.status === "delivered") continue;
    if (processIsAlive(receipt.ownerPid, receipt.ownerId)) continue;
    requests.push(receipt.request);
  }
  return requests;
}

export function readInboundCommandPlan(input: {
  channel: MessagingChannelId;
  deliveryId: string;
  sessionId: string;
  text: string;
}): DurableInboundCommandPlan | null {
  const receipt = readReceipt(receiptIdentity(input.channel, input.deliveryId));
  if (!receipt || receipt.channel !== input.channel || receipt.deliveryId !== input.deliveryId
    || receipt.sessionId !== input.sessionId || receipt.messageHash !== messageHash(input.sessionId, input.text)) return null;
  return receipt.commandPlan ?? null;
}

export function bindInboundOperation(claim: InboundDeliveryClaim, opId: string): boolean {
  return updateClaim(claim, (receipt) => ({ ...receipt, opId }));
}

export function prepareInboundCommand(claim: InboundDeliveryClaim, plan: DurableInboundCommandPlan): boolean {
  return updateClaim(claim, receipt => ({ ...receipt, commandPlan: plan }));
}

export function markInboundResponseReady(claim: InboundDeliveryClaim, reply: DurableInboundReply): boolean {
  return updateClaim(claim, (receipt) => ({ ...receipt, status: "response_ready", reply }));
}

export function hasInboundDeliveryPart(claim: InboundDeliveryClaim, part: string): boolean {
  const receipt = readReceipt(claim.receiptId);
  return Boolean(receipt && receipt.generation === claim.generation
    && receipt.ownerPid === process.pid && receipt.ownerId === PROCESS_OWNER_ID
    && receipt.deliveredParts?.includes(part));
}

export function markInboundDeliveryPart(claim: InboundDeliveryClaim, part: string): boolean {
  return updateClaim(claim, receipt => receipt.deliveredParts?.includes(part)
    ? receipt
    : { ...receipt, deliveredParts: [...(receipt.deliveredParts ?? []), part] });
}

export function readInboundDeliveryPlan(claim: InboundDeliveryClaim): DurableInboundDeliveryPlan | undefined {
  const receipt = readReceipt(claim.receiptId);
  if (!receipt || receipt.generation !== claim.generation
    || receipt.ownerPid !== process.pid || receipt.ownerId !== PROCESS_OWNER_ID) return undefined;
  return receipt.deliveryPlan;
}

export function writeInboundDeliveryPlan(claim: InboundDeliveryClaim, plan: DurableInboundDeliveryPlan): boolean {
  return updateClaim(claim, receipt => ({ ...receipt, deliveryPlan: plan }));
}

export function acknowledgeInboundDelivery(claim: InboundDeliveryClaim, delivered: boolean): boolean {
  return updateClaim(claim, (receipt) => delivered
    ? { ...receipt, status: "delivered", ownerPid: 0 }
    : { ...receipt, status: "response_ready", ownerPid: 0 });
}

export function releaseInboundClaim(claim: InboundDeliveryClaim): boolean {
  return updateClaim(claim, (receipt) => ({ ...receipt, ownerPid: 0 }));
}

function updateClaim(
  claim: InboundDeliveryClaim,
  update: (receipt: InboundReceipt) => InboundReceipt,
): boolean {
  const locked = tryWithOpLock(claim.receiptId, () => {
    const receipt = readReceipt(claim.receiptId);
    if (!receipt || receipt.generation !== claim.generation
      || receipt.ownerPid !== process.pid || receipt.ownerId !== PROCESS_OWNER_ID) return false;
    writeReceipt(claim.receiptId, update(receipt));
    return true;
  });
  return locked.acquired && locked.value;
}
