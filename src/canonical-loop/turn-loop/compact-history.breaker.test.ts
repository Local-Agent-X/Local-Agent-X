// Circuit-breaker behavior of compactHistory: trip on consecutive enabled-null
// summarize results, skip while tripped, and the cool-down that probes every
// PROBE_INTERVAL-th skipped call so a transient outage doesn't disable
// summarization for a long-lived op's whole life. Split from
// compact-history.test.ts to keep both files under the repo file-size limit.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../context-manager/status.js", () => ({ getContextStatus: vi.fn() }));
vi.mock("../../context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn() }));

const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ createLogger: () => loggerMock }));

import { compactHistory, compactionBreakerState } from "./compact-history.js";
import { getContextStatus } from "../../context-manager/status.js";
import { summarizeOldMessages } from "../../context-manager/compaction.js";
import type { CanonicalMessage } from "../contract-types.js";

const mockStatus = vi.mocked(getContextStatus);
const mockSummarize = vi.mocked(summarizeOldMessages);

const u = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "user", content: { text } });
const a = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "assistant", content: { text } });

const status = (percentage: number, shouldCompact: boolean) =>
  ({ usedTokens: 1, maxTokens: 1, percentage, level: "compact" as const, shouldCompact, forceCompact: false });

// Enough history to compact: keepLast=4 at 96%, split lands on u3 (idx 4).
const compactable = () => [
  u("u1", "q1"), a("a1", "r1"), u("u2", "q2"), a("a2", "r2"),
  u("u3", "q3"), a("a3", "r3"), u("u4", "q4"), a("a4", "r4"),
];
const MODEL = "claude-sonnet-4-6";

// Drive an op to the tripped state: 3 consecutive enabled-null attempts.
async function trip(opId: string): Promise<void> {
  mockStatus.mockReturnValue(status(96, true));
  mockSummarize.mockResolvedValue(null);
  for (let i = 0; i < 3; i++) await compactHistory(compactable(), MODEL, null, opId);
  expect(compactionBreakerState(opId)?.tripped).toBe(true);
}

