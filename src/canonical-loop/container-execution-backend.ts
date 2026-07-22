import { createHash, randomUUID } from "node:crypto";
import type { Op } from "../ops/types.js";
import type {
  DockerContainerIdentity,
  DockerContainerSpec,
  DockerExecutionRuntime,
  DockerImageIdentity,
} from "../sandbox/docker-execution-runtime.js";
import { DockerCliExecutionRuntime } from "../sandbox/docker-execution-runtime.js";
import type {
  ExecutionBackend,
  ExecutionBackendStartRequest,
  ExecutionBackendStartWithoutAdapterRequest,
  ExecutionHandle,
} from "./execution-backend.js";
import type { ExecutionPlacement } from "./types.js";
import { notifyProcessRelayParent } from "./process-relay-parent-hook.js";
import {
  isLiveProcessExecutionClaim,
  processClaimMatches,
  readProcessExecutionClaim,
  removeProcessExecutionClaim,
  type ContainerExecutionClaim,
} from "./process-execution-claim.js";
import { ProcessExecutionBackend } from "./process-execution-backend.js";
import {
  bindContainerLaunchIntent,
  bindContainerLaunchProjection,
  createContainerLaunchIntent,
  intentMatchesPlacement,
  readContainerLaunchIntent,
  removeContainerLaunchIntent,
  writeContainerLaunchIntent,
  type ContainerLaunchIntent,
} from "./container-launch-intent.js";

export const CONTAINER_EXECUTION_BACKEND_ID = "local-container";
export const CONTAINER_EXECUTION_TARGET_PREFIX = "canonical-worker-container-v1";
const READY_TIMEOUT_MS = 60_000;
const CLAIM_POLL_MS = 100;

export interface ContainerLaunchProjection {
  durableId?: string;
  buildSpec(input: {
    op: Op;
    image: DockerImageIdentity;
    token: string;
    placement: ExecutionPlacement;
  }): DockerContainerSpec;
  writeBootstrap(input: {
    op: Op;
    token: string;
    placement: ExecutionPlacement;
    container: DockerContainerIdentity;
  }): void;
  cleanup(): void;
}

export type ContainerProjectionFactory = (op: Op) => Promise<ContainerLaunchProjection>;
export type ContainerProjectionRecovery = (op: Op, durableId: string) => Promise<ContainerLaunchProjection>;

export interface ContainerBackendOptions {
  imageReference?: string;
  runtime?: DockerExecutionRuntime;
  projectionFactory?: ContainerProjectionFactory;
  projectionRecovery?: ContainerProjectionRecovery;
  now?: () => number;
  readyTimeoutMs?: number;
  claimPollMs?: number;
  onFinalReconcile?: (opId: string) => void;
}

export class ContainerExecutionBackend implements ExecutionBackend {
  readonly id = CONTAINER_EXECUTION_BACKEND_ID;
  readonly adapterProvisioning = "backend" as const;
  private readonly imageReference: string;
  private readonly runtime: DockerExecutionRuntime;
  private readonly projectionFactory: ContainerProjectionFactory;
  private readonly projectionRecovery: ContainerProjectionRecovery;
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;
  private readonly claimPollMs: number;
  private readonly onFinalReconcile: (opId: string) => void;
  private readonly targetId: string;

  constructor(options: ContainerBackendOptions = {}) {
    this.imageReference = options.imageReference ?? process.env.LAX_CONTAINER_EXECUTION_IMAGE ?? "";
    this.runtime = options.runtime ?? new DockerCliExecutionRuntime();
    this.projectionFactory = options.projectionFactory ?? unconfiguredProjection;
    this.projectionRecovery = options.projectionRecovery ?? unconfiguredProjectionRecovery;
    this.now = options.now ?? Date.now;
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.claimPollMs = options.claimPollMs ?? CLAIM_POLL_MS;
    this.onFinalReconcile = options.onFinalReconcile ?? notifyProcessRelayParent;
    this.targetId = targetIdForImage(this.imageReference);
  }

  get configured(): boolean {
    return this.targetId !== "";
  }

  static isEligible(op: Op): boolean {
    return ProcessExecutionBackend.isEligible(op);
  }

  place(_op: Op): { targetId: string; disposition: "ready" } {
    if (!this.configured) throw new Error("container execution image is not configured");
    return { targetId: this.targetId, disposition: "ready" };
  }

  acceptsPlacement(placement: ExecutionPlacement): boolean {
    return this.configured && placement.backendId === this.id && placement.targetId === this.targetId;
  }

  start(_request: ExecutionBackendStartRequest): ExecutionHandle {
    throw new Error("container backend provisions its adapter in the container worker");
  }

  startWithoutAdapter(request: ExecutionBackendStartWithoutAdapterRequest): ExecutionHandle {
    this.assertEligible(request.op, request.placement);
    return { done: this.launchOrReattach(request) };
  }

