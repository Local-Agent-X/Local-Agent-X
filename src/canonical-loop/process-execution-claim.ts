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
import { spawnSync } from "node:child_process";
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
  ownerKind?: "process";
  containerId?: never;
  containerCreatedAt?: never;
  imageDigest?: never;
}

export interface ContainerExecutionClaim {
  schemaVersion: 1;
  opId: string;
  backendId: string;
  targetId: string;
  placementRevision: number;
  token: string;
  pid: number;
  processStartedAt: string;
  heartbeatAt: string;
  ownerKind: "container";
  containerId: string;
  containerCreatedAt: string;
  imageDigest: string;
}

export type ExecutionOwnerClaim = ProcessExecutionClaim | ContainerExecutionClaim;

export interface ProcessClaimIdentity {
  opId: string;
  backendId: string;
  targetId: string;
  placementRevision: number;
  token: string;
  pid: number;
  processStartedAt: string;
  ownerKind?: "process" | "container";
  containerId?: string;
  containerCreatedAt?: string;
  imageDigest?: string;
}

export const PROCESS_EXECUTION_CLAIM_FRESH_MS = 30_000;

export interface ProcessClaimLivenessOptions {
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  isContainerAlive?: (claim: ContainerExecutionClaim) => boolean;
  inspectContainer?: (claim: ContainerExecutionClaim) => ContainerClaimInspection;
  stopContainer?: (claim: ContainerExecutionClaim) => boolean;
}

export type ContainerClaimInspection = "live" | "dead" | "changed" | "unavailable";
const FUTURE_HEARTBEAT_SKEW_MS = 5_000;

function claimPath(opId: string): string {
  return join(opDir(opId), "process-execution.json");
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseProcessExecutionClaim(value: unknown): ExecutionOwnerClaim {
  const claim = value as Partial<ExecutionOwnerClaim> | null;
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
  if (claim.ownerKind === "container") {
    if (typeof claim.containerId !== "string" || !/^[a-f0-9]{64}$/.test(claim.containerId)
      || !canonicalIso(claim.containerCreatedAt)
      || typeof claim.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(claim.imageDigest)) {
      throw new Error("ambiguous container execution claim");
    }
  } else if ((claim.ownerKind !== undefined && claim.ownerKind !== "process") || claim.containerId !== undefined
    || claim.containerCreatedAt !== undefined || claim.imageDigest !== undefined) {
    throw new Error("ambiguous process execution claim owner");
  }
  return claim as ExecutionOwnerClaim;
}

export function readProcessExecutionClaim(opId: string): ExecutionOwnerClaim | null {
  const path = claimPath(opId);
  if (!existsSync(path)) return null;
  return parseProcessExecutionClaim(JSON.parse(readFileSync(path, "utf8")));
}

export function isLiveProcessExecutionClaim(
  claim: ExecutionOwnerClaim,
  options: ProcessClaimLivenessOptions = {},
): boolean {
  const now = options.now ?? Date.now;
  const age = now() - Date.parse(claim.heartbeatAt);
  const fresh = age >= -FUTURE_HEARTBEAT_SKEW_MS && age <= PROCESS_EXECUTION_CLAIM_FRESH_MS;
  if (!fresh) return false;
  if (claim.ownerKind === "container") {
    const inspection = options.isContainerAlive
      ? (options.isContainerAlive(claim) ? "live" : "dead")
      : (options.inspectContainer ?? inspectContainerClaim)(claim);
    return inspection === "live";
  }
  return (options.isPidAlive ?? isPidAlive)(claim.pid);
}

export function checkProcessExecutionRecoveryOwnership(
  opId: string,
  cleanupStale = false,
  options: ProcessClaimLivenessOptions = {},
): "live" | "clear" | "changed" {
  const claim = readProcessExecutionClaim(opId);
  if (!claim) return "clear";
  if (isLiveProcessExecutionClaim(claim, options)) return "live";
  if (claim.ownerKind === "container") {
    const inspection = options.inspectContainer?.(claim) ?? inspectContainerClaim(claim);
    if (inspection === "changed" || inspection === "unavailable") return "changed";
    if (!cleanupStale) return "clear";
    if (inspection === "live" && !(options.stopContainer ?? stopContainerClaim)(claim)) return "changed";
  }
  if (!cleanupStale) return "clear";
  return removeProcessExecutionClaim(claim) ? "clear" : "changed";
}

function writeProcessExecutionClaim(claim: ExecutionOwnerClaim): void {
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

export function claimProcessExecution(claim: ExecutionOwnerClaim): boolean {
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
  claim: ExecutionOwnerClaim,
  expected: ProcessClaimIdentity,
): boolean {
  return claim.opId === expected.opId
    && claim.backendId === expected.backendId
    && claim.targetId === expected.targetId
    && claim.placementRevision === expected.placementRevision
    && claim.token === expected.token
    && claim.pid === expected.pid
    && claim.processStartedAt === expected.processStartedAt
    && (claim.ownerKind ?? "process") === (expected.ownerKind ?? "process")
    && claim.containerId === expected.containerId
    && claim.containerCreatedAt === expected.containerCreatedAt
    && claim.imageDigest === expected.imageDigest;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function inspectContainerClaim(claim: ContainerExecutionClaim): ContainerClaimInspection {
  const result = spawnSync("docker", [
    "container", "inspect", claim.containerId,
    "--format", "{{.Id}}\n{{.Created}}\n{{.Image}}\n{{.State.Running}}",
  ], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  if (result.error) return "unavailable";
  if (result.status !== 0) {
    return /no such (?:object|container)/i.test(result.stderr ?? "") ? "dead" : "unavailable";
  }
  const [id, createdAt, imageId, running] = (result.stdout ?? "").trim().split(/\r?\n/);
  if (id !== claim.containerId || createdAt !== claim.containerCreatedAt || imageId !== claim.imageDigest) {
    return "changed";
  }
  return running === "true" ? "live" : running === "false" ? "dead" : "changed";
}

function stopContainerClaim(claim: ContainerExecutionClaim): boolean {
  if (inspectContainerClaim(claim) !== "live") return false;
  const result = spawnSync("docker", ["rm", "--force", claim.containerId], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  return !result.error && result.status === 0;
}
