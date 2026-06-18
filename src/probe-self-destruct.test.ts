// Regression: leaked self_edit/update bind probes accumulated forever (12 on
// the dev box, back to June 12) because killProbe only runs if the gate-runner
// survives — a force-killed runner orphans the probe and Windows never reaps it.
// The fix makes the probe self-terminate. These pin both triggers (parent gone,
// max-lifetime backstop) and the once-only guard.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installProbeSelfDestruct } from "./probe-self-destruct.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("installProbeSelfDestruct", () => {
  it("terminates on the next poll once the parent process is gone", () => {
    const onTerminate = vi.fn();
    installProbeSelfDestruct({ parentPid: 4242, maxLifetimeMs: 600_000, intervalMs: 5000, isParentAlive: () => false, onTerminate });
    expect(onTerminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate.mock.calls[0][0]).toMatch(/parent 4242 gone/);
  });

  it("stays alive while the parent lives, then hits the max-lifetime backstop", () => {
    const onTerminate = vi.fn();
    installProbeSelfDestruct({ parentPid: 4242, maxLifetimeMs: 600_000, intervalMs: 5000, isParentAlive: () => true, onTerminate });
    vi.advanceTimersByTime(599_000);
    expect(onTerminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate.mock.calls[0][0]).toMatch(/max lifetime/);
  });

  it("fires exactly once even when parent-death and max-lifetime coincide", () => {
    const onTerminate = vi.fn();
    installProbeSelfDestruct({ parentPid: 4242, maxLifetimeMs: 5000, intervalMs: 5000, isParentAlive: () => false, onTerminate });
    vi.advanceTimersByTime(60_000);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("with an unknown parent PID, skips the parent check but still self-destructs on the backstop", () => {
    const onTerminate = vi.fn();
    installProbeSelfDestruct({ parentPid: NaN, maxLifetimeMs: 10_000, intervalMs: 5000, isParentAlive: () => false, onTerminate });
    vi.advanceTimersByTime(8000);
    expect(onTerminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate.mock.calls[0][0]).toMatch(/max lifetime/);
  });

  it("default parent-liveness probe reports the current process as alive", () => {
    const onTerminate = vi.fn();
    installProbeSelfDestruct({ parentPid: process.pid, maxLifetimeMs: 600_000, intervalMs: 5000, onTerminate });
    vi.advanceTimersByTime(30_000);
    expect(onTerminate).not.toHaveBeenCalled();
  });
});
