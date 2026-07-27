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

/**
 * Tri-state owner evidence. The liveness question splits by what the caller
 * wants to do, and the two takeover-adjacent answers must come from EVIDENCE,
 * not from silence:
 *
 *   "alive"   — existence verified AND the heartbeat is fresh. Safe to
 *               re-attach.
 *   "dead"    — the pid/container is verifiably gone (existence is the proof;
 *               recency is irrelevant), or the heartbeat is stale past the
 *               ten-minute ceiling below. Safe to take over.
 *   "unknown" — the owner still EXISTS but its heartbeat is stale: a starved
 *               worker looks exactly like this. Neither re-attach nor takeover
 *               may act on it — takeover would double-drive an op whose owner
 *               is still executing (the 2026-07-25 lease-death class).
 *
 * The ceiling exists because pid reuse makes process existence unverifiable at
 * long horizons: a recycled pid would otherwise hold an op in "unknown"
 * forever. Ten minutes mirrors MAX_LEASE_DURATION_MS — the longest the lease
 * system itself lets a silent owner run.
 */
export type OwnerEvidence = "alive" | "dead" | "unknown";
export const STALE_OWNER_DEAD_CEILING_MS = 600_000;

export function ownerEvidence(
  claim: ExecutionOwnerClaim,
  options: ProcessClaimLivenessOptions = {},
): OwnerEvidence {
  const now = options.now ?? Date.now;
  const age = now() - Date.parse(claim.heartbeatAt);
  const fresh = age >= -FUTURE_HEARTBEAT_SKEW_MS && age <= PROCESS_EXECUTION_CLAIM_FRESH_MS;
  let exists: boolean;
  if (claim.ownerKind === "container") {
    const inspection = options.isContainerAlive
      ? (options.isContainerAlive(claim) ? "live" : "dead")
      : options.inspectContainer?.(claim) ?? "unavailable";
    exists = inspection === "live";
  } else {
    exists = (options.isPidAlive ?? isPidAlive)(claim.pid);
  }
  if (!exists) return "dead";
  if (fresh) return "alive";
  if (age > STALE_OWNER_DEAD_CEILING_MS) return "dead";
  return "unknown";
}

export function isLiveProcessExecutionClaim(
  claim: ExecutionOwnerClaim,
  options: ProcessClaimLivenessOptions = {},
): boolean {
  return ownerEvidence(claim, options) === "alive";
}

export function checkProcessExecutionRecoveryOwnership(
  opId: string,
  cleanupStale = false,
  options: ProcessClaimLivenessOptions = {},
): "live" | "clear" | "changed" {
  const claim = readProcessExecutionClaim(opId);
  if (!claim) return "clear";
  const evidence = ownerEvidence(claim, options);
  if (evidence === "alive") return "live";
  // A stale-but-existing PROCESS owner is starved, not dead — its pid is
  // verifiably alive and cannot be fenced, so a takeover here would leave two
  // owners driving one op. Report "live" (leave alone; retry later). Containers
  // deliberately fall through: their takeover path fences via stopContainer,
  // which makes reclaiming a stale-but-running container safe.
  if (evidence === "unknown" && claim.ownerKind !== "container") return "live";
  if (claim.ownerKind === "container") {
    const inspection = options.inspectContainer?.(claim) ?? "unavailable";
    if (inspection === "changed" || inspection === "unavailable") return "changed";
    if (!cleanupStale) return "clear";
    if (inspection === "live" && (!options.stopContainer || !options.stopContainer(claim))) return "changed";
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
