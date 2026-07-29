/**
 * JobScheduler overlap policy.
 *
 * The scheduler used to be a bare setInterval: a job whose async run() outlived
 * its interval simply re-fired and the runs piled up on the same provider key /
 * DB / embedding CPU. skill-review (5min cadence, passes observed past
 * 300000ms) hand-rolled its own flag to survive that; the guard now lives here
 * so every registered job gets it and there is one implementation of it.
 *
 * The second half of the policy is the exception: a job whose repeated tick IS
 * its recovery mechanism must NOT be latched shut. dream-check is that job —
 * see OverlapPolicy in scheduler.ts and JOB_OVERLAP in background-jobs/index.ts.
 *
 * Fake timers only — these assert tick arithmetic, never wall clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobScheduler, type OverlapGuard } from "./scheduler.js";
import { JOB_OVERLAP } from "./background-jobs/index.js";

// A stalled slot must be reportable at the DEFAULT log level, so the assertion
// has to see the level the scheduler chose — not whatever LAX_LOG_LEVEL the
// runner happens to carry. Mock the logger rather than sniff console.
const { log } = vi.hoisted(() => {
  const rec = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => rec };
  return { log: rec };
});
vi.mock("../logger.js", () => ({ createLogger: () => log }));

/** Externally-settled promise, so a test decides exactly when a run finishes. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A run that hangs until the test releases it, one fresh gate per call. */
function gatedRun(): { run: () => Promise<void>; gates: ReturnType<typeof deferred>[] } {
  const gates: ReturnType<typeof deferred>[] = [];
  return {
    gates,
    run: () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  };
}

