import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { computeDurableRecordMac, verifyDurableRecordMac } from "../app-runtime/audit-signing.js";
import { ensureDurableDirectory, fsyncDirectory } from "../persistence/durable-directory.js";
import { opDir } from "../ops/event-log.js";
import { readOp, tryWithOpLock } from "../ops/op-store.js";
import { readCanonicalEvents } from "./store.js";
import {
  processClaimMatches,
  readProcessExecutionClaim,
  type ExecutionOwnerClaim,
} from "./process-execution-claim.js";
import {
  createRelayGeneration,
  createRelayRecord,
  stableStringify,
  verifyRelayGeneration,
  verifyRelayRecord,
  type ProcessRelayKind,
  type ProcessRelayNotice,
  type ProcessRelayRecord,
  type ProcessRelayTarget,
  type SealedProcessRelayGeneration,
} from "./process-relay-contract.js";

const ACK_DOMAIN = "canonical-process-relay-ack-v1";

interface RelayAckState {
  schemaVersion: 1;
  generationId: string;
  acknowledgements: Record<string, ProcessRelayTarget[]>;
}

interface SealedRelayAckState { state: RelayAckState; mac: string }

export interface ProcessRelayGenerationState {
  sealedGeneration: SealedProcessRelayGeneration;
  records: ProcessRelayRecord[];
  acknowledgements: Map<number, Set<ProcessRelayTarget>>;
  journalPath: string;
  ackPath: string;
}

function relayDirectory(opId: string): string {
  if (!/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/.test(opId)) throw new Error("invalid process relay operation id");
  return join(opDir(opId), "process-relay");
}
function journalPath(opId: string, generationId: string): string {
  return join(relayDirectory(opId), `${generationId}.jsonl`);
}
function ackPath(opId: string, generationId: string): string {
  return join(relayDirectory(opId), `${generationId}.ack.json`);
}

export function initializeProcessRelayJournal(
  claim: ExecutionOwnerClaim,
  sessionId: string,
): SealedProcessRelayGeneration {
  return withOpLock(claim.opId, () => {
    assertCurrentGeneration(claim, sessionId);
    const sealed = createRelayGeneration(claim, sessionId);
    const path = journalPath(claim.opId, sealed.generation.generationId);
    if (existsSync(path)) {
      repairRelayCrashArtifacts(claim.opId, dirname(path));
      return readGeneration(path).sealedGeneration;
    }
    ensureDurableDirectory(dirname(path));
    writeAtomic(path, `${JSON.stringify(sealed)}\n`);
    writeAckState(ackPath(claim.opId, sealed.generation.generationId), {
      schemaVersion: 1,
      generationId: sealed.generation.generationId,
      acknowledgements: {},
    });
    return sealed;
  });
}

export function appendProcessRelayRecord(
  claim: ExecutionOwnerClaim,
  sessionId: string,
  kind: ProcessRelayKind,
  payload: unknown,
): ProcessRelayNotice {
  return withOpLock(claim.opId, () => {
    assertCurrentGeneration(claim, sessionId);
    const expected = createRelayGeneration(claim, sessionId);
    const path = journalPath(claim.opId, expected.generation.generationId);
    if (!existsSync(path)) throw new Error("process relay journal was not initialized");
    const state = readGeneration(path);
    if (!sameGenerationIdentity(state.sealedGeneration.generation, expected.generation)) {
      throw new Error("process relay generation identity changed");
    }
    const previous = state.records.at(-1)?.mac ?? state.sealedGeneration.mac;
    const record = createRelayRecord(expected.generation, state.records.length + 1, kind, payload, previous);
    appendAndFlush(path, `${JSON.stringify(record)}\n`);
    return {
      type: "process-relay",
      opId: claim.opId,
      generationId: expected.generation.generationId,
      cursor: record.cursor,
    };
  });
}

/** Rebuild only a prior process generation's canonical append-before-relay crash gap. */
export function backfillCanonicalRelayTail(
  claim: ExecutionOwnerClaim,
  sessionId: string,
): ProcessRelayNotice[] {
  const generations = readProcessRelayGenerations(claim.opId);
  if (generations.length < 2) return [];
  const relayedSeqs = generations.flatMap(state => state.records)
    .filter(record => record.kind === "canonical-event")
    .map(record => (record.payload as { seq: number }).seq);
  const lastRelayed = relayedSeqs.length > 0 ? Math.max(...relayedSeqs) : -1;
  return readCanonicalEvents(claim.opId)
    .filter(event => event.seq > lastRelayed)
    .map(event => appendProcessRelayRecord(claim, sessionId, "canonical-event", event));
}

