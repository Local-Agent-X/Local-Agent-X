import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetAuditKeyCacheForTests } from "../app-runtime/audit-signing.js";
import { sealContainerBootstrap, verifyContainerBootstrap } from "./container-bootstrap.js";

const priorKey = process.env.LAX_AUDIT_KEY;

beforeEach(() => {
  process.env.LAX_AUDIT_KEY = "container-bootstrap-test-key";
  _resetAuditKeyCacheForTests();
});

afterEach(() => {
  if (priorKey === undefined) delete process.env.LAX_AUDIT_KEY;
  else process.env.LAX_AUDIT_KEY = priorKey;
  _resetAuditKeyCacheForTests();
});

describe("container bootstrap integrity", () => {
  it("round-trips the exact handoff identity", () => {
    const bootstrap = fixture();
    expect(verifyContainerBootstrap(sealContainerBootstrap(bootstrap))).toEqual(bootstrap);
  });

  it("rejects a placement or container identity change", () => {
    const sealed = sealContainerBootstrap(fixture());
    const changedPlacement = structuredClone(sealed);
    changedPlacement.bootstrap.placementRevision += 1;
    expect(() => verifyContainerBootstrap(changedPlacement)).toThrow("integrity check failed");
    const changedContainer = structuredClone(sealed);
    changedContainer.bootstrap.containerId = "d".repeat(64);
    expect(() => verifyContainerBootstrap(changedContainer)).toThrow("integrity check failed");
  });
});

function fixture() {
  return {
    schemaVersion: 1 as const,
    opId: "op-container",
    backendId: "local-container",
    targetId: `canonical-worker-container-v1-${"a".repeat(64)}`,
    placementRevision: 3,
    token: "handoff-token",
    containerId: "c".repeat(64),
    containerCreatedAt: "2026-07-21T12:00:00.000Z",
    imageDigest: `sha256:${"b".repeat(64)}`,
  };
}
