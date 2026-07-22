import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../ops/types.js";

const enabled = process.platform === "linux";
const original = {
  data: process.env.LAX_DATA_DIR,
  audit: process.env.LAX_AUDIT_KEY,
  openai: process.env.OPENAI_API_KEY,
  network: process.env.LAX_CONTAINER_EXECUTION_NETWORK,
  networkId: process.env.LAX_CONTAINER_EXECUTION_NETWORK_ID,
};
let root: string | null = null;

afterEach(() => {
  vi.resetModules();
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
  restore("LAX_DATA_DIR", original.data);
  restore("LAX_AUDIT_KEY", original.audit);
  restore("OPENAI_API_KEY", original.openai);
  restore("LAX_CONTAINER_EXECUTION_NETWORK", original.network);
  restore("LAX_CONTAINER_EXECUTION_NETWORK_ID", original.networkId);
});

describe.skipIf(!enabled)("production container runtime projection", () => {
  it("creates, reopens, verifies and cleans only the scoped durable projection", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-container-projection-"));
    process.env.LAX_DATA_DIR = root;
    process.env.LAX_AUDIT_KEY = "projection-audit-key";
    process.env.OPENAI_API_KEY = "scoped-openai-key";
    process.env.LAX_CONTAINER_EXECUTION_NETWORK = "lax-egress";
    process.env.LAX_CONTAINER_EXECUTION_NETWORK_ID = "e".repeat(64);
    const { sealDelegatedRuntime } = await import("./runtime-integrity.js");
    const { opDir } = await import("../ops/event-log.js");
    const { createContainerRuntimeProjection, reopenContainerRuntimeProjection } =
      await import("./container-runtime-projection.js");
    const { verifyContainerBootstrap } = await import("./container-bootstrap.js");
    const op = fixtureOp(sealDelegatedRuntime);
    opDir(op.id);

    const projection = await createContainerRuntimeProjection(op, randomUUID());
    const spec = projection.buildSpec({ op, image: image(), token: "token", placement: placement() });
    expect(projection.durableId).toMatch(/^[a-f0-9-]{36}$/);
    expect(spec.mounts.some(mount => mount.source === root || mount.source.endsWith("docker.sock"))).toBe(false);
    expect(spec.mounts.every(mount => mount.identity?.device && mount.identity.inode)).toBe(true);
    expect(spec.network).toEqual({ name: "lax-egress" });
    expect(spec.environment.LAX_CONTAINER_BROWSER_RELAY).toBe("1");
    expect(spec.environment.LAX_CONTAINER_BROWSER_RELAY_SOCKET)
      .toBe("/var/lib/lax/browser-relay.sock");
    expect(spec.environment.LAX_CONTAINER_BROWSER_RELAY_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    const credential = spec.mounts.find(mount => mount.target.endsWith("runtime-credential.json"))!;
    expect(readFileSync(credential.source, "utf8")).toContain("scoped-openai-key");
    projection.writeBootstrap({ op, token: "token", placement: placement(), container: container() });
    const bootstrap = spec.mounts.find(mount => mount.target.endsWith("bootstrap.json"))!;
    expect(verifyContainerBootstrap(JSON.parse(readFileSync(bootstrap.source, "utf8"))).opId).toBe(op.id);

    const reopened = await reopenContainerRuntimeProjection(op, projection.durableId!);
    expect(reopened!.buildSpec({ op, image: image(), token: "token", placement: placement() }).mounts)
      .toHaveLength(spec.mounts.length);
    const projectionRoot = join(root, "container-runtime", projection.durableId!);
    await reopened!.cleanup();
    expect(existsSync(projectionRoot)).toBe(false);
  });

  it("rejects projected credential tampering on reopen", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-container-projection-"));
    process.env.LAX_DATA_DIR = root;
    process.env.LAX_AUDIT_KEY = "projection-audit-key";
    process.env.OPENAI_API_KEY = "scoped-openai-key";
    const { sealDelegatedRuntime } = await import("./runtime-integrity.js");
    const { opDir } = await import("../ops/event-log.js");
    const { createContainerRuntimeProjection, reopenContainerRuntimeProjection } =
      await import("./container-runtime-projection.js");
    const op = fixtureOp(sealDelegatedRuntime);
    opDir(op.id);
    const projection = await createContainerRuntimeProjection(op, randomUUID());
    const credential = join(root, "container-runtime", projection.durableId!, "secrets", "runtime-credential.json");
    const originalCredential = readFileSync(credential, "utf8");
    writeFileSync(credential, "{}", "utf8");

    await expect(reopenContainerRuntimeProjection(op, projection.durableId!))
      .rejects.toThrow("file integrity check failed");
    writeFileSync(credential, originalCredential, "utf8");
    await projection.cleanup();
  });
});

function fixtureOp(seal: typeof import("./runtime-integrity.js").sealDelegatedRuntime): Op {
  const op = { id: "op-projection", type: "delegated_task", task: "test", lane: "background",
    status: "pending", ownerId: "test", visibility: "private", createdAt: new Date().toISOString(),
    canonical: { sessionId: "session-projection", state: "queued" } } as unknown as Op;
  op.runtimeDescriptor = seal(op.id, { kind: "delegated-op", adapter: "provider-exact",
    provider: "openai", credentialProvider: "openai", authSource: "env", model: "gpt-test",
    runtime: "openai-compat", target: { kind: "provider-registry", endpointFingerprint: "f".repeat(64) },
    sessionId: "session-projection" });
  return op;
}

function placement() {
  return { schemaVersion: 1 as const, backendId: "local-container", targetId: "target",
    disposition: "ready" as const, wakeToken: null, wakeRequestedAt: null, revision: 1 };
}

function image() {
  return { reference: `example/worker@sha256:${"a".repeat(64)}`,
    requestedDigest: `sha256:${"a".repeat(64)}`, imageId: `sha256:${"b".repeat(64)}` };
}

function container() {
  return { containerId: "c".repeat(64), createdAt: "2026-07-21T12:00:00.000Z",
    imageId: `sha256:${"b".repeat(64)}` };
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