  private async launchOrReattach(request: ExecutionBackendStartWithoutAdapterRequest): Promise<void> {
    if (!await this.runtime.probe()) throw new Error("Docker is unavailable for recorded container execution");
    const image = await this.runtime.resolvePinnedImage(this.imageReference);
    const existing = readProcessExecutionClaim(request.op.id);
    if (existing) {
      if (existing.ownerKind !== "container") throw new Error("operation already has a non-container owner");
      if (!claimMatchesPlacement(existing, request.placement)) {
        throw new Error("container ownership does not match the recorded placement");
      }
      const intent = readProcessExecutionClaimIntent(request.op.id, request.placement, image, existing);
      const state = await this.runtime.inspect(existing.containerId);
      if (state && state.running && containerStateMatchesClaim(state, existing)
        && isLiveProcessExecutionClaim(existing, {
          inspectContainer: claim => state.running && containerStateMatchesClaim(state, claim)
            ? "live" : "changed",
        })) {
        const projection = await this.reopenProjection(request.op, intent);
        return this.waitForCompletion(request.op.id, existing, projection, intent);
      }
      if (state && !containerStateMatchesClaim(state, existing)) {
        throw new Error("container execution identity changed before reclaim");
      }
      await this.stopAndConfirm(existing.containerId);
      if (!removeProcessExecutionClaim(existing)) throw new Error("container ownership changed during reclaim");
      removeContainerLaunchIntent(intent);
    }

    const resumed = await this.reconcileLaunchIntent(request, image);
    if (resumed) return;
    const token = randomUUID();
    const name = launchName(request.op.id, request.placement.revision, token);
    let intent = createContainerLaunchIntent({ opId: request.op.id, placement: request.placement,
      token, name, imageReference: image.reference, imageId: image.imageId });
    writeContainerLaunchIntent(intent);
    const projection = await this.projectionFactory(request.op);
    if (projection.durableId) {
      intent = bindContainerLaunchProjection(intent, projection.durableId);
      writeContainerLaunchIntent(intent);
    }
    let container: DockerContainerIdentity | null = null;
    try {
      const projected = projection.buildSpec({
        op: request.op,
        image,
        token,
        placement: request.placement,
      });
      container = await this.runtime.create({ ...projected, name,
        labels: { ...projected.labels, ...ownershipLabels(request.op.id, request.placement) } });
      intent = bindContainerLaunchIntent(intent, container);
      writeContainerLaunchIntent(intent);
      projection.writeBootstrap({ op: request.op, token, placement: request.placement, container });
      await this.runtime.start(container.containerId);
      const claim = await this.awaitClaim(request.op.id, request.placement, token, container);
      return await this.waitForCompletion(request.op.id, claim, projection, intent);
    } catch (error) {
      if (container) {
        await this.stopAndConfirm(container.containerId);
        const claim = readProcessExecutionClaim(request.op.id);
        if (claim?.ownerKind === "container" && claim.containerId === container.containerId) {
          removeProcessExecutionClaim(claim);
        }
        projection.cleanup();
        removeContainerLaunchIntent(intent);
      }
      throw error;
    }
  }

  private async reconcileLaunchIntent(
    request: ExecutionBackendStartWithoutAdapterRequest,
    image: DockerImageIdentity,
  ): Promise<boolean> {
    const intent = readContainerLaunchIntent(request.op.id);
    if (!intent) return false;
    if (!intentMatchesPlacement(intent, request.placement, image.reference, image.imageId)) {
      throw new Error("container launch intent does not match the recorded placement");
    }
    const state = intent.container
      ? await this.runtime.inspect(intent.container.containerId)
      : await this.runtime.inspectNamed(intent.name, ownershipLabels(request.op.id, request.placement));
    if (!state) {
      (await this.reopenProjection(request.op, intent))?.cleanup();
      removeContainerLaunchIntent(intent);
      return false;
    }
    if (state.imageId !== image.imageId || (intent.container
      && (state.containerId !== intent.container.containerId || state.createdAt !== intent.container.createdAt))) {
      throw new Error("container launch identity changed during recovery");
    }
    if (!state.running) {
      await this.stopAndConfirm(state.containerId);
      (await this.reopenProjection(request.op, intent))?.cleanup();
      removeContainerLaunchIntent(intent);
      return false;
    }
    const bound = intent.container ? intent : bindContainerLaunchIntent(intent, state);
    if (!intent.container) writeContainerLaunchIntent(bound);
    const claim = await this.awaitClaim(request.op.id, request.placement, intent.token, state);
    const projection = await this.reopenProjection(request.op, bound);
    await this.waitForCompletion(request.op.id, claim, projection, bound);
    return true;
  }

  private reopenProjection(op: Op, intent: ContainerLaunchIntent): Promise<ContainerLaunchProjection | null> {
    return intent.projectionId ? this.projectionRecovery(op, intent.projectionId) : Promise.resolve(null);
  }

