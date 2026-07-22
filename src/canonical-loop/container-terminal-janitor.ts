import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { readOp } from "../ops/op-store.js";
import type { Op } from "../ops/types.js";
import type { DockerExecutionRuntime } from "../sandbox/docker-execution-runtime.js";
import {
  intentMatchesPlacement,
  readContainerLaunchIntent,
  removeContainerLaunchIntent,
  type ContainerLaunchIntent,
} from "./container-launch-intent.js";
import {
  CONTAINER_EXECUTION_BACKEND_ID,
  type ContainerProjectionRecovery,
} from "./container-execution-backend.js";
import {
  createProductionContainerRuntime,
  reopenContainerRuntimeProjection,
} from "./container-runtime-projection.js";
import {
  readProcessExecutionClaim,
  removeProcessExecutionClaim,
} from "./process-execution-claim.js";
import { isTerminalState } from "./terminal-states.js";

export interface TerminalContainerJanitorOptions {
  runtime?: DockerExecutionRuntime;
  projectionRecovery?: ContainerProjectionRecovery;
  listOpIds?: () => string[];
}

export interface TerminalContainerJanitorResult {
  cleaned: string[];
  deferred: string[];
}

export async function reconcileTerminalContainerExecutions(
  options: TerminalContainerJanitorOptions = {},
): Promise<TerminalContainerJanitorResult> {
  const runtime = options.runtime ?? createProductionContainerRuntime();
  const projectionRecovery = options.projectionRecovery ?? reopenContainerRuntimeProjection;
  const result: TerminalContainerJanitorResult = { cleaned: [], deferred: [] };
  let available: boolean | null = null;
  for (const opId of (options.listOpIds ?? listOperationIds)()) {
    let op: Op | null;
    let intent: ContainerLaunchIntent | null;
    try { op = readOp(opId); intent = readContainerLaunchIntent(opId); }
    catch { result.deferred.push(opId); continue; }
    if (!op || !intent || !isTerminalState(op.canonical?.state)) continue;
    if (!ownedByTerminalPlacement(op, intent)) { result.deferred.push(opId); continue; }
    available ??= await runtime.probe();
    if (!available) { result.deferred.push(opId); continue; }
    try {
      await cleanTerminalIntent(op, intent, runtime, projectionRecovery);
      result.cleaned.push(opId);
    } catch {
      result.deferred.push(opId);
    }
  }
  return result;
}

async function cleanTerminalIntent(
  op: Op,
  intent: ContainerLaunchIntent,
  runtime: DockerExecutionRuntime,
  projectionRecovery: ContainerProjectionRecovery,
): Promise<void> {
  const claim = readProcessExecutionClaim(op.id);
  if (claim && (!intent.container || claim.ownerKind !== "container"
    || claim.backendId !== intent.backendId || claim.targetId !== intent.targetId
    || claim.placementRevision !== intent.placementRevision || claim.token !== intent.token
    || claim.containerId !== intent.container.containerId
    || claim.containerCreatedAt !== intent.container.createdAt
    || claim.imageDigest !== intent.container.imageId)) {
    throw new Error("terminal container ownership changed");
  }
  const state = intent.container
    ? await runtime.inspect(intent.container.containerId)
    : await runtime.inspectNamed(intent.name, ownershipLabels(intent));
  if (state) {
    if (state.imageId !== intent.imageId || (intent.container
      && (state.containerId !== intent.container.containerId
      || state.createdAt !== intent.container.createdAt || state.imageId !== intent.container.imageId))) {
      throw new Error("terminal container identity changed");
    }
    await runtime.stop(state.containerId);
    if (await runtime.inspect(state.containerId)) {
      throw new Error("terminal container removal was not confirmed");
    }
  }
  if (claim && !removeProcessExecutionClaim(claim) && readProcessExecutionClaim(op.id)) {
    throw new Error("terminal container claim changed during cleanup");
  }
  if (intent.projectionId) {
    await (await projectionRecovery(op, intent.projectionId))?.cleanup();
  }
  if (!removeContainerLaunchIntent(intent)) {
    throw new Error("terminal container intent changed during cleanup");
  }
}

function ownershipLabels(intent: ContainerLaunchIntent): Record<string, string> {
  return { "lax.execution.backend": intent.backendId, "lax.execution.op": intent.opId,
    "lax.execution.revision": String(intent.placementRevision),
    "lax.execution.target": intent.targetId };
}

function ownedByTerminalPlacement(op: Op, intent: ContainerLaunchIntent): boolean {
  const placement = op.canonical?.executionPlacement;
  return !!placement && placement.backendId === CONTAINER_EXECUTION_BACKEND_ID
    && intent.backendId === CONTAINER_EXECUTION_BACKEND_ID
    && intentMatchesPlacement(intent, placement, intent.imageReference, intent.imageId);
}

function listOperationIds(): string[] {
  const root = join(getLaxDir(), "operations");
  return existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name) : [];
}
