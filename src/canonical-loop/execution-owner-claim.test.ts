import { describe, expect, it } from "vitest";
import {
  isLiveProcessExecutionClaim,
  parseProcessExecutionClaim,
  processClaimMatches,
  type ContainerExecutionClaim,
} from "./process-execution-claim.js";

const now = "2026-07-21T12:00:00.000Z";

describe("execution owner claim", () => {
  it("requires the complete container fence", () => {
    const claim = containerClaim();
    expect(parseProcessExecutionClaim(claim)).toEqual(claim);
    expect(() => parseProcessExecutionClaim({ ...claim, imageDigest: undefined }))
      .toThrow("ambiguous container execution claim");
  });

  it("matches container id, creation time, image digest, placement and token", () => {
    const claim = containerClaim();
    expect(processClaimMatches(claim, claim)).toBe(true);
    expect(processClaimMatches(claim, { ...claim, containerId: "d".repeat(64) })).toBe(false);
    expect(processClaimMatches(claim, { ...claim, placementRevision: 2 })).toBe(false);
    expect(processClaimMatches(claim, { ...claim, token: "other" })).toBe(false);
  });

  it("uses heartbeat plus injected container liveness instead of host pid", () => {
    const claim = containerClaim();
    expect(isLiveProcessExecutionClaim(claim, {
      now: () => Date.parse(now) + 1_000,
      isPidAlive: () => false,
      isContainerAlive: () => true,
    })).toBe(true);
    expect(isLiveProcessExecutionClaim(claim, {
      now: () => Date.parse(now) + 1_000,
      isContainerAlive: () => false,
    })).toBe(false);
  });

  it("accepts an explicit process owner marker but rejects a future heartbeat", () => {
    const processClaim = {
      ...containerClaim(), ownerKind: "process" as const,
      containerId: undefined, containerCreatedAt: undefined, imageDigest: undefined,
    };
    expect(parseProcessExecutionClaim(processClaim).ownerKind).toBe("process");
    const future = { ...containerClaim(), heartbeatAt: "2027-07-21T12:00:00.000Z" };
    expect(isLiveProcessExecutionClaim(future, {
      now: () => Date.parse(now), isContainerAlive: () => true,
    })).toBe(false);
  });
});

function containerClaim(): ContainerExecutionClaim {
  return {
    schemaVersion: 1,
    opId: "op-1",
    backendId: "local-container",
    targetId: "canonical-worker-container-v1",
    placementRevision: 1,
    token: "token-1",
    pid: 17,
    processStartedAt: now,
    heartbeatAt: now,
    ownerKind: "container",
    containerId: "c".repeat(64),
    containerCreatedAt: now,
    imageDigest: `sha256:${"a".repeat(64)}`,
  };
}
