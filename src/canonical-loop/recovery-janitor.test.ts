import { describe, expect, it, vi } from "vitest";
import {
  RecoveryJanitor,
  startRecoveryJanitor,
  stopRecoveryJanitor,
} from "./recovery-janitor.js";
import { sweepStaleCanonicalOpsCooperatively } from "./recovery.js";
import type { Op } from "../ops/types.js";

type Timer = ReturnType<typeof setTimeout>;

function timerHarness() {
  const pending: Array<{ callback: () => void; timer: Timer }> = [];
  const cleared: Timer[] = [];
  let unrefCount = 0;
  const setTimer = (callback: () => void, _delayMs: number): Timer => {
    const timer = { unref: () => { unrefCount += 1; } } as unknown as Timer;
    pending.push({ callback, timer });
    return timer;
  };
  const clearTimer = (timer: Timer): void => {
    cleared.push(timer);
    const index = pending.findIndex((entry) => entry.timer === timer);
    if (index >= 0) pending.splice(index, 1);
  };
  const fireNext = (): void => {
    const entry = pending.shift();
    if (!entry) throw new Error("No timer scheduled");
    entry.callback();
  };
  return { pending, cleared, setTimer, clearTimer, fireNext, unrefCount: () => unrefCount };
}

describe("RecoveryJanitor", () => {
  it("starts once, unreferences its timer, and stops cleanly", () => {
    const timers = timerHarness();
    const janitor = new RecoveryJanitor({
      intervalMs: 25,
      sweep: vi.fn(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    janitor.start();
    janitor.start();

    expect(janitor.isStarted()).toBe(true);
    expect(timers.pending).toHaveLength(1);
    expect(timers.unrefCount()).toBe(1);

    janitor.stop();
    expect(janitor.isStarted()).toBe(false);
    expect(timers.pending).toHaveLength(0);
    expect(timers.cleared).toHaveLength(1);
  });

  it("yields during many slow candidates so heartbeat timers keep running", async () => {
    const opIds = Array.from({ length: 80 }, (_, index) => `slow-${index}`);
    let heartbeatTicks = 0;
    let recoveries = 0;
    const heartbeat = setInterval(() => { heartbeatTicks += 1; }, 1);

    try {
      const outcomes = await sweepStaleCanonicalOpsCooperatively({
        listOpIds: () => opIds,
        batchSize: opIds.length,
        timeSliceMs: 5,
        readCandidate: () => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < 2) { /* simulate a slow disk read */ }
          return { canonical: { flagValue: true, state: "running" } } as Op;
        },
        recoverCandidate: () => {
          recoveries += 1;
          return { ok: false, kind: "lease_fresh" };
        },
      });

      expect(recoveries).toBe(opIds.length);
      expect(outcomes).toEqual([]);
      expect(heartbeatTicks).toBeGreaterThan(0);
    } finally {
      clearInterval(heartbeat);
    }
  });

  it("never overlaps a sweep and schedules the next tick after completion", async () => {
    const timers = timerHarness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sweep = vi.fn(() => blocked);
    const janitor = new RecoveryJanitor({
      intervalMs: 25,
      sweep,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    janitor.start();
    timers.fireNext();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));

    expect(await janitor.sweepNow()).toBe(false);
    expect(timers.pending).toHaveLength(0);

    release();
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    janitor.stop();
  });

  it("reuses in-flight coordination when stopped and restarted", async () => {
    const timers = timerHarness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sweep = vi.fn()
      .mockImplementationOnce(() => blocked)
      .mockResolvedValue(undefined);
    const original = startRecoveryJanitor({
      intervalMs: 25,
      sweep,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    timers.fireNext();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
    stopRecoveryJanitor();

    const restarted = startRecoveryJanitor();
    expect(restarted).toBe(original);
    timers.fireNext();
    await Promise.resolve();
    expect(sweep).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    timers.fireNext();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(2));
    stopRecoveryJanitor();
  });

  it("continues scheduling after an individual sweep failure", async () => {
    const timers = timerHarness();
    const failure = new Error("disk unavailable");
    const sweep = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const janitor = new RecoveryJanitor({
      intervalMs: 25,
      sweep,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onError,
    });

    janitor.start();
    timers.fireNext();
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    expect(onError).toHaveBeenCalledWith(failure);

    timers.fireNext();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    janitor.stop();
  });
});
