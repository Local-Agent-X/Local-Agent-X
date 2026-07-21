import { createHash } from "node:crypto";
import {
  computeDurableRecordMac,
  verifyDurableRecordMac,
} from "../app-runtime/audit-signing.js";
import type { ServerEvent } from "../types.js";
import type { ProcessExecutionClaim } from "./process-execution-claim.js";
import type { CanonicalEvent } from "./types.js";

export const PROCESS_RELAY_SCHEMA_VERSION = 1;
const GENERATION_DOMAIN = "canonical-process-relay-generation-v1";
const RECORD_DOMAIN = "canonical-process-relay-record-v1";

export type ProcessRelayKind = "canonical-event" | "stream-chunk" | "session-event";
export type ProcessRelayTarget = "canonical-core" | "browser-render";

export interface ProcessRelayGeneration {
  schemaVersion: 1;
  generationId: string;
  opId: string;
  backendId: string;
  targetId: string;
  placementRevision: number;
  token: string;
  pid: number;
  processStartedAt: string;
  sessionId: string;
  createdAt: string;
}

export interface SealedProcessRelayGeneration {
  generation: ProcessRelayGeneration;
  mac: string;
}

export interface ProcessRelayRecord {
  schemaVersion: 1;
  generationId: string;
  cursor: number;
  deliveryId: string;
  kind: ProcessRelayKind;
  targets: ProcessRelayTarget[];
  payload: unknown;
  previousMac: string;
  mac: string;
}

export interface ProcessRelayNotice {
  type: "process-relay";
  opId: string;
  generationId: string;
  cursor: number;
}

const SESSION_EVENT_TYPES = new Set<string>([
  "stream", "reasoning", "tool_start", "tool_progress", "tool_end", "usage",
  "done", "stopped", "error", "secret_request", "secrets_request",
  "approval_requested", "approval_timeout", "approval_resolved", "context_status",
  "visual", "bg_op_queued", "bg_op_queue_reordered", "bg_op_started",
  "bg_op_progress", "bg_op_completed", "bg_op_nudge", "av_blocked_warning",
  "worker_stream", "worker_done", "chat_op_started", "inject_queued",
  "inject_consumed", "plan_mode_changed", "tool_chip", "op_heartbeat",
]);
const CANONICAL_EVENT_TYPES = new Set<string>([
  "state_changed", "turn_started", "turn_committed", "iteration_checkpoint",
  "tool_started", "tool_finished", "message_appended", "redirect_received",
  "redirect_applied", "pause_requested", "resume_requested", "approval_requested",
  "approval_resolved", "cancel_requested", "lease_acquired", "lease_lost", "error",
]);

export function createRelayGeneration(
  claim: ProcessExecutionClaim,
  sessionId: string,
  createdAt = new Date().toISOString(),
): SealedProcessRelayGeneration {
  if (!sessionId) throw new Error("process relay session identity is missing");
  const identity = `${claim.opId}\0${claim.backendId}\0${claim.targetId}\0${claim.placementRevision}\0${claim.token}\0${claim.pid}\0${claim.processStartedAt}\0${sessionId}`;
  const generation: ProcessRelayGeneration = {
    schemaVersion: PROCESS_RELAY_SCHEMA_VERSION,
    generationId: createHash("sha256").update(identity).digest("hex"),
    opId: claim.opId,
    backendId: claim.backendId,
    targetId: claim.targetId,
    placementRevision: claim.placementRevision,
    token: claim.token,
    pid: claim.pid,
    processStartedAt: claim.processStartedAt,
    sessionId,
    createdAt,
  };
  return { generation, mac: computeDurableRecordMac(GENERATION_DOMAIN, stableStringify(generation)) };
}