export function readProcessRelayGenerations(opId: string): ProcessRelayGenerationState[] {
  return withOpLock(opId, () => readProcessRelayGenerationsUnlocked(opId));
}

function readProcessRelayGenerationsUnlocked(opId: string): ProcessRelayGenerationState[] {
  const directory = relayDirectory(opId);
  if (!existsSync(directory)) return [];
  repairRelayCrashArtifacts(opId, directory);
  const names = readdirSync(directory);
  if (names.some(name => !/^[a-f0-9]{64}(?:\.jsonl|\.ack\.json)$/.test(name))) {
    throw new Error("unexpected process relay journal entry");
  }
  const states = names
    .filter(name => /^[a-f0-9]{64}\.jsonl$/.test(name))
    .map(name => readGeneration(join(directory, name)));
  const expectedNames = new Set(states.flatMap(state => [
    `${state.sealedGeneration.generation.generationId}.jsonl`,
    `${state.sealedGeneration.generation.generationId}.ack.json`,
  ]));
  if (names.some(name => !expectedNames.has(name)) || names.length !== expectedNames.size) {
    throw new Error("unpaired process relay journal entry");
  }
  states.sort((left, right) => left.sealedGeneration.generation.placementRevision
    - right.sealedGeneration.generation.placementRevision
    || Date.parse(left.sealedGeneration.generation.createdAt)
    - Date.parse(right.sealedGeneration.generation.createdAt)
    || left.sealedGeneration.generation.generationId.localeCompare(right.sealedGeneration.generation.generationId));
  const op = readOp(opId);
  const sessionId = op?.canonical?.sessionId;
  if (!op || !sessionId || states.some(state => state.sealedGeneration.generation.opId !== opId
    || state.sealedGeneration.generation.sessionId !== sessionId)) {
    throw new Error("process relay provenance does not match the operation");
  }
  return states;
}

export function acknowledgeProcessRelayTarget(
  state: ProcessRelayGenerationState,
  cursor: number,
  target: ProcessRelayTarget,
): void {
  withOpLock(state.sealedGeneration.generation.opId, () => {
    const current = readGeneration(state.journalPath);
    if (current.sealedGeneration.generation.generationId
      !== state.sealedGeneration.generation.generationId) {
      throw new Error("process relay acknowledgement generation changed");
    }
    const record = current.records.find(candidate => candidate.cursor === cursor);
    if (!record || !record.targets.includes(target)) throw new Error("invalid process relay acknowledgement");
    const acknowledged = current.acknowledgements.get(cursor) ?? new Set<ProcessRelayTarget>();
    acknowledged.add(target);
    current.acknowledgements.set(cursor, acknowledged);
    writeAckState(current.ackPath, {
      schemaVersion: 1,
      generationId: current.sealedGeneration.generation.generationId,
      acknowledgements: Object.fromEntries([...current.acknowledgements]
        .map(([key, values]) => [String(key), [...values].sort()])),
    });
    state.acknowledgements = current.acknowledgements;
  });
}

export function acknowledgeProcessRelayBrowserDelivery(identity: {
  opId: string; sessionId: string; generationId: string; cursor: number; deliveryId: string;
}): boolean {
  return withOpLock(identity.opId, () => {
    const states = readProcessRelayGenerationsUnlocked(identity.opId);
    const state = states.find(candidate =>
      candidate.sealedGeneration.generation.generationId === identity.generationId);
    const generation = state?.sealedGeneration.generation;
    const record = state?.records.find(candidate => candidate.cursor === identity.cursor);
    if (!state || !generation || generation.sessionId !== identity.sessionId
      || !record || record.deliveryId !== identity.deliveryId
      || !record.targets.includes("browser-render")) {
      return false;
    }
    const acknowledged = state.acknowledgements.get(identity.cursor) ?? new Set<ProcessRelayTarget>();
    if (acknowledged.has("browser-render")) return true;
    acknowledged.add("browser-render");
    state.acknowledgements.set(identity.cursor, acknowledged);
    writeAckState(state.ackPath, {
      schemaVersion: 1,
      generationId: identity.generationId,
      acknowledgements: Object.fromEntries([...state.acknowledgements]
        .map(([key, values]) => [String(key), [...values].sort()])),
    });
    return true;
  });
}

