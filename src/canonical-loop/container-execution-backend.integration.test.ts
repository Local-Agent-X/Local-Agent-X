import { describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import { DockerCliExecutionRuntime } from "../sandbox/docker-execution-runtime.js";
import type { ContainerExecutionBackend } from "./container-execution-backend.js";

const imageReference = process.env.LAX_TEST_CONTAINER_IMAGE;
const enabled = !!imageReference && process.env.LAX_RUN_DOCKER_TESTS === "1";

describe.skipIf(!enabled)("Container execution backend integration", () => {
  it("reattaches to one live container effect after parent replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-container-backend-restart-"));
    const previousData = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = join(root, "data");
    const first = new DockerCliExecutionRuntime(undefined, {
      approvedMountRoots: [root], allowedNetwork: null,
    });
    const image = await first.resolvePinnedImage(imageReference!);
    const name = `lax-backend-restart-${randomBytes(8).toString("hex")}`;
    const labels = { "lax.execution.backend": "local-container",
      "lax.execution.op": "op-docker-backend-restart", "lax.execution.revision": "1" };
    const created = await first.create({
      name, image,
      command: ["node", "--input-type=module", "-e",
        "import{writeFileSync}from'node:fs';try{writeFileSync('/out/effect','once',{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}await new Promise(r=>setTimeout(r,3000))"],
      environment: {}, mounts: [{ source: root, target: "/out", readOnly: false }],
      network: "none", memoryLimit: "256m", pidsLimit: 32, labels,
    });
    try {
      await first.start(created.containerId);
      const { ContainerExecutionBackend } = await import("./container-execution-backend.js");
      const { claimProcessExecution } = await import("./process-execution-claim.js");
      const { bindContainerLaunchIntent, bindContainerLaunchProjection,
        createContainerLaunchIntent, writeContainerLaunchIntent } =
        await import("./container-launch-intent.js");
      const { writeOp } = await import("../ops/op-store.js");
      const backend = new ContainerExecutionBackend({ imageReference,
        runtime: new DockerCliExecutionRuntime(undefined, {
          approvedMountRoots: [root], allowedNetwork: null,
        }), projectionRecovery: async (_op, id) => ({ durableId: id,
          buildSpec() { throw new Error("recovery must not relaunch"); },
          writeBootstrap() {}, cleanup() {} }) });
      const op = integrationOp(backend, image.reference);
      writeOp(op);
      const placement = op.canonical!.executionPlacement!;
      const token = randomUUID();
      expect(claimProcessExecution({ schemaVersion: 1, opId: op.id,
        backendId: backend.id, targetId: placement.targetId, placementRevision: 1,
        token, pid: 1, processStartedAt: created.createdAt, heartbeatAt: new Date().toISOString(),
        ownerKind: "container", containerId: created.containerId,
        containerCreatedAt: created.createdAt, imageDigest: created.imageId })).toBe(true);
      let intent = createContainerLaunchIntent({ opId: op.id, placement, token, name,
        imageReference: image.reference, imageId: image.imageId });
      intent = bindContainerLaunchProjection(intent, randomUUID());
      writeContainerLaunchIntent(bindContainerLaunchIntent(intent, created));

      await backend.startWithoutAdapter({ op, placement }).done;
      expect(readFileSync(join(root, "effect"), "utf8")).toBe("once");
    } finally {
      await first.stop(created.containerId).catch(() => {});
      if (previousData === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = previousData;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function integrationOp(backend: ContainerExecutionBackend, image: string): Op {
  const op = { id: "op-docker-backend-restart", type: "delegated_task", task: "restart",
    lane: "background", status: "pending", ownerId: "test", visibility: "private",
    createdAt: new Date().toISOString(), canonical: { sessionId: "session-restart", state: "queued" },
    runtimeDescriptor: { kind: "delegated-op", adapter: "provider-exact", provider: "local",
      credentialProvider: "local", authSource: "sentinel", model: "test", runtime: "openai-compat",
      target: { kind: "local-config", endpointFingerprint: "f".repeat(64) },
      sessionId: "session-restart", surface: { kind: "agent-runner", systemPrompt: "test", tools: [],
        security: { workspace: "/workspace", fileAccessMode: "workspace", inlineEvalPolicy: "refuse",
          allowedPaths: [], configFingerprint: "e".repeat(64) }, threatEngine: false, rbac: false,
        callContext: "delegated" }, integrity: { scheme: "hmac-sha256-v1", mac: "d".repeat(64) } },
  } as unknown as Op;
  const selected = backend.place(op);
  op.canonical!.executionPlacement = { schemaVersion: 1, backendId: backend.id,
    targetId: selected.targetId, disposition: "ready", wakeToken: null,
    wakeRequestedAt: null, revision: 1 };
  if (!image.includes("@sha256:")) throw new Error("integration image is not pinned");
  return op;
}
