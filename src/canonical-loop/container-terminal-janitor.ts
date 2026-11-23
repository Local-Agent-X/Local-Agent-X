import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { readOp } from "../ops/op-store.js";
import type { Op } from "../ops/types.js";
import type { DockerExecutionRuntime } from "../sandbox/docker-execution-runtime.js";
import {
  containerOwnershipLabels,
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
  /** Test seam: how an op is read. */
  readOp?: (opId: string) => Op | null;
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
    // The launch record first: an op that never ran in a container has none,
    // and that is nearly every op. Reading each op to learn so parsed the whole
    // store on every pass.
    try {
      intent = readContainerLaunchIntent(opId);
      if (!intent) continue;
      op = (options.readOp ?? readOp)(opId);
    } catch { result.deferred.push(opId); continue; }
    if (!op || !isTerminalState(op.canonical?.state)) continue;
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
    : await runtime.inspectNamed(intent.name, containerOwnershipLabels(intent))
      ?? await runtime.fenceCreateName({ name: intent.name,
        image: await runtime.resolvePinnedImage(intent.imageReference),
        labels: containerOwnershipLabels(intent) });
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
