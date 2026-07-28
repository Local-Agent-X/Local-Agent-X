// Regression: the server froze its event loop for 90-110s, 182 times, and no
// log line named the blocker — a blocked process emits nothing. These pin the
// sentinel's whole contract: silence when healthy, a loud snapshot past
// threshold 1, and a rate-limited profile past threshold 2. Clock, logger,
// snapshot and profiler are all injected, so nothing here sleeps, spins a real
// timer, touches the filesystem, or opens an inspector session.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEventLoopSentinel,
  collectStallSnapshot,
  pruneOldStallProfiles,
  type StallSnapshot,
} from "./event-loop-sentinel.js";

const INTERVAL = 500;
const WARN = 5_000;
const PROFILE = 30_000;
const COOLDOWN = 600_000;

function harness(overrides: Parameters<typeof createEventLoopSentinel>[0] = {}) {
  let clock = 1_000_000;
  const log = { warn: vi.fn(), error: vi.fn() };
  const captureProfile = vi.fn((lagMs: number) => `profile-${lagMs}.cpuprofile`);
  const collectSnapshot = vi.fn((lagMs: number): StallSnapshot => ({
    lagMs,
    handles: { Socket: 2 },
    requests: {},
    memoryMb: { rss: 100, heapUsed: 50, heapTotal: 80, external: 5 },
    activeTurns: [{ sessionId: "s1", elapsedMs: 1234, iteration: 3, lastToolName: "bash" }],
  }));
  const sentinel = createEventLoopSentinel({
    now: () => clock,
    logger: log,
    intervalMs: INTERVAL,
    warnMs: WARN,
    profileMs: PROFILE,
    profileEnabled: true,
    profileCooldownMs: COOLDOWN,
    collectSnapshot,
    captureProfile,
    ...overrides,
  });
  /** Let `ms` of wall-clock pass, then take one sample. */
  const advanceAndTick = (ms: number) => { clock += ms; sentinel.tick(); };
  return { log, captureProfile, collectSnapshot, sentinel, advanceAndTick };
}