export function withProcessRelayLock<T>(opId: string, fn: () => T): T | undefined {
  const result = tryWithOpLock(opId, fn);
  return result.acquired ? result.value : undefined;
}

export function cleanupCompletedProcessRelay(opId: string): boolean {
  return withOpLock(opId, () => {
    if (readProcessExecutionClaim(opId)) return false;
    const states = readProcessRelayGenerations(opId);
    if (states.some(state => state.records.some(record => {
      const acknowledged = state.acknowledgements.get(record.cursor) ?? new Set();
      return record.targets.some(target => !acknowledged.has(target));
    }))) return false;
    for (const state of states) {
      rmSync(state.journalPath);
      rmSync(state.ackPath);
    }
    const directory = relayDirectory(opId);
    if (existsSync(directory) && readdirSync(directory).length === 0) rmSync(directory, { recursive: true });
    fsyncDirectory(opDir(opId));
    return true;
  });
}

function readGeneration(path: string): ProcessRelayGenerationState {
  const { sealedGeneration, records } = readJournal(path);
  const ack = readAckState(ackPath(sealedGeneration.generation.opId, sealedGeneration.generation.generationId), sealedGeneration.generation.generationId);
  const acknowledgements = new Map<number, Set<ProcessRelayTarget>>();
  for (const [cursorText, targets] of Object.entries(ack.acknowledgements)) {
    if (!/^[1-9]\d*$/.test(cursorText)) throw new Error("process relay acknowledgement is ambiguous");
    const cursor = Number(cursorText);
    const record = records.find(candidate => candidate.cursor === cursor);
    if (!record || !Number.isSafeInteger(cursor) || targets.some(target => !record.targets.includes(target))) {
      throw new Error("process relay acknowledgement is ambiguous");
    }
    acknowledgements.set(cursor, new Set(targets));
  }
  return { sealedGeneration, records, acknowledgements, journalPath: path,
    ackPath: ackPath(sealedGeneration.generation.opId, sealedGeneration.generation.generationId) };
}

function readJournal(path: string): {
  sealedGeneration: SealedProcessRelayGeneration;
  records: ProcessRelayRecord[];
} {
  const raw = readFileSync(path, "utf8");
  if (!raw.endsWith("\n")) throw new Error("partial process relay journal tail");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("empty process relay journal");
  const sealedGeneration = verifyRelayGeneration(JSON.parse(lines[0]));
  if (path !== journalPath(sealedGeneration.generation.opId, sealedGeneration.generation.generationId)) {
    throw new Error("process relay generation path mismatch");
  }
  const records: ProcessRelayRecord[] = [];
  let previousMac = sealedGeneration.mac;
  for (let index = 1; index < lines.length; index++) {
    const record = verifyRelayRecord(JSON.parse(lines[index]), sealedGeneration.generation, index, previousMac);
    records.push(record);
    previousMac = record.mac;
  }
  return { sealedGeneration, records };
}

function repairRelayCrashArtifacts(opId: string, directory: string): void {
  for (const name of readdirSync(directory)) {
    if (/^[a-f0-9]{64}\.(?:jsonl|ack\.json)\.\d+\.[0-9a-f-]+\.tmp$/.test(name)) {
      rmSync(join(directory, name), { force: true });
    }
  }
  for (const name of readdirSync(directory).filter(item => /^[a-f0-9]{64}\.jsonl$/.test(item))) {
    const path = join(directory, name);
    const raw = readFileSync(path, "utf8");
    if (!raw.endsWith("\n")) repairPartialJournalTail(path, raw);
    const journal = readJournal(path);
    if (journal.sealedGeneration.generation.opId !== opId) throw new Error("process relay provenance mismatch");
    const ack = ackPath(opId, journal.sealedGeneration.generation.generationId);
    if (!existsSync(ack)) {
      if (journal.records.length > 0) throw new Error("process relay acknowledgement state is missing");
      writeAckState(ack, {
        schemaVersion: 1,
        generationId: journal.sealedGeneration.generation.generationId,
        acknowledgements: {},
      });
    }
  }
}