describe("JobScheduler overlap guard", () => {
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    log.debug.mockClear();
    log.info.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
    scheduler = new JobScheduler();
  });

  afterEach(() => {
    scheduler.stopAll();
    vi.useRealTimers();
  });

  it("fires once while a run outlives its interval, then resumes on a later tick", async () => {
    const { run, gates } = gatedRun();
    const spy = vi.fn(run);
    scheduler.register({ name: "slow", intervalMs: 100, run: spy });

    // Four intervals elapse while the first run is still going.
    await vi.advanceTimersByTimeAsync(450);
    expect(spy, "a slow run must swallow the ticks it overlaps, not stack them").toHaveBeenCalledTimes(1);

    gates[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(spy, "the job must resume on the next tick after it finishes").toHaveBeenCalledTimes(2);
  });

  it("suppresses the first interval tick while the startup run is still going", async () => {
    const { run, gates } = gatedRun();
    const spy = vi.fn(run);
    scheduler.register({ name: "slow-start", intervalMs: 100, startupDelayMs: 50, run: spy });

    // Startup fires at 50 and hangs; the interval ticks at 100 and 200 land on it.
    await vi.advanceTimersByTimeAsync(250);
    expect(spy, "the startup timer and the interval share one slot").toHaveBeenCalledTimes(1);

    gates[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not wedge the slot when a run rejects or throws synchronously", async () => {
    const rejecting = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom again"))
      .mockResolvedValue(undefined);
    const throwing = vi.fn(() => { throw new Error("sync boom"); });
    scheduler.register({ name: "rejects", intervalMs: 100, run: rejecting });
    scheduler.register({ name: "throws", intervalMs: 100, run: throwing });

    await vi.advanceTimersByTimeAsync(350);
    expect(rejecting, "a rejected run must release the slot in a finally").toHaveBeenCalledTimes(3);
    expect(throwing, "a synchronous throw must release the slot too").toHaveBeenCalledTimes(3);
  });

  it("releases the slot when shouldRun gates the tick or throws", async () => {
    let allow = false;
    const gated = vi.fn().mockResolvedValue(undefined);
    scheduler.register({ name: "gated", intervalMs: 100, shouldRun: () => allow, run: gated });

    const exploding = vi.fn(() => { throw new Error("gate exploded"); });
    const neverRuns = vi.fn().mockResolvedValue(undefined);
    scheduler.register({ name: "bad-gate", intervalMs: 100, shouldRun: exploding, run: neverRuns });

    await vi.advanceTimersByTimeAsync(100);
    expect(gated).not.toHaveBeenCalled();

    allow = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(gated, "a false shouldRun must not hold the slot shut").toHaveBeenCalledTimes(2);
    expect(exploding, "a throwing shouldRun must not hold the slot shut").toHaveBeenCalledTimes(3);
    expect(neverRuns).not.toHaveBeenCalled();
  });

  it("keeps one slot per registration, not per job name", async () => {
    const { run } = gatedRun();
    const slow = vi.fn(run);
    const fast = vi.fn().mockResolvedValue(undefined);
    scheduler.register({ name: "dup", intervalMs: 100, run: slow });
    scheduler.register({ name: "dup", intervalMs: 100, run: fast });

    await vi.advanceTimersByTimeAsync(350);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast, "a name collision must not let one job starve another").toHaveBeenCalledTimes(3);
  });

  it("stops cleanly with a run in flight and can be re-registered after", async () => {
    const { run, gates } = gatedRun();
    const spy = vi.fn(run);
    scheduler.register({ name: "shutdown", intervalMs: 100, run: spy });

    await vi.advanceTimersByTimeAsync(100);
    expect(spy).toHaveBeenCalledTimes(1);

    scheduler.stopAll();
    await vi.advanceTimersByTimeAsync(500);
    expect(spy, "no tick may survive stopAll").toHaveBeenCalledTimes(1);

    // Re-register while the abandoned run is STILL unsettled. A scheduler-wide
    // latch would be held by it and starve this registration for good; only a
    // per-registration latch lets the new job tick. Settling the old run first
    // (as an earlier version of this test did) releases ANY implementation's
    // latch and proves nothing.
    scheduler.register({ name: "shutdown", intervalMs: 100, run: spy });
    await vi.advanceTimersByTimeAsync(100);
    expect(spy, "shutdown must not leave a latch held for the next registration").toHaveBeenCalledTimes(2);

    // The abandoned run unwinding after shutdown is caught, not unhandled.
    gates[0].reject(new Error("died during shutdown"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("keeps invoking a self-guarded job whose run has not settled", async () => {
    const { run } = gatedRun();
    const spy = vi.fn(run);
    scheduler.register({ name: "dreamlike", intervalMs: 100, overlap: "self-guarded", run: spy });

    // The first run never settles. A self-guarded job owns its own exclusion
    // and its repeated INVOCATION is the recovery path (dream-check's 30-minute
    // stuck-lock force-release lives inside the runner) — so the scheduler must
    // keep calling it rather than deciding on its behalf.
    await vi.advanceTimersByTimeAsync(350);
    expect(spy, "a self-guarded job must still be invoked while an earlier run hangs").toHaveBeenCalledTimes(3);
  });

  it("reports a wedged slot at warn once, not only at debug", async () => {
    const { run } = gatedRun();
    scheduler.register({ name: "wedged", intervalMs: 100, run: vi.fn(run) });

    // Run claims the slot at t=100. The skips at 200 and 300 are routine.
    await vi.advanceTimersByTimeAsync(300);
    const stalls = () => log.warn.mock.calls.filter((c) => String(c[0]).includes("[wedged]"));
    expect(stalls(), "a couple of swallowed ticks is normal and must stay quiet").toHaveLength(0);
    expect(log.debug.mock.calls.length, "routine skips are still traceable at debug").toBeGreaterThan(0);

    // By t=500 the run has held the slot for 4 intervals — it is not slow, it
    // is wedged, and a `skip` job that never settles is dead until restart.
    await vi.advanceTimersByTimeAsync(300);
    expect(stalls(), "a run that never settles must be visible at the default log level").toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(stalls(), "one warning per stall, not one per tick").toHaveLength(1);
  });
});

describe("registered background jobs declare an overlap policy", () => {
  // JOB_OVERLAP is not documentation: every scheduler.register call in
  // background-jobs/index.ts spreads its policy out of this map, and the map is
  // typed by RegisteredJobName, so a new job cannot be registered without
  // declaring one.
  it("marks dream-check self-guarded and every other job skip", () => {
    expect(
      JOB_OVERLAP["dream-check"],
      "dream-check's 30-minute stuck-lock recovery lives in shouldDream(), reachable only when a later tick actually invokes the runner",
    ).toBe("self-guarded");

    const others = Object.entries(JOB_OVERLAP).filter(([name]) => name !== "dream-check");
    expect(
      others.map(([name, policy]) => `${name}=${policy}`),
      "every other registered job reconciles single-writer state: a dropped tick is free, a concurrent one races",
    ).toEqual(others.map(([name]) => `${name}=skip`));
    expect(Object.keys(JOB_OVERLAP), "all seven registered jobs are enumerated").toHaveLength(7);
  });
});

describe("skill-review shares the scheduler's latch", () => {
  afterEach(() => {
    vi.doUnmock("./scheduler.js");
    vi.resetModules();
  });

  it("consults the guard createOverlapGuard minted, not a private flag", async () => {
    const minted: OverlapGuard[] = [];
    vi.resetModules();
    vi.doMock("./scheduler.js", async () => {
      const actual = await vi.importActual<typeof import("./scheduler.js")>("./scheduler.js");
      return {
        ...actual,
        createOverlapGuard: () => {
          const guard = actual.createOverlapGuard();
          minted.push(guard);
          return guard;
        },
      };
    });

    const sr = await import("./background-jobs/skill-review.js");
    expect(minted, "skill-review must take its latch from the scheduler at module init").toHaveLength(1);

    // A truthy deps object only gets the pass past its no-runner gate; nothing
    // below reads a field, so no model call can be reached from here.
    sr.registerSkillReviewRunner({} as never);
    try {
      // Hold the SCHEDULER's latch from outside. A private boolean inside
      // skill-review would be untouched by this and the pass would proceed.
      minted[0].tryEnter();
      expect(await sr.runSkillReviewPass()).toMatchObject({ skipped: true, reason: "in-flight" });

      minted[0].release();
      expect(await sr.runSkillReviewPass()).toMatchObject({ skipped: false, reason: "empty" });
    } finally {
      sr._resetSkillReviewQueue();
    }
  });
});