beforeEach(() => {
  mockStatus.mockReset();
  mockSummarize.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.error.mockReset();
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("compactHistory — circuit breaker", () => {
  it("trips after 3 consecutive failed attempts: 4th call makes NO summarize attempt, error logged once", async () => {
    const opId = "op-breaker-trip";
    mockStatus.mockReturnValue(status(96, true));
    mockSummarize.mockResolvedValue(null);

    for (let i = 0; i < 3; i++) await compactHistory(compactable(), MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(3);
    expect(compactionBreakerState(opId)).toEqual({ failures: 3, tripped: true, skipsSinceTrip: 0 });
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.error.mock.calls[0][0]).toContain(opId);

    // Tripped: skips the attempt entirely, returns the view unmodified, no new error log.
    const msgs = compactable();
    const out = await compactHistory(msgs, MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(3);
    expect(out.messages).toBe(msgs);
    expect(out.compacted).toBe(false);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.debug).toHaveBeenCalled();
  });

  it("a success resets the consecutive-failure count", async () => {
    const opId = "op-breaker-reset";
    mockStatus.mockReturnValue(status(96, true));

    mockSummarize.mockResolvedValueOnce(null);
    await compactHistory(compactable(), MODEL, null, opId);
    expect(compactionBreakerState(opId)).toEqual({ failures: 1, tripped: false, skipsSinceTrip: 0 });

    mockSummarize.mockResolvedValueOnce("SUMMARY");
    const ok = await compactHistory(compactable(), MODEL, null, opId);
    expect(ok.compacted).toBe(true);
    expect(compactionBreakerState(opId)).toBeUndefined();
    // Not a probe recovery — the entry never tripped — so no recovery info.
    expect(loggerMock.info).not.toHaveBeenCalled();

    // Later failures start from 0: two more nulls do NOT trip.
    mockSummarize.mockResolvedValue(null);
    await compactHistory(compactable(), MODEL, null, opId);
    await compactHistory(compactable(), MODEL, null, opId);
    expect(compactionBreakerState(opId)).toEqual({ failures: 2, tripped: false, skipsSinceTrip: 0 });
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(mockSummarize).toHaveBeenCalledTimes(4);
  });

  it("kill-switch-disabled nulls never count — breaker never trips under env off", async () => {
    const opId = "op-breaker-killswitch";
    vi.stubEnv("LAX_LLM_COMPACTION", "0");
    mockStatus.mockReturnValue(status(96, true));
    mockSummarize.mockResolvedValue(null);

    for (let i = 0; i < 5; i++) await compactHistory(compactable(), MODEL, null, opId);
    // Every call still attempts (well, reaches the summarizer seam) — nothing counted.
    expect(mockSummarize).toHaveBeenCalledTimes(5);
    expect(compactionBreakerState(opId)).toBeUndefined();
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it("structural no-ops never touch the counter", async () => {
    const opId = "op-breaker-noop";
    mockStatus.mockReturnValue(status(96, true));
    mockSummarize.mockResolvedValue(null);
    await compactHistory(compactable(), MODEL, null, opId);
    await compactHistory(compactable(), MODEL, null, opId);
    expect(compactionBreakerState(opId)).toEqual({ failures: 2, tripped: false, skipsSinceTrip: 0 });

    // Under threshold: no attempt, counter unchanged.
    mockStatus.mockReturnValue(status(10, false));
    await compactHistory(compactable(), MODEL, null, opId);
    expect(compactionBreakerState(opId)).toEqual({ failures: 2, tripped: false, skipsSinceTrip: 0 });

    // Over threshold but no safe split point (too little history): unchanged too.
    mockStatus.mockReturnValue(status(96, true));
    await compactHistory([u("u1", "q1"), a("a1", "r1")], MODEL, null, opId);
    expect(compactionBreakerState(opId)).toEqual({ failures: 2, tripped: false, skipsSinceTrip: 0 });
    expect(mockSummarize).toHaveBeenCalledTimes(2);
  });

  it("breakers are per-op: op A tripped, op B still attempts", async () => {
    mockStatus.mockReturnValue(status(96, true));
    mockSummarize.mockResolvedValue(null);
    for (let i = 0; i < 3; i++) await compactHistory(compactable(), MODEL, null, "op-A");
    expect(compactionBreakerState("op-A")?.tripped).toBe(true);

    const calls = mockSummarize.mock.calls.length;
    await compactHistory(compactable(), MODEL, null, "op-B");
    expect(mockSummarize.mock.calls.length).toBe(calls + 1);
    expect(compactionBreakerState("op-B")).toEqual({ failures: 1, tripped: false, skipsSinceTrip: 0 });
  });

  it("no opId → breaker bypassed, attempts keep happening", async () => {
    mockStatus.mockReturnValue(status(96, true));
    mockSummarize.mockResolvedValue(null);
    for (let i = 0; i < 5; i++) await compactHistory(compactable(), MODEL);
    expect(mockSummarize).toHaveBeenCalledTimes(5);
    expect(loggerMock.error).not.toHaveBeenCalled();
  });
});

describe("compactHistory — circuit breaker cool-down probes", () => {
  it("tripped op skips calls 1-9; the 10th eligible call runs exactly one probe attempt", async () => {
    const opId = "op-cooldown-window";
    await trip(opId);
    expect(mockSummarize).toHaveBeenCalledTimes(3);

    for (let i = 0; i < 9; i++) await compactHistory(compactable(), MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(3); // calls 1-9: cheap skip
    expect(compactionBreakerState(opId)).toEqual({ failures: 3, tripped: true, skipsSinceTrip: 9 });

    await compactHistory(compactable(), MODEL, null, opId); // 10th: probe
    expect(mockSummarize).toHaveBeenCalledTimes(4);
  });

  it("a failed probe re-trips immediately: windows repeat, no new error log ever", async () => {
    const opId = "op-cooldown-refail";
    await trip(opId);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);

    // First window: 9 skips + failing probe on the 10th → re-tripped, window restarts.
    for (let i = 0; i < 10; i++) await compactHistory(compactable(), MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(4);
    expect(compactionBreakerState(opId)).toEqual({ failures: 4, tripped: true, skipsSinceTrip: 0 });

    // Second window behaves identically: 9 skips, then the 20th call probes.
    for (let i = 0; i < 9; i++) await compactHistory(compactable(), MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(4);
    await compactHistory(compactable(), MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(5);

    expect(loggerMock.error).toHaveBeenCalledTimes(1); // only the initial trip, across everything
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it("a successful probe fully resets: recovery info once, a later single failure does NOT re-trip", async () => {
    const opId = "op-cooldown-recover";
    await trip(opId);

    for (let i = 0; i < 9; i++) await compactHistory(compactable(), MODEL, null, opId);
    mockSummarize.mockResolvedValueOnce("SUMMARY");
    const out = await compactHistory(compactable(), MODEL, null, opId); // probe succeeds
    expect(out.compacted).toBe(true);
    expect(compactionBreakerState(opId)).toBeUndefined();
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    expect(loggerMock.info.mock.calls[0][0]).toContain("recovered");
    expect(loggerMock.info.mock.calls[0][0]).toContain(opId);

    // Back to failing: one enabled-null neither trips nor skips — needs 3 fresh failures.
    mockSummarize.mockResolvedValue(null);
    await compactHistory(compactable(), MODEL, null, opId);
    expect(compactionBreakerState(opId)).toEqual({ failures: 1, tripped: false, skipsSinceTrip: 0 });
    await compactHistory(compactable(), MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(6); // 3 trip + 1 probe + 2 post-reset attempts
    expect(loggerMock.error).toHaveBeenCalledTimes(1); // still only the original trip
  });

  it("a probe call that turns out unneeded is a no-op: window not consumed, breaker not reset", async () => {
    const opId = "op-cooldown-park";
    await trip(opId);
    for (let i = 0; i < 9; i++) await compactHistory(compactable(), MODEL, null, opId);
    expect(compactionBreakerState(opId)?.skipsSinceTrip).toBe(9);

    // 10th eligible call is under threshold: full path runs but no summarize
    // attempt happens — neither resets nor re-trips, window stays parked.
    mockStatus.mockReturnValue(status(10, false));
    await compactHistory(compactable(), MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(3);
    expect(compactionBreakerState(opId)).toEqual({ failures: 3, tripped: true, skipsSinceTrip: 9 });

    // Same parking when over threshold but nothing is safe to split.
    mockStatus.mockReturnValue(status(96, true));
    await compactHistory([u("u1", "q1"), a("a1", "r1")], MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(3);
    expect(compactionBreakerState(opId)).toEqual({ failures: 3, tripped: true, skipsSinceTrip: 9 });

    // Next eligible call probes immediately — the window wasn't burned.
    await compactHistory(compactable(), MODEL, null, opId);
    expect(mockSummarize).toHaveBeenCalledTimes(4);
  });
});