describe("event-loop sentinel — healthy loop is silent and free", () => {
  it("logs nothing when samples land on time", () => {
    const { log, collectSnapshot, advanceAndTick } = harness();
    for (let i = 0; i < 20; i++) advanceAndTick(INTERVAL);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    // No snapshot means no allocation on the healthy path.
    expect(collectSnapshot).not.toHaveBeenCalled();
  });

  it("tolerates ordinary timer jitter without logging", () => {
    const { log, advanceAndTick } = harness();
    for (const jitter of [3, 40, 120, 900, 1_800]) advanceAndTick(INTERVAL + jitter);
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("event-loop sentinel — lag calculation", () => {
  // The scheduled interval is NOT lag. A sample 5,400ms after the last one is
  // only 4,900ms late, which is under the 5,000ms threshold. Drop the
  // `- intervalMs` term and this case starts firing.
  it("subtracts the scheduled interval, so 5400ms elapsed is 4900ms of lag", () => {
    const { log, advanceAndTick } = harness();
    advanceAndTick(5_400);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("fires at the threshold and reports lag, not elapsed time", () => {
    const { log, collectSnapshot, advanceAndTick } = harness();
    advanceAndTick(5_600);
    expect(collectSnapshot).toHaveBeenCalledWith(5_100);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toContain("event loop blocked for 5100ms");
  });

  it("measures from the previous sample, so consecutive stalls each report their own lag", () => {
    const { log, advanceAndTick } = harness();
    advanceAndTick(10_500); // lag 10_000
    advanceAndTick(20_500); // lag 20_000 — not cumulative
    const lags = log.error.mock.calls.map((c) => /blocked for (\d+)ms/.exec(String(c[0]))?.[1]);
    expect(lags).toEqual(["10000", "20000"]);
  });
});

describe("event-loop sentinel — threshold 1 snapshot", () => {
  it("names what the process was holding when the loop came back", () => {
    const { log, advanceAndTick } = harness();
    advanceAndTick(90_000 + INTERVAL);
    const line = String(log.error.mock.calls[0][0]);
    expect(line).toContain("event loop blocked for 90000ms");
    expect(line).toContain('"handles":{"Socket":2}');
    expect(line).toContain('"sessionId":"s1"');
    expect(line).toContain('"lastToolName":"bash"');
    // The stall is invisible in the logs while it happens; the line must say so.
    expect(line).toContain("nothing could be logged while it was blocked");
  });

  it("does not profile a stall that only crosses threshold 1", () => {
    const { log, captureProfile, advanceAndTick } = harness();
    advanceAndTick(6_000); // lag 5_500 — past warn, well under profile
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(captureProfile).not.toHaveBeenCalled();
  });
});

describe("event-loop sentinel — threshold 2 profile capture", () => {
  it("captures past the profile threshold and names the file in the stall line", () => {
    const { log, captureProfile, advanceAndTick } = harness();
    advanceAndTick(40_000);
    expect(captureProfile).toHaveBeenCalledTimes(1);
    const line = String(log.error.mock.calls[0][0]);
    expect(line).toContain(".cpuprofile");
    // Honesty requirement: the profile is the aftermath, not the freeze.
    expect(line).toContain("aftermath");
  });

  it("rate-limits capture to one per cooldown window, but keeps logging every stall", () => {
    const { log, captureProfile, advanceAndTick } = harness();
    advanceAndTick(40_000); // captures
    advanceAndTick(40_000); // inside cooldown — logged, not captured
    advanceAndTick(40_000); // still inside cooldown
    expect(captureProfile).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(3);
    expect(String(log.error.mock.calls[1][0])).not.toContain(".cpuprofile");
  });

  it("re-arms capture once the cooldown has elapsed", () => {
    const { captureProfile, advanceAndTick } = harness();
    advanceAndTick(40_000);
    advanceAndTick(COOLDOWN); // long idle gap, also a stall by definition
    expect(captureProfile).toHaveBeenCalledTimes(2);
  });

  it("consumes the rate-limit budget even when capture throws, so a broken profiler cannot spin", () => {
    const captureProfile = vi.fn(() => { throw new Error("inspector unavailable"); });
    const { log, advanceAndTick } = harness({ captureProfile });
    advanceAndTick(40_000);
    advanceAndTick(40_000);
    expect(captureProfile).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain("inspector unavailable");
    expect(log.error).toHaveBeenCalledTimes(2); // the stalls are still reported
  });

  it("never captures when the profiler is disabled, but still reports the stall", () => {
    const { log, captureProfile, advanceAndTick } = harness({ profileEnabled: false });
    advanceAndTick(120_000);
    expect(captureProfile).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).not.toContain(".cpuprofile");
  });
});

describe("collectStallSnapshot — the real collector", () => {
  it("reads live process state without throwing", () => {
    const snap = collectStallSnapshot(91_240);
    expect(snap.lagMs).toBe(91_240);
    expect(snap.memoryMb.rss).toBeGreaterThan(0);
    expect(snap.memoryMb.heapUsed).toBeGreaterThan(0);
    expect(Array.isArray(snap.activeTurns)).toBe(true);
    // Undocumented process internals are typeof-guarded; on a runtime that has
    // them we get counts, on one that doesn't we get {} — never a throw.
    expect(snap.handles).not.toBeNull();
    expect(snap.requests).not.toBeNull();
    expect(typeof snap.handles).toBe("object");
    expect(typeof snap.requests).toBe("object");
    for (const n of Object.values(snap.handles)) expect(n).toBeGreaterThan(0);
  });

  // "What was the process holding" is the headline field of the whole feature.
  // Asserting only that `handles` is an object passes just as happily over `{}`,
  // so this opens a real handle and demands the snapshot name it.
  it("counts the live handles it can see, by constructor name", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    try {
      const snap = collectStallSnapshot(1);
      expect(snap.handles.Server).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  it("is JSON-serializable, since the stall line embeds it", () => {
    expect(() => JSON.stringify(collectStallSnapshot(1))).not.toThrow();
  });
});

describe("event-loop sentinel — timer lifecycle", () => {
  // Idempotence that only asserts "did not throw" is satisfied by a start()
  // that arms a second interval every time it is called — the process would
  // then sample twice per period forever. Count the timers instead.
  it("arms exactly one interval however many times start is called", () => {
    const armed = vi.spyOn(globalThis, "setInterval");
    const { sentinel } = harness();
    try {
      sentinel.start();
      sentinel.start();
      sentinel.start();
      expect(armed).toHaveBeenCalledTimes(1);
    } finally {
      sentinel.stop();
      armed.mockRestore();
    }
  });

  it("disarms the interval on stop, tolerates a second stop, and re-arms on restart", () => {
    const armed = vi.spyOn(globalThis, "setInterval");
    const disarmed = vi.spyOn(globalThis, "clearInterval");
    const { sentinel } = harness();
    try {
      sentinel.start();
      const handle = armed.mock.results[0]?.value;
      sentinel.stop();
      expect(disarmed).toHaveBeenCalledWith(handle); // the timer really is cleared
      sentinel.stop(); // unarmed: nothing left to clear
      expect(disarmed).toHaveBeenCalledTimes(1);
      sentinel.start(); // a stopped sentinel can be started again
      expect(armed).toHaveBeenCalledTimes(2);
    } finally {
      sentinel.stop();
      disarmed.mockRestore();
      armed.mockRestore();
    }
  });

  it("does not hold the process open (the interval is unref'd)", () => {
    const { sentinel } = harness();
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    sentinel.start();
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBe(before);
    sentinel.stop();
  });
});

describe("event-loop sentinel — the default clock is monotonic", () => {
  // Date.now() moves backwards and forwards: a laptop sleep/resume or an NTP
  // step forward would fabricate a stall out of nothing, writing a bogus
  // "blocked for <hours>ms" line — and a CPU profile — into the very log this
  // feature exists to make readable. Lag must be measured monotonically.
  it("does not fabricate a stall when the wall clock jumps forward", () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const collectSnapshot = vi.fn((lagMs: number): StallSnapshot => ({
      lagMs, handles: {}, requests: {},
      memoryMb: { rss: 1, heapUsed: 1, heapTotal: 1, external: 1 }, activeTurns: [],
    }));
    const base = Date.now();
    // Stub the wall clock BEFORE constructing, so a sentinel that reaches for
    // Date.now() captures the stub rather than the pristine builtin.
    const jumped = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      // No `now` override: this exercises the sentinel's real default clock.
      const sentinel = createEventLoopSentinel({ logger: log, collectSnapshot, profileEnabled: false });
      jumped.mockReturnValue(base + 3_600_000); // laptop resumes, or NTP steps the clock
      sentinel.tick();
      sentinel.tick();
    } finally {
      jumped.mockRestore();
    }
    expect(log.error).not.toHaveBeenCalled();
    expect(collectSnapshot).not.toHaveBeenCalled();
  });
});

describe("stall profiles — retention", () => {
  // The header comment promises a permanently sick server "must not fill the
  // disk". The 1-per-10-minutes rate limit alone allows 144 multi-MB profiles a
  // day, forever — nothing else prunes ~/.lax/logs. Retention is the other half.
  it("deletes all but the newest profiles and leaves other files alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-loop-sentinel-"));
    try {
      const names = Array.from({ length: 8 }, (_, i) => `loop-stall-2026-07-28T0${i}-00-00-000Z.cpuprofile`);
      for (const n of names) writeFileSync(join(dir, n), "{}");
      writeFileSync(join(dir, "server.log"), "not a profile");
      pruneOldStallProfiles(dir, 3);
      expect(readdirSync(dir).sort()).toEqual([...names.slice(5), "server.log"].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is best-effort — an unreadable directory never fails a capture", () => {
    const missing = join(tmpdir(), "lax-loop-sentinel-does-not-exist-9d3f");
    expect(() => pruneOldStallProfiles(missing, 3)).not.toThrow();
  });
});
