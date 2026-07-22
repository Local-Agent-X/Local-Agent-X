import { readFileSync } from "node:fs";
import { claimProcessExecution, type ContainerExecutionClaim } from "./process-execution-claim.js";
import { runClaimedExecutionWorker } from "./execution-worker-runtime.js";
import { restoreProjectedLocalRuntime } from "../local-runtimes/index.js";
import { verifyContainerBootstrap, type ContainerBootstrap } from "./container-bootstrap.js";

const bootstrapPath = required("LAX_CONTAINER_BOOTSTRAP");
let bootstrap: ContainerBootstrap;
try {
  bootstrap = verifyContainerBootstrap(JSON.parse(readFileSync(bootstrapPath, "utf8")));
  const localRuntime = process.env.LAX_PROJECTED_LOCAL_RUNTIME_FILE;
  if (localRuntime) restoreProjectedLocalRuntime(localRuntime);
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

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
