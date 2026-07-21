import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureDurableDirectory, fsyncDirectory } from "../persistence/durable-directory.js";
import { opDir } from "../ops/event-log.js";
import { tryWithOpLock } from "../ops/op-store.js";

export interface ProcessExecutionClaim {
  schemaVersion: 1;
  opId: string;
  backendId: string;
  targetId: string;
  placementRevision: number;
  token: string;
  pid: number;
  processStartedAt: string;
  heartbeatAt: string;
}

export interface ProcessClaimIdentity {
  opId: string;
  backendId: string;
  targetId: string;
  placementRevision: number;
  token: string;
  pid: number;
  processStartedAt: string;
}

export const PROCESS_EXECUTION_CLAIM_FRESH_MS = 30_000;

export interface ProcessClaimLivenessOptions {
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

function claimPath(opId: string): string {
  return join(opDir(opId), "process-execution.json");
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseProcessExecutionClaim(value: unknown): ProcessExecutionClaim {
  const claim = value as Partial<ProcessExecutionClaim> | null;
  if (!claim || claim.schemaVersion !== 1
    || typeof claim.opId !== "string" || !claim.opId
    || typeof claim.backendId !== "string" || !claim.backendId
    || typeof claim.targetId !== "string" || !claim.targetId
    || !Number.isSafeInteger(claim.placementRevision) || (claim.placementRevision as number) < 1
    || typeof claim.token !== "string" || !claim.token
    || !Number.isSafeInteger(claim.pid) || (claim.pid as number) < 1
    || !canonicalIso(claim.processStartedAt)
    || !canonicalIso(claim.heartbeatAt)) {
    throw new Error("ambiguous process execution claim");
  }
  return claim as ProcessExecutionClaim;
}

export function readProcessExecutionClaim(opId: string): ProcessExecutionClaim | null {
  const path = claimPath(opId);
  if (!existsSync(path)) return null;
  return parseProcessExecutionClaim(JSON.parse(readFileSync(path, "utf8")));
}

export function isLiveProcessExecutionClaim(
  claim: ProcessExecutionClaim,
  options: ProcessClaimLivenessOptions = {},
): boolean {
  const now = options.now ?? Date.now;
  const pidAlive = options.isPidAlive ?? isPidAlive;
  return now() - Date.parse(claim.heartbeatAt) <= PROCESS_EXECUTION_CLAIM_FRESH_MS
    && pidAlive(claim.pid);
}

export function checkProcessExecutionRecoveryOwnership(
  opId: string,
  cleanupStale = false,
): "live" | "clear" | "changed" {
  const claim = readProcessExecutionClaim(opId);
  if (!claim) return "clear";
  if (isLiveProcessExecutionClaim(claim)) return "live";
  if (!cleanupStale) return "clear";
  return removeProcessExecutionClaim(claim) ? "clear" : "changed";
}

function writeProcessExecutionClaim(claim: ProcessExecutionClaim): void {
  const path = claimPath(claim.opId);
  ensureDurableDirectory(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(claim), "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}

export function claimProcessExecution(claim: ProcessExecutionClaim): boolean {
  const result = tryWithOpLock(claim.opId, () => {
    if (readProcessExecutionClaim(claim.opId)) return false;
    writeProcessExecutionClaim(claim);
    return true;
  });
  return result.acquired && result.value;
}

export function heartbeatProcessExecutionClaim(
  expected: ProcessClaimIdentity,
  heartbeatAt: string,
): boolean {
  if (!canonicalIso(heartbeatAt)) return false;
  const result = tryWithOpLock(expected.opId, () => {
    const current = readProcessExecutionClaim(expected.opId);
    if (!current || !processClaimMatches(current, expected)) return false;
    writeProcessExecutionClaim({ ...current, heartbeatAt });
    return true;
  });
  return result.acquired && result.value;
}

export function removeProcessExecutionClaim(expected: ProcessClaimIdentity): boolean {
  const path = claimPath(expected.opId);
  const result = tryWithOpLock(expected.opId, () => {
    const current = readProcessExecutionClaim(expected.opId);
    if (!current || !processClaimMatches(current, expected)) return false;
    rmSync(path);
    fsyncDirectory(dirname(path));
    return true;
  });
  return result.acquired && result.value;
}

export function processClaimMatches(
  claim: ProcessExecutionClaim,
  expected: ProcessClaimIdentity,
): boolean {
  return claim.opId === expected.opId
    && claim.backendId === expected.backendId
    && claim.targetId === expected.targetId
    && claim.placementRevision === expected.placementRevision
    && claim.token === expected.token
    && claim.pid === expected.pid
    && claim.processStartedAt === expected.processStartedAt;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
