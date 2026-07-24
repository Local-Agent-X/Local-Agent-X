/**
 * Heartbeat failure policy (worker-heartbeat.ts): transient lock contention
 * must NOT abort a healthy turn; a stolen claim must; sustained contention
 * eventually must; and late ticks (event-loop starvation) are logged.
 * Regression for the 2026-07-24 live failure where lease churn killed a
 * multi-minute browser turn mid-task.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startHeartbeat, stopHeartbeat } from "../src/canonical-loop/worker-heartbeat.js";
import { setLeaseConfig, resetLeaseConfig, type LeaseClaim } from "../src/canonical-loop/lease.js";

const INTERVAL = 10_000;
const DURATION = 30_000;
const claim: LeaseClaim = { owner: "w-hb-test", generation: 1 };

type Beat = { ok: true } | { ok: false; reason: "unknown_op" | "claim_lost" | "lock_unavailable" | "persistence_failed" };

function beatSequence(results: Beat[]): () => Beat {
  let i = 0;
  return () => results[Math.min(i++, results.length - 1)];
}

describe("worker heartbeat failure policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLeaseConfig({ leaseDurationMs: DURATION, heartbeatIntervalMs: INTERVAL });
  });

  afterEach(() => {
    stopHeartbeat("w-unit");
    resetLeaseConfig();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a single lock_unavailable is transient — no fatal, beating continues", () => {
    const onFatal = vi.fn();
    const beats = vi.fn(beatSequence([{ ok: false, reason: "lock_unavailable" }, { ok: true }, { ok: true }]));
    startHeartbeat("op-1", "w-unit", claim, onFatal, beats as never);

    vi.advanceTimersByTime(INTERVAL * 3);
    expect(onFatal).not.toHaveBeenCalled();
    expect(beats).toHaveBeenCalledTimes(3); // still alive after the transient
  });

  it("a success resets the transient counter", () => {
    const onFatal = vi.fn();
    // fail, fail, ok, fail, fail — never 3 consecutive → never fatal
    const beats = vi.fn(beatSequence([
      { ok: false, reason: "lock_unavailable" },
      { ok: false, reason: "persistence_failed" },
      { ok: true },
      { ok: false, reason: "lock_unavailable" },
      { ok: false, reason: "lock_unavailable" },
    ]));
    startHeartbeat("op-2", "w-unit", claim, onFatal, beats as never);

    vi.advanceTimersByTime(INTERVAL * 5);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("3 consecutive transient failures are fatal, exactly once, and stop the timer", () => {
    const onFatal = vi.fn();
    const beats = vi.fn(beatSequence([{ ok: false, reason: "lock_unavailable" }]));
    startHeartbeat("op-3", "w-unit", claim, onFatal, beats as never);

    vi.advanceTimersByTime(INTERVAL * 6);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(beats).toHaveBeenCalledTimes(3); // timer cleared at the fatal tick
  });

  it("claim_lost is immediately fatal", () => {
    const onFatal = vi.fn();
    const beats = vi.fn(beatSequence([{ ok: false, reason: "claim_lost" }]));
    startHeartbeat("op-4", "w-unit", claim, onFatal, beats as never);

    vi.advanceTimersByTime(INTERVAL);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(beats).toHaveBeenCalledTimes(1);
  });

  it("a late tick logs the event-loop starvation warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onFatal = vi.fn();
    startHeartbeat("op-5", "w-unit", claim, onFatal, (() => ({ ok: true })) as never);

    // Stall the clock 15s past schedule, then let the tick fire: the callback
    // observes a gap of interval+15s → warn tier (below lease-expiry tier).
    vi.setSystemTime(Date.now() + 15_000);
    vi.advanceTimersByTime(INTERVAL);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("heartbeat late by"));
    expect(onFatal).not.toHaveBeenCalled();
  });
});
