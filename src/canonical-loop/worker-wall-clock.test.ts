// Time an op spends inside a tool that may run as long as it needs is a wait
// on other work, not the op turning: it is not spent from the wall clock. A
// lead that drives a build from one turn (build_next) waits for hours; the
// two-hour chat deadline is for a turn that spins.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { armWallClock, timeUnboundedTools, unboundedToolMs, wallClockSpentMs } from "./worker-wall-clock.js";
import type { Adapter } from "./adapter-contract.js";

const HOUR = 60 * 60_000;
const wait = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-27T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

function adapterSpy(): { adapter: Adapter; aborted: () => number } {
  let aborts = 0;
  return { adapter: { abort: async () => { aborts++; } } as unknown as Adapter, aborted: () => aborts };
}

describe("the wall clock and unbounded tools", () => {
  it("does not count a wait inside build_next, while it runs or after", async () => {
    const drivingSince = Date.now();
    const running = timeUnboundedTools("op-a", [{ tool: "build_next" }], wait(3 * HOUR));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(unboundedToolMs("op-a")).toBe(HOUR);
    expect(wallClockSpentMs("op-a", drivingSince)).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    await running;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(wallClockSpentMs("op-a", drivingSince)).toBe(10 * 60_000);
  });

  it("counts every other tool's time as the op's own", async () => {
    const drivingSince = Date.now();
    const running = timeUnboundedTools("op-b", [{ tool: "bash" }, { tool: "read" }], wait(HOUR));
    await vi.advanceTimersByTimeAsync(HOUR);
    await running;
    expect(wallClockSpentMs("op-b", drivingSince)).toBe(HOUR);
  });

  it("the deadline timer does not fire for a turn that only waited, and fires once the budget is spent", async () => {
    const { adapter, aborted } = adapterSpy();
    let expired = 0;
    const drivingSince = Date.now();
    const timer = armWallClock(adapter, 2 * HOUR, () => { expired++; }, { opId: "op-c", drivingSince });
    const running = timeUnboundedTools("op-c", [{ tool: "build_next" }], wait(5 * HOUR));
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    await running;
    expect(expired).toBe(0);
    // Now the op turns on its own for its two hours.
    await vi.advanceTimersByTimeAsync(2 * HOUR + 2_000);
    expect(expired).toBe(1);
    expect(aborted()).toBe(1);
    timer.clear();
  });

  it("a turn that spins with no unbounded tool still hits its deadline on time", async () => {
    const { adapter } = adapterSpy();
    let expired = 0;
    const timer = armWallClock(adapter, 2 * HOUR, () => { expired++; }, { opId: "op-d", drivingSince: Date.now() });
    await vi.advanceTimersByTimeAsync(2 * HOUR - 1);
    expect(expired).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toBe(1);
    timer.clear();
  });
});