export function verifyRelayGeneration(value: unknown): SealedProcessRelayGeneration {
  const sealed = value as Partial<SealedProcessRelayGeneration> | null;
  const generation = sealed?.generation as Partial<ProcessRelayGeneration> | undefined;
  if (!generation || generation.schemaVersion !== 1 || !isHex(generation.generationId)
    || !nonEmpty(generation.opId) || !nonEmpty(generation.backendId) || !nonEmpty(generation.targetId)
    || !Number.isSafeInteger(generation.placementRevision) || (generation.placementRevision as number) < 1
    || !nonEmpty(generation.token) || !Number.isSafeInteger(generation.pid) || (generation.pid as number) < 1
    || !canonicalIso(generation.processStartedAt) || !nonEmpty(generation.sessionId)
    || !canonicalIso(generation.createdAt) || !nonEmpty(sealed?.mac)
    || !verifyDurableRecordMac(GENERATION_DOMAIN, stableStringify(generation), sealed.mac as string)) {
    throw new Error("process relay generation integrity check failed");
  }
  return sealed as SealedProcessRelayGeneration;
}

export function createRelayRecord(
  generation: ProcessRelayGeneration,
  cursor: number,
  kind: ProcessRelayKind,
  payload: unknown,
  previousMac: string,
): ProcessRelayRecord {
  validateRelayPayload(kind, payload, generation.opId);
  if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error("invalid process relay cursor");
  const targets: ProcessRelayTarget[] = kind === "canonical-event"
    ? ["canonical-core", "browser-render"]
    : ["browser-render"];
  const unsigned = {
    schemaVersion: 1 as const,
    generationId: generation.generationId,
    cursor,
    deliveryId: `${generation.generationId}:${cursor}`,
    kind,
    targets,
    payload,
    previousMac,
  };
  return { ...unsigned, mac: computeDurableRecordMac(RECORD_DOMAIN, stableStringify(unsigned)) };
}

export function verifyRelayRecord(
  value: unknown,
  generation: ProcessRelayGeneration,
  expectedCursor: number,
  previousMac: string,
): ProcessRelayRecord {
  const record = value as Partial<ProcessRelayRecord> | null;
  if (!record || record.schemaVersion !== 1 || record.generationId !== generation.generationId
    || record.cursor !== expectedCursor || record.deliveryId !== `${generation.generationId}:${expectedCursor}`
    || !isRelayKind(record.kind) || record.previousMac !== previousMac || !isHex(record.mac)
    || !Array.isArray(record.targets) || !sameTargets(record.targets, record.kind)) {
    throw new Error("non-contiguous process relay record");
  }
  const { mac, ...unsigned } = record;
  if (!verifyDurableRecordMac(RECORD_DOMAIN, stableStringify(unsigned), mac)) {
    throw new Error("process relay record integrity check failed");
  }
  validateRelayPayload(record.kind, record.payload, generation.opId);
  return record as ProcessRelayRecord;
}

export function validateRelayPayload(kind: ProcessRelayKind, payload: unknown, opId: string): void {
  assertJsonValue(payload, 0);
  if (kind === "canonical-event") {
    const event = payload as Partial<CanonicalEvent> | null;
    if (!event || event.opId !== opId || !Number.isSafeInteger(event.seq)
      || (event.seq as number) < 0 || typeof event.type !== "string"
      || !CANONICAL_EVENT_TYPES.has(event.type) || !canonicalIso(event.ts)) {
      throw new Error("invalid canonical relay payload");
    }
  } else if (kind === "session-event") {
    const type = (payload as Partial<ServerEvent> | null)?.type;
    if (typeof type !== "string" || !SESSION_EVENT_TYPES.has(type)) {
      throw new Error("unsupported process relay session event");
    }
  }
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRelayKind(value: unknown): value is ProcessRelayKind {
  return value === "canonical-event" || value === "stream-chunk" || value === "session-event";
}

function sameTargets(value: unknown[], kind: ProcessRelayKind): boolean {
  const expected = kind === "canonical-event" ? ["canonical-core", "browser-render"] : ["browser-render"];
  return value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function assertJsonValue(value: unknown, depth: number): void {
  if (depth > 24) throw new Error("process relay payload is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertJsonValue(item, depth + 1); return; }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("process relay payload is not plain JSON");
  }
  for (const child of Object.values(value as Record<string, unknown>)) assertJsonValue(child, depth + 1);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isHex(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
