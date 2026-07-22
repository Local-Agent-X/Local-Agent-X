import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { DockerCliExecutionRuntime } from "./docker-execution-runtime.js";

const imageReference = process.env.LAX_TEST_CONTAINER_IMAGE;
const enabled = !!imageReference && process.env.LAX_RUN_DOCKER_TESTS === "1";

describe.skipIf(!enabled)("Docker execution runtime integration", () => {
  it("reattaches by exact daemon identity after the parent runtime is replaced", async () => {
    const first = new DockerCliExecutionRuntime();
    expect(await first.probe()).toBe(true);
    const image = await first.resolvePinnedImage(imageReference!);
    const name = `lax-integration-${randomBytes(8).toString("hex")}`;
    const labels = { "lax.execution.test": "restart" };
    const created = await first.create({
      name, image,
      command: ["node", "-e", "setTimeout(() => {}, 30000)"],
      environment: {}, mounts: [], network: "none", memoryLimit: "256m", pidsLimit: 32, labels,
    });
    try {
      await first.start(created.containerId);
      const restartedParent = new DockerCliExecutionRuntime();
      const recovered = await restartedParent.inspectNamed(name, labels);
      expect(recovered).toEqual(expect.objectContaining({
        containerId: created.containerId,
        createdAt: created.createdAt,
        imageId: created.imageId,
        running: true,
      }));
      await restartedParent.stop(created.containerId);
      await expect(restartedParent.inspect(created.containerId)).resolves.toBeNull();
    } finally {
      await first.stop(created.containerId).catch(() => {});
    }
  }, 60_000);
});
