import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Op } from "../ops/types.js";
import type { DockerExecutionRuntime } from "../sandbox/docker-execution-runtime.js";

const previousData = process.env.LAX_DATA_DIR;
const root = mkdtempSync(join(tmpdir(), "lax-terminal-container-"));
process.env.LAX_DATA_DIR = root;
const { reconcileTerminalContainerExecutions } = await import("./container-terminal-janitor.js");
const { bindContainerLaunchIntent, bindContainerLaunchProjection,
  createContainerLaunchIntent, readContainerLaunchIntent, writeContainerLaunchIntent } =
  await import("./container-launch-intent.js");
const { writeOp } = await import("../ops/op-store.js");

const container = { containerId: "c".repeat(64), createdAt: "2026-07-21T12:00:00.000Z",
  imageId: `sha256:${"b".repeat(64)}` };
const imageReference = `example/worker@sha256:${"a".repeat(64)}`;

afterAll(() => {
  if (previousData === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousData;
  rmSync(root, { recursive: true, force: true });
});

describe("terminal container janitor", () => {
  it("removes the exact stopped container, projection and intent after parent loss", async () => {
    const op = terminalOp();
    writeOp(op);
    let intent = createContainerLaunchIntent({ opId: op.id,
      placement: op.canonical!.executionPlacement!, token: "terminal-token",
      name: "lax-op-terminal", imageReference, imageId: container.imageId });
    intent = bindContainerLaunchProjection(intent, "projection-terminal");
    writeContainerLaunchIntent(bindContainerLaunchIntent(intent, container));
    let removed = false;
    const runtime = { probe: vi.fn().mockResolvedValue(true),
      inspect: vi.fn(async () => removed ? null : { ...container, running: false, exitCode: 0 }),
      stop: vi.fn(async () => { removed = true; }) } as unknown as DockerExecutionRuntime;
    const cleanup = vi.fn();

    await expect(reconcileTerminalContainerExecutions({ runtime, listOpIds: () => [op.id],
      projectionRecovery: async (_op, id) => ({ durableId: id,
        buildSpec() { throw new Error("must not relaunch"); }, writeBootstrap() {}, cleanup }) }))
      .resolves.toEqual({ cleaned: [op.id], deferred: [] });
    expect(runtime.stop).toHaveBeenCalledWith(container.containerId);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(readContainerLaunchIntent(op.id)).toBeNull();
  });

  it("reconciles a named container when create completed before intent binding", async () => {
    const op = terminalOp("op-terminal-unbound");
    writeOp(op);
    let intent = createContainerLaunchIntent({ opId: op.id,
      placement: op.canonical!.executionPlacement!, token: "unbound-token",
      name: "lax-op-unbound", imageReference, imageId: container.imageId });
    intent = bindContainerLaunchProjection(intent, "projection-unbound");
    writeContainerLaunchIntent(intent);
    let removed = false;
    const runtime = { probe: vi.fn().mockResolvedValue(true), inspectNamed: vi.fn(async () => ({
      ...container, running: false, exitCode: 0,
    })), inspect: vi.fn(async () => removed ? null : { ...container, running: false, exitCode: 0 }),
      stop: vi.fn(async () => { removed = true; }) } as unknown as DockerExecutionRuntime;

    const result = await reconcileTerminalContainerExecutions({ runtime, listOpIds: () => [op.id],
      projectionRecovery: async (_op, id) => ({ durableId: id,
        buildSpec() { throw new Error("must not relaunch"); }, writeBootstrap() {}, cleanup() {} }) });
    expect(result).toEqual({ cleaned: [op.id], deferred: [] });
    expect(runtime.inspectNamed).toHaveBeenCalledWith("lax-op-unbound", expect.objectContaining({
      "lax.execution.op": op.id,
    }));
  });
});

function terminalOp(id = "op-terminal-container"): Op {
  return { id, type: "delegated_task", task: "done", lane: "background",
    status: "succeeded", ownerId: "test", visibility: "private", createdAt: new Date().toISOString(),
    canonical: { sessionId: "session-terminal", state: "succeeded",
      executionPlacement: { schemaVersion: 1, backendId: "local-container", targetId: "target",
        disposition: "ready", wakeToken: null, wakeRequestedAt: null, revision: 1 } },
  } as unknown as Op;
}
