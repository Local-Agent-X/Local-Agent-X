import { readFileSync } from "node:fs";
import { claimProcessExecution, type ContainerExecutionClaim } from "./process-execution-claim.js";
import { runClaimedExecutionWorker } from "./execution-worker-runtime.js";

interface ContainerBootstrap {
  schemaVersion: 1;
  opId: string;
  backendId: string;
  targetId: string;
  placementRevision: number;
  token: string;
  containerId: string;
  containerCreatedAt: string;
  imageDigest: string;
}

const bootstrapPath = required("LAX_CONTAINER_BOOTSTRAP");
let bootstrap: ContainerBootstrap;
try {
  bootstrap = parseBootstrap(JSON.parse(readFileSync(bootstrapPath, "utf8")));
} catch {
  process.exit(2);
}

const now = new Date().toISOString();
const claim: ContainerExecutionClaim = {
  schemaVersion: 1,
  opId: bootstrap.opId,
  backendId: bootstrap.backendId,
  targetId: bootstrap.targetId,
  placementRevision: bootstrap.placementRevision,
  token: bootstrap.token,
  pid: process.pid,
  processStartedAt: now,
  heartbeatAt: now,
  ownerKind: "container",
  containerId: bootstrap.containerId,
  containerCreatedAt: bootstrap.containerCreatedAt,
  imageDigest: bootstrap.imageDigest,
};

if (!claimProcessExecution(claim)) process.exit(3);
try {
  await runClaimedExecutionWorker(claim, () => {}, () => process.exit(6));
  process.exit(0);
} catch {
  process.exit(8);
}

function parseBootstrap(value: unknown): ContainerBootstrap {
  const b = value as Partial<ContainerBootstrap> | null;
  if (!b || b.schemaVersion !== 1 || !nonEmpty(b.opId) || !nonEmpty(b.backendId)
    || !nonEmpty(b.targetId) || !Number.isSafeInteger(b.placementRevision) || (b.placementRevision as number) < 1
    || !nonEmpty(b.token) || typeof b.containerId !== "string" || !/^[a-f0-9]{64}$/.test(b.containerId)
    || !canonicalIso(b.containerCreatedAt) || typeof b.imageDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(b.imageDigest)) throw new Error("invalid container bootstrap");
  return b as ContainerBootstrap;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
