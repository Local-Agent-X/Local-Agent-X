import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  recordFailure,
  isCircuitOpen,
  resetCircuit,
  decideRecovery,
  getRetryPolicy,
} from "../src/ops/heartbeat.js";
import type { Op, OpRetryPolicy } from "../src/ops/types.js";

let counter = 0;
const opType = (label: string) => `t-${Date.now()}-${++counter}-${label}`;

const mkOp = (over: Partial<Op> = {}): Op => ({
  id: over.id ?? "op-x",
  type: over.type ?? "freeform",
  task: over.task ?? "do the thing",
  contextPack: over.contextPack ?? ({} as Op["contextPack"]),
  lane: over.lane ?? "build",
  retryPolicy: over.retryPolicy ?? { maxRecoveryAttempts: 3, backoffMs: [5_000, 30_000, 120_000] },
  ownerId: over.ownerId ?? "u",
  visibility: over.visibility ?? "private",
  status: over.status ?? "running",
  createdAt: over.createdAt ?? new Date().toISOString(),
  attemptCount: over.attemptCount ?? 0,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("circuit breaker (recordFailure / isCircuitOpen / resetCircuit)", () => {
  it("returns false from isCircuitOpen for an unseen op-type", () => {
    expect(isCircuitOpen(opType("unseen"))).toBe(false);
  });

  it("recordFailure returns false until threshold of 5 is reached", () => {
    const t = opType("threshold");
    expect(recordFailure(t)).toBe(false);
    expect(recordFailure(t)).toBe(false);
    expect(recordFailure(t)).toBe(false);
    expect(recordFailure(t)).toBe(false);
    expect(recordFailure(t)).toBe(true);
    expect(isCircuitOpen(t)).toBe(true);
  });

  it("circuit stays open on subsequent failures past the threshold", () => {
    const t = opType("stays-open");
    for (let i = 0; i < 7; i++) recordFailure(t);
    expect(isCircuitOpen(t)).toBe(true);
  });

  it("isolates failure buckets across op-types", () => {
    const a = opType("a");
    const b = opType("b");
    for (let i = 0; i < 5; i++) recordFailure(a);
    expect(isCircuitOpen(a)).toBe(true);
    expect(isCircuitOpen(b)).toBe(false);
  });

  it("resetCircuit clears the bucket", () => {
    const t = opType("reset");
    for (let i = 0; i < 5; i++) recordFailure(t);
    expect(isCircuitOpen(t)).toBe(true);
    resetCircuit(t);
    expect(isCircuitOpen(t)).toBe(false);
  });

  it("expires failures older than the 1-hour window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
    const t = opType("window");
    for (let i = 0; i < 5; i++) recordFailure(t);
    expect(isCircuitOpen(t)).toBe(true);
    vi.setSystemTime(new Date("2026-04-30T01:01:00Z"));
    expect(isCircuitOpen(t)).toBe(false);
  });

  it("a failure within the window after expiry doesn't immediately re-open the circuit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
    const t = opType("recover");
    for (let i = 0; i < 5; i++) recordFailure(t);
    vi.setSystemTime(new Date("2026-04-30T01:30:00Z"));
    expect(recordFailure(t)).toBe(false);
    expect(isCircuitOpen(t)).toBe(false);
  });
});

describe("decideRecovery", () => {
  it("does not retry once attemptCount has reached maxRecoveryAttempts", () => {
    const op = mkOp({
      attemptCount: 3,
      retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [1_000, 2_000, 3_000] },
    });
    const decision = decideRecovery(op, { committingCallsAlreadyMade: false, reason: "boom" });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain("3/3 exhausted");
    expect(decision.nextDelayMs).toBe(0);
  });

  it("does not retry when attemptCount exceeds max", () => {
    const op = mkOp({
      attemptCount: 5,
      retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [1_000, 2_000, 3_000] },
    });
    expect(decideRecovery(op, { committingCallsAlreadyMade: false, reason: "x" }).shouldRetry).toBe(false);
  });

  it("does not retry when committing tool calls have already executed", () => {
    const op = mkOp({ attemptCount: 0 });
    const decision = decideRecovery(op, { committingCallsAlreadyMade: true, reason: "x" });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain("side-effecting tool");
  });

  it("retries with the first backoff on the first attempt", () => {
    const op = mkOp({
      attemptCount: 0,
      retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000, 30_000, 120_000] },
    });
    const decision = decideRecovery(op, { committingCallsAlreadyMade: false, reason: "transient" });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.nextDelayMs).toBe(5_000);
    expect(decision.reason).toMatch(/retry 1\/3/);
  });

  it("uses the matching backoff bucket per attempt", () => {
    const policy: OpRetryPolicy = { maxRecoveryAttempts: 3, backoffMs: [5_000, 30_000, 120_000] };
    expect(decideRecovery(mkOp({ attemptCount: 1, retryPolicy: policy }), {
      committingCallsAlreadyMade: false, reason: "x",
    }).nextDelayMs).toBe(30_000);
    expect(decideRecovery(mkOp({ attemptCount: 2, retryPolicy: policy }), {
      committingCallsAlreadyMade: false, reason: "x",
    }).nextDelayMs).toBe(120_000);
  });

  it("clamps backoff index to the last entry when attempts overflow the array", () => {
    const op = mkOp({
      attemptCount: 1,
      retryPolicy: { maxRecoveryAttempts: 5, backoffMs: [10_000] },
    });
    const decision = decideRecovery(op, { committingCallsAlreadyMade: false, reason: "x" });
    expect(decision.nextDelayMs).toBe(10_000);
  });

  it("falls back to 5_000 when backoff array is empty", () => {
    const op = mkOp({
      attemptCount: 0,
      retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [] },
    });
    const decision = decideRecovery(op, { committingCallsAlreadyMade: false, reason: "x" });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.nextDelayMs).toBe(5_000);
  });

  it("treats undefined attemptCount as 0", () => {
    const op = mkOp();
    delete (op as any).attemptCount;
    const decision = decideRecovery(op, { committingCallsAlreadyMade: false, reason: "x" });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.reason).toMatch(/retry 1\//);
  });
});

describe("getRetryPolicy", () => {
  it("returns default policy for unknown op-types", () => {
    const p = getRetryPolicy("never-heard-of-it");
    expect(p.maxRecoveryAttempts).toBe(3);
    expect(p.backoffMs).toEqual([5_000, 30_000, 120_000]);
  });

  it("returns conservative single-attempt policy for send_email", () => {
    const p = getRetryPolicy("send_email");
    expect(p.maxRecoveryAttempts).toBe(1);
    expect(p.backoffMs).toEqual([10_000]);
  });

  it("returns 5-attempt policy for research_query (network-fragile)", () => {
    const p = getRetryPolicy("research_query");
    expect(p.maxRecoveryAttempts).toBe(5);
    expect(p.backoffMs).toHaveLength(5);
  });

  it("returns 2-attempt cautious policy for self_edit", () => {
    const p = getRetryPolicy("self_edit");
    expect(p.maxRecoveryAttempts).toBe(2);
    expect(p.backoffMs).toEqual([10_000, 60_000]);
  });

  it("returns 3-attempt build_app policy", () => {
    const p = getRetryPolicy("build_app");
    expect(p.maxRecoveryAttempts).toBe(3);
    expect(p.backoffMs[0]).toBe(30_000);
  });

  it("returns long-backoff memory_consolidation policy", () => {
    const p = getRetryPolicy("memory_consolidation");
    expect(p.maxRecoveryAttempts).toBe(5);
    expect(p.backoffMs[p.backoffMs.length - 1]).toBe(3_600_000);
  });
});
