import { describe, expect, it } from "vitest";
import type { ToolFailureEvent } from "../../tool-execution/tool-usage-telemetry.js";
import { clusterToolFailures, isRecurring, recurringFailures } from "./failure-patterns.js";

// Local noon, so "a day earlier" is a different calendar day in any timezone.
const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function fail(sessionId: string | undefined, agoMs: number, over: Partial<ToolFailureEvent["failure"]> = {}, tool = "bash"): ToolFailureEvent {
  return {
    at: NOW - agoMs, tool, status: "error", sessionId,
    failure: { signature: "sig-python", reason: "python3: command not found", opId: `op-${sessionId}-${agoMs}`, toolCallId: "c1", ...over },
  };
}

describe("clusterToolFailures", () => {
  it("counts one failure across chats and days, and keeps where to look", () => {
    const [pattern, ...rest] = clusterToolFailures([
      fail("s1", 3 * DAY), fail("s1", 3 * DAY - HOUR), fail("s2", 2 * DAY), fail("s3", HOUR),
    ], NOW);
    expect(rest).toEqual([]);
    expect(pattern).toMatchObject({
      signature: "sig-python", tool: "bash", status: "error", reason: "python3: command not found",
      count: 4, sessions: 3, days: 3, firstSeen: NOW - 3 * DAY, lastSeen: NOW - HOUR,
    });
    // Newest first, one per chat.
    expect(pattern.samples.map((s) => s.sessionId)).toEqual(["s3", "s2", "s1"]);
    expect(pattern.samples[0]).toEqual({ sessionId: "s3", at: NOW - HOUR, opId: `op-s3-${HOUR}`, toolCallId: "c1" });
  });

  it("keeps different failures apart and puts the most widespread first", () => {
    const patterns = clusterToolFailures([
      fail("s1", DAY, { signature: "sig-edit", reason: "old_string found 2 times" }, "edit"),
      fail("s1", DAY), fail("s2", DAY),
    ], NOW);
    expect(patterns.map((p) => [p.signature, p.sessions])).toEqual([["sig-python", 2], ["sig-edit", 1]]);
  });

  it("leaves out failures older than the window, with no chat, or from the harness's own runs", () => {
    const patterns = clusterToolFailures([
      fail("s1", 15 * DAY),
      fail(undefined, DAY),
      fail("dream-1762000000000-b0", DAY),
      fail("skill-review-1762000000000-0", DAY),
      fail("eval_abc", DAY),
    ], NOW);
    expect(patterns).toEqual([]);
  });

  it("counts a scheduled job's run and an app-builder chat: the user's own work", () => {
    const [pattern] = clusterToolFailures([fail("cron-nightly-1", DAY), fail("ide-app1", 2 * DAY)], NOW);
    expect(pattern.sessions).toBe(2);
  });

  it("does not sample a failure that has no run to open", () => {
    const [pattern] = clusterToolFailures([fail("s1", DAY, { opId: undefined })], NOW);
    expect(pattern.samples).toEqual([]);
    expect(pattern.count).toBe(1);
  });
});

describe("isRecurring", () => {
  const three = [fail("s1", 2 * DAY), fail("s2", DAY), fail("s3", HOUR)];

  it("is three chats on two days, seen in the last three days", () => {
    expect(recurringFailures(three, NOW)).toHaveLength(1);
  });

  it("is not two chats, however often", () => {
    expect(recurringFailures([fail("s1", 2 * DAY), fail("s1", DAY), fail("s2", HOUR), fail("s2", 2 * HOUR)], NOW)).toEqual([]);
  });

  it("is not three chats in one bad afternoon", () => {
    expect(recurringFailures([fail("s1", 3 * HOUR), fail("s2", 2 * HOUR), fail("s3", HOUR)], NOW)).toEqual([]);
  });

  it("stops being a problem once it stops happening", () => {
    const old = [fail("s1", 9 * DAY), fail("s2", 8 * DAY), fail("s3", 5 * DAY)];
    const [pattern] = clusterToolFailures(old, NOW);
    expect(isRecurring(pattern, NOW)).toBe(false);
  });
});
