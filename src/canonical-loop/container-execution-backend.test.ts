import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Op } from "../ops/types.js";
import type {
  DockerContainerSpec,
  DockerExecutionRuntime,
  DockerImageIdentity,
} from "../sandbox/docker-execution-runtime.js";
import type { ContainerExecutionBackend, ContainerLaunchProjection } from "./container-execution-backend.js";
import type { ContainerExecutionClaim } from "./process-execution-claim.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-container-backend-"));
process.env.LAX_DATA_DIR = dataDir;
const { ContainerExecutionBackend: Backend } = await import("./container-execution-backend.js");
const { claimProcessExecution } = await import("./process-execution-claim.js");
const { writeOp } = await import("../ops/op-store.js");

const digest = `sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"b".repeat(64)}`;
const imageReference = `registry.example/lax-worker@${digest}`;
const containerId = "c".repeat(64);
const createdAt = "2026-07-21T12:00:00.000Z";

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("ContainerExecutionBackend", () => {
  it("fails closed when Docker is unavailable and does not reroute", async () => {
    const runtime = fakeRuntime({ probe: vi.fn().mockResolvedValue(false) });
    const backend = backendWith(runtime);
    const op = fixtureOp("unavailable", backend);
    await expect(backend.startWithoutAdapter({ op, placement: op.canonical!.executionPlacement! }).done)
      .rejects.toThrow("Docker is unavailable");
    expect(runtime.create).not.toHaveBeenCalled();
  });

  it("persists the exact container fence before accepting handoff", async () => {
    let backend: ContainerExecutionBackend;
    const runtime = fakeRuntime({
      start: vi.fn(async () => {
        const op = fixture;
        const placement = op.canonical!.executionPlacement!;
        const token = projection.token!;
        expect(claimProcessExecution(claim(op, placement.targetId, placement.revision, token))).toBe(true);
      }),
    });
    const projection = fakeProjection();
    backend = backendWith(runtime, projection);
    const fixture = fixtureOp("handoff", backend);

    await expect(backend.startWithoutAdapter({
      op: fixture, placement: fixture.canonical!.executionPlacement!,
    }).done).resolves.toBeUndefined();
    expect(projection.bootstrap).toEqual(expect.objectContaining({ containerId }));
    expect(runtime.wait).toHaveBeenCalledWith(containerId);
    expect(runtime.stop).toHaveBeenCalledWith(containerId);
  });

  it("reattaches only to the exact live recorded container", async () => {
    const runtime = fakeRuntime();
    const projection = fakeProjection();
    const backend = backendWith(runtime, projection);
    const op = fixtureOp("reattach", backend);
    const placement = op.canonical!.executionPlacement!;
    expect(claimProcessExecution(claim(op, placement.targetId, placement.revision, "kept"))).toBe(true);

    await expect(backend.startWithoutAdapter({ op, placement }).done).resolves.toBeUndefined();
    expect(runtime.create).not.toHaveBeenCalled();
    expect(runtime.wait).toHaveBeenCalledWith(containerId);
  });
});

function backendWith(runtime: DockerExecutionRuntime, projection = fakeProjection()): ContainerExecutionBackend {
  return new Backend({
    imageReference,
    runtime,
    projectionFactory: async () => projection,
    claimPollMs: 1,
    readyTimeoutMs: 100,
  });
}

function fakeRuntime(overrides: Partial<DockerExecutionRuntime> = {}): DockerExecutionRuntime {
  const image: DockerImageIdentity = { reference: imageReference, requestedDigest: digest, imageId };
  return {
    probe: vi.fn().mockResolvedValue(true),
    resolvePinnedImage: vi.fn().mockResolvedValue(image),
    create: vi.fn().mockResolvedValue({ containerId, createdAt, imageId }),
    start: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({ containerId, createdAt, imageId, running: true, exitCode: null }),
    wait: vi.fn().mockResolvedValue(0),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeProjection(): ContainerLaunchProjection & {
  token?: string;
  bootstrap?: { containerId: string };
} {
  return {
    buildSpec(input): DockerContainerSpec {
      this.token = input.token;
      return {
        name: `lax-${input.op.id}`,
        image: input.image,
        command: ["node", "/opt/lax/container-worker-entry.js"],
        environment: {}, mounts: [], network: "none", memoryLimit: "2g", pidsLimit: 256, labels: {},
      };
    },
    writeBootstrap(input) { this.bootstrap = { containerId: input.container.containerId }; },
    cleanup: vi.fn(),
  };
}

function fixtureOp(label: string, backend: ContainerExecutionBackend): Op {
  const op: Op = {
    id: `op-container-${label}`,
    type: "delegated_task",
    task: label,
    contextPack: {
      task: { description: label, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {}, budget: { maxIterations: 2, maxTokens: 100, maxWallTimeMs: 10_000, maxSelfEditCalls: 0 },
      routing: { lane: "background" }, secrets: { allowed: [] },
    },
    lane: "background" as const,
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "test", visibility: "private" as const, status: "pending" as const,
    createdAt: createdAt, attemptCount: 0, model: "test",
    canonical: { sessionId: `session-${label}`, state: "queued" as const },
    runtimeDescriptor: {
      kind: "delegated-op" as const, adapter: "provider-exact" as const,
      provider: "local" as const, credentialProvider: "local" as const,
      authSource: "sentinel" as const, model: "test", runtime: "openai-compat" as const,
      target: { kind: "local-config" as const, endpointFingerprint: "f".repeat(64) },
      sessionId: `session-${label}`,
      surface: {
        kind: "agent-runner" as const, systemPrompt: "test", tools: [],
        security: { workspace: "/workspace", fileAccessMode: "workspace" as const,
          inlineEvalPolicy: "refuse" as const, allowedPaths: [], configFingerprint: "e".repeat(64) },
        threatEngine: false as const, rbac: false, callContext: "delegated" as const,
      },
      integrity: { scheme: "hmac-sha256-v1" as const, mac: "d".repeat(64) },
    },
  };
  const selected = backend.place(op);
  op.canonical!.executionPlacement = {
    schemaVersion: 1, backendId: backend.id, targetId: selected.targetId,
    disposition: "ready", wakeToken: null, wakeRequestedAt: null, revision: 1,
  };
  writeOp(op);
  return op;
}

function claim(op: Op, targetId: string, revision: number, token: string): ContainerExecutionClaim {
  return {
    schemaVersion: 1, opId: op.id, backendId: "local-container", targetId,
    placementRevision: revision, token, pid: 17, processStartedAt: createdAt,
    heartbeatAt: new Date().toISOString(), ownerKind: "container", containerId,
    containerCreatedAt: createdAt, imageDigest: imageId,
  };
}