  private async awaitClaim(
    opId: string,
    placement: ExecutionPlacement,
    token: string,
    container: DockerContainerIdentity,
  ): Promise<ContainerExecutionClaim> {
    const deadline = this.now() + this.readyTimeoutMs;
    while (this.now() <= deadline) {
      const claim = readProcessExecutionClaim(opId);
      if (claim) {
        if (claim.ownerKind !== "container" || claim.backendId !== this.id
          || claim.targetId !== placement.targetId || claim.placementRevision !== placement.revision
          || claim.token !== token || claim.containerId !== container.containerId
          || claim.containerCreatedAt !== container.createdAt || claim.imageDigest !== container.imageId) {
          throw new Error("container worker returned an ambiguous handoff identity");
        }
        return claim;
      }
      const state = await this.runtime.inspect(container.containerId);
      if (!state?.running) throw new Error("container worker exited before durable handoff");
      await delay(this.claimPollMs);
    }
    throw new Error("container worker handoff timed out");
  }

  private async waitForCompletion(
    opId: string,
    claim: ContainerExecutionClaim,
    projection: ContainerLaunchProjection | null,
    intent: ContainerLaunchIntent | null,
  ): Promise<void> {
    const reconcile = setInterval(() => {
      try { this.onFinalReconcile(opId); } catch { /* durable relay remains pending */ }
    }, 250);
    reconcile.unref?.();
    try {
      const state = await this.runtime.inspect(claim.containerId);
      if (!state || !containerStateMatchesClaim(state, claim)) {
        throw new Error("container execution identity changed before reattach");
      }
      const exitCode = state.running ? await this.runtime.wait(claim.containerId) : state.exitCode;
      if (exitCode !== 0) throw new Error(`container worker exited before completion (${exitCode})`);
    } finally {
      clearInterval(reconcile);
      try { this.onFinalReconcile(opId); } catch { /* startup janitor retries */ }
      await this.stopAndConfirm(claim.containerId);
      const current = readProcessExecutionClaim(opId);
      if (current && processClaimMatches(current, claim)) removeProcessExecutionClaim(current);
      projection?.cleanup();
      if (intent) removeContainerLaunchIntent(intent);
    }
  }

  private async stopAndConfirm(containerId: string): Promise<void> {
    await this.runtime.stop(containerId);
    if (await this.runtime.inspect(containerId)) {
      throw new Error("container termination could not be confirmed");
    }
  }

  private assertEligible(op: Op, placement: ExecutionPlacement): void {
    if (!this.acceptsPlacement(placement) || placement.disposition !== "ready") {
      throw new Error("container execution placement identity mismatch");
    }
    if (!ContainerExecutionBackend.isEligible(op)) {
      throw new Error("operation is not eligible for container execution");
    }
  }
}

function targetIdForImage(reference: string): string {
  const match = /@sha256:([a-f0-9]{64})$/.exec(reference);
  return match ? `${CONTAINER_EXECUTION_TARGET_PREFIX}-${match[1]}` : "";
}

function containerStateMatchesClaim(
  state: DockerContainerIdentity,
  claim: ContainerExecutionClaim,
): boolean {
  return state.containerId === claim.containerId && state.createdAt === claim.containerCreatedAt
    && state.imageId === claim.imageDigest;
}

function claimMatchesPlacement(
  claim: ContainerExecutionClaim,
  placement: ExecutionPlacement,
): boolean {
  return claim.backendId === placement.backendId && claim.targetId === placement.targetId
    && claim.placementRevision === placement.revision;
}

function readProcessExecutionClaimIntent(
  opId: string,
  placement: ExecutionPlacement,
  image: DockerImageIdentity,
  claim: ContainerExecutionClaim,
): ContainerLaunchIntent {
  const intent = readContainerLaunchIntent(opId);
  if (!intent || !intent.container
    || !intentMatchesPlacement(intent, placement, image.reference, image.imageId)
    || intent.container.containerId !== claim.containerId
    || intent.container.createdAt !== claim.containerCreatedAt
    || intent.container.imageId !== claim.imageDigest) {
    throw new Error("container ownership is missing its exact sealed launch intent");
  }
  return intent;
}

function ownershipLabels(opId: string, placement: ExecutionPlacement): Record<string, string> {
  return { "lax.execution.backend": placement.backendId, "lax.execution.op": opId,
    "lax.execution.revision": String(placement.revision), "lax.execution.target": placement.targetId };
}

function launchName(opId: string, revision: number, token: string): string {
  const suffix = createHash("sha256").update(`${opId}\0${revision}\0${token}`).digest("hex").slice(0, 32);
  return `lax-op-${suffix}`;
}

async function unconfiguredProjection(): Promise<ContainerLaunchProjection> {
  throw new Error("container execution state projection is not configured");
}

async function unconfiguredProjectionRecovery(): Promise<ContainerLaunchProjection> {
  throw new Error("container execution projection recovery is not configured");
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
