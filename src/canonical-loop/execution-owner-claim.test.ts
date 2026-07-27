import { describe, expect, it } from "vitest";
import {
  isLiveProcessExecutionClaim,
  ownerEvidence,
  parseProcessExecutionClaim,
  processClaimMatches,
  PROCESS_EXECUTION_CLAIM_FRESH_MS,
  STALE_OWNER_DEAD_CEILING_MS,
  type ContainerExecutionClaim,
  type ProcessExecutionClaim,
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

// ── ownerEvidence: liveness is evidence of existence, not recency of check-in ──
//
// The invariant this matrix pins (2026-07-25 lease-death class): a stale
// heartbeat with a live pid is a STARVED owner, not a dead one. It must
// resolve "unknown", and no takeover path may act on "unknown".
describe("ownerEvidence tri-state", () => {
  const staleBy = (ms: number) => () => Date.parse(now) + ms;
  const stale = staleBy(PROCESS_EXECUTION_CLAIM_FRESH_MS + 1_000);

  it("fresh heartbeat + live pid → alive", () => {
    expect(ownerEvidence(processClaim(), { now: staleBy(1_000), isPidAlive: () => true }))
      .toBe("alive");
  });

  it("stale heartbeat + live pid → unknown (the starved-worker shape — NEVER dead)", () => {
    expect(ownerEvidence(processClaim(), { now: stale, isPidAlive: () => true }))
      .toBe("unknown");
  });

  it("gone pid → dead regardless of heartbeat recency (existence is the proof)", () => {
    expect(ownerEvidence(processClaim(), { now: staleBy(1_000), isPidAlive: () => false }))
      .toBe("dead");
    expect(ownerEvidence(processClaim(), { now: stale, isPidAlive: () => false }))
      .toBe("dead");
  });

  it("stale past the ten-minute ceiling → dead even with a live pid (pid-reuse bound)", () => {
    expect(ownerEvidence(processClaim(), {
      now: staleBy(STALE_OWNER_DEAD_CEILING_MS + 1),
      isPidAlive: () => true,
    })).toBe("dead");
  });

  it("container: stale heartbeat + running container → unknown; not running → dead", () => {
    expect(ownerEvidence(containerClaim(), { now: stale, isContainerAlive: () => true }))
      .toBe("unknown");
    expect(ownerEvidence(containerClaim(), { now: stale, isContainerAlive: () => false }))
      .toBe("dead");
  });

  it("isLiveProcessExecutionClaim remains exactly evidence === alive", () => {
    expect(isLiveProcessExecutionClaim(processClaim(), { now: staleBy(1_000), isPidAlive: () => true }))
      .toBe(true);
    expect(isLiveProcessExecutionClaim(processClaim(), { now: stale, isPidAlive: () => true }))
      .toBe(false);
  });
});

function processClaim(): ProcessExecutionClaim {
  return {
    schemaVersion: 1,
    opId: "op-1",
    backendId: "local-process",
    targetId: "canonical-worker-process-v1",
    placementRevision: 1,
    token: "token-1",
    pid: 17,
    processStartedAt: now,
    heartbeatAt: now,
  };
}

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