function repairPartialJournalTail(path: string, raw: string): void {
  const boundary = raw.lastIndexOf("\n");
  if (boundary < 0) throw new Error("partial process relay journal header");
  const durablePrefix = raw.slice(0, boundary + 1);
  const tail = raw.slice(boundary + 1);
  const prefixLines = durablePrefix.split("\n").filter(Boolean);
  const sealed = verifyRelayGeneration(JSON.parse(prefixLines[0]));
  let previousMac = sealed.mac;
  for (let index = 1; index < prefixLines.length; index++) {
    previousMac = verifyRelayRecord(JSON.parse(prefixLines[index]), sealed.generation, index, previousMac).mac;
  }
  try {
    verifyRelayRecord(JSON.parse(tail), sealed.generation, prefixLines.length, previousMac);
    appendAndFlush(path, "\n");
  } catch {
    truncateSync(path, Buffer.byteLength(durablePrefix));
    const fd = openSync(path, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDirectory(dirname(path));
  }
}

function assertCurrentGeneration(claim: ExecutionOwnerClaim, sessionId: string): void {
  const current = readProcessExecutionClaim(claim.opId);
  const op = readOp(claim.opId);
  const placement = op?.canonical?.executionPlacement;
  if (!current || !processClaimMatches(current, claim) || current.pid !== claim.pid
    || current.processStartedAt !== claim.processStartedAt || op?.canonical?.sessionId !== sessionId
    || placement?.backendId !== claim.backendId || placement.targetId !== claim.targetId
    || placement.revision !== claim.placementRevision || placement.disposition !== "ready") {
    throw new Error("process relay generation is not the verified process owner");
  }
}

function readAckState(path: string, generationId: string): RelayAckState {
  if (!existsSync(path)) throw new Error("process relay acknowledgement state is missing");
  const sealed = JSON.parse(readFileSync(path, "utf8")) as Partial<SealedRelayAckState>;
  const state = sealed.state as Partial<RelayAckState> | undefined;
  if (!state || state.schemaVersion !== 1 || state.generationId !== generationId
    || !state.acknowledgements || typeof state.acknowledgements !== "object"
    || typeof sealed.mac !== "string"
    || !verifyDurableRecordMac(ACK_DOMAIN, stableStringify(state), sealed.mac)) {
    throw new Error("process relay acknowledgement integrity check failed");
  }
  for (const targets of Object.values(state.acknowledgements)) {
    if (!Array.isArray(targets) || new Set(targets).size !== targets.length
      || targets.some(target => target !== "canonical-core" && target !== "session-observer" && target !== "browser-render")) {
      throw new Error("invalid process relay acknowledgement target");
    }
  }
  return state as RelayAckState;
}

function writeAckState(path: string, state: RelayAckState): void {
  const sealed: SealedRelayAckState = {
    state,
    mac: computeDurableRecordMac(ACK_DOMAIN, stableStringify(state)),
  };
  writeAtomic(path, JSON.stringify(sealed));
}

function writeAtomic(path: string, content: string): void {
  ensureDurableDirectory(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}
function appendAndFlush(path: string, content: string): void {
  const fd = openSync(path, "a", 0o600);
  try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}
function withOpLock<T>(opId: string, fn: () => T): T {
  const result = tryWithOpLock(opId, fn);
  if (!result.acquired) throw new Error("process relay operation lock is busy");
  return result.value;
}

function sameGenerationIdentity(
  left: SealedProcessRelayGeneration["generation"],
  right: SealedProcessRelayGeneration["generation"],
): boolean {
  return left.generationId === right.generationId && left.opId === right.opId
    && left.backendId === right.backendId && left.targetId === right.targetId
    && left.placementRevision === right.placementRevision && left.token === right.token
    && left.pid === right.pid && left.processStartedAt === right.processStartedAt
    && left.ownerKind === right.ownerKind && left.containerId === right.containerId
    && left.containerCreatedAt === right.containerCreatedAt && left.imageDigest === right.imageDigest
    && left.sessionId === right.sessionId;
}
