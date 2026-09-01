// Regression: the server froze its event loop for 90-110s, 182 times, and no
// log line named the blocker — a blocked process emits nothing. These pin the
// sentinel's whole contract: silence when healthy, a loud snapshot past
// threshold 1, and a rate-limited profile past threshold 2. Clock, logger,
// snapshot and profiler are all injected, so nothing here sleeps, spins a real
// timer, touches the filesystem, or opens an inspector session.
import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEventLoopSentinel,
  collectStallSnapshot,
  pruneOldStallProfiles,
  type StallSnapshot,
} from "./event-loop-sentinel.js";
import {
  BEAT_INDEX,
  CHECKS_INDEX,
  createStallWatch,
  createWorkerStallObserver,
  type SentinelWorkerData,
  type SentinelWorkerHandle,
} from "./event-loop-sentinel-worker.js";

const INTERVAL = 500;
const WARN = 5_000;
const PROFILE = 30_000;
const COOLDOWN = 600_000;
/** Worker-side cadence: how often the off-thread observer looks at the beat. */
const CHECK = 1_000;
const REPEAT_CAP = 60_000;

/** Worker looks across `ms` of a REAL block, modelled the way production
 *  under-counts them: a look is stamped up to one interval late and the first
 *  look after the gap opens can be lost, so ≈ floor(ms / interval) − 1 — never
 *  the rounded ideal, which would flatter the threshold. */
const realisticChecks = (ms: number): number => Math.max(0, Math.floor(ms / CHECK) - 1);

function harness(
  overrides: Parameters<typeof createEventLoopSentinel>[0] = {},
  checksFor: (ms: number) => number = realisticChecks,
) {
  let clock = 1_000_000;
  /** The off-thread watch's check count. advanceAndTick moves it by
   *  checksFor(ms) — a worker that kept running, which is what a REAL block
   *  looks like from the main thread; suspendAndTick freezes it. */
  let workerChecks = 1_000;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // Stand-in for the worker-backed observer: these cases are about the
  // main-thread half, and no test should spawn a thread to prove them.
  const observer = {
    beat: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    checks: vi.fn(() => workerChecks),
    checkIntervalMs: CHECK,
  };
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
    observer,
    ...overrides,
  });
  /** Let `ms` pass with the PROCESS RUNNING (the worker kept looking), then
   *  take one sample. */
  const advanceAndTick = (ms: number) => { clock += ms; workerChecks += checksFor(ms); sentinel.tick(); };
  /** The whole process was FROZEN for `ms` (system sleep): the clock advanced,
   *  the worker looked `wakeChecks` times — 1 if its overdue timer fired before
   *  the main thread's on wake, 0 if after — then take one sample. */
  const suspendAndTick = (ms: number, wakeChecks: 0 | 1 = 1) => { clock += ms; workerChecks += wakeChecks; sentinel.tick(); };
  return { log, captureProfile, collectSnapshot, observer, sentinel, advanceAndTick, suspendAndTick };
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

describe("event-loop sentinel — a system suspension is not a stall", () => {
  // Three pmset maintenance sleeps (1003s, 1045s, 936s) each came back as
  // "event loop blocked for ~1000000ms" with activeTurns: [] and a useless
  // .cpuprofile: the monotonic clock advances across sleep, so on wake the late
  // sample is indistinguishable from a block BY THE CLOCK ALONE. The worker's
  // check count is what tells them apart — it climbs through a block and
  // stands still through a sleep.
  it("logs one info line that carries the snapshot, and skips only the profile", () => {
    const { log, collectSnapshot, captureProfile, advanceAndTick, suspendAndTick } = harness();
    advanceAndTick(INTERVAL);
    suspendAndTick(1_003_500);
    expect(log.error).not.toHaveBeenCalled();
    expect(captureProfile).not.toHaveBeenCalled();
    // The snapshot is KEPT: a major GC pause of the main isolate parks the
    // worker too, and memoryMb is the diagnosis for that case. The verdict may
    // cost the (aftermath-only) profile; it must never cost the evidence.
    expect(collectSnapshot).toHaveBeenCalledWith(1_003_000);
    expect(log.info).toHaveBeenCalledTimes(1);
    const line = String(log.info.mock.calls[0][0]);
    expect(line).toContain("[loop-sentinel] system suspended for 1003s");
    expect(line).toContain("not an event-loop stall");
    expect(line).toContain("~1s observed by the worker");
    expect(line).toContain('"handles":{"Socket":2}');
    expect(line).toContain('"memoryMb":{"rss":100');
    expect(line).toContain('"sessionId":"s1"');
    expect(line).not.toContain("blocked for");
    expect(line).not.toContain(".cpuprofile");
  });

  // The threshold is HALF the lag, and it has to survive production's
  // under-count (≈ floor(lag/interval) − 1 looks for a real block). A mutant
  // that compared observed time against the WHOLE lag would call every real
  // block a suspension, because the worker never quite observes all of it.
  it("classifies a real 6s and a real 600s block as stalls despite the under-count", () => {
    const short = harness();
    short.advanceAndTick(6_500); // lag 6000; the worker looked 5 times → 5000ms observed
    expect(short.log.error).toHaveBeenCalledTimes(1);
    expect(short.log.info).not.toHaveBeenCalled();
    const long = harness();
    long.advanceAndTick(600_500); // lag 600000; 599 looks → 599000ms observed
    expect(long.log.error).toHaveBeenCalledTimes(1);
    expect(long.captureProfile).toHaveBeenCalledTimes(1);
    expect(long.log.info).not.toHaveBeenCalled();
  });

  it("sits exactly at half: 3 looks across a 6s lag is a stall, 2 is a suspension", () => {
    const atHalf = harness({}, () => 3); // 3000ms observed of a 6000ms lag
    atHalf.advanceAndTick(6_500);
    expect(atHalf.log.error).toHaveBeenCalledTimes(1);
    expect(atHalf.log.info).not.toHaveBeenCalled();
    const under = harness({}, () => 2); // 2000ms observed of a 6000ms lag
    under.advanceAndTick(6_500);
    expect(under.log.info).toHaveBeenCalledTimes(1);
    expect(under.log.error).not.toHaveBeenCalled();
  });

  it("is decided the same whichever overdue timer fires first on wake", () => {
    // Both threads' timers are overdue on wake and fire in either order, so the
    // count moved by 1 (worker first) or 0 (main first). A "we slept" flag the
    // worker had not yet written would leave the second case reported as a
    // stall; a count reads the same both ways.
    for (const wakeChecks of [0, 1] as const) {
      const { log, captureProfile, suspendAndTick } = harness();
      suspendAndTick(936_500, wakeChecks);
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.error).not.toHaveBeenCalled();
      expect(captureProfile).not.toHaveBeenCalled();
    }
  });

  it("does not re-report on the next sample, and still reports a later real stall", () => {
    const { log, collectSnapshot, advanceAndTick, suspendAndTick } = harness();
    suspendAndTick(1_045_500);
    advanceAndTick(INTERVAL);
    advanceAndTick(INTERVAL);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    advanceAndTick(6_500); // a real block afterwards: the worker kept looking
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(collectSnapshot).toHaveBeenCalledWith(6_000);
  });

  it("still reports a real block, which the worker watched happen", () => {
    const { log, collectSnapshot, captureProfile, advanceAndTick } = harness();
    advanceAndTick(6_500); // 6s of lag; the worker looked ~6 times
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain("event loop blocked for 6000ms");
    expect(collectSnapshot).toHaveBeenCalledWith(6_000);
    advanceAndTick(1_000_500); // a real 1000s block — ~1000 looks — is profiled as before
    expect(captureProfile).toHaveBeenCalledTimes(1);
  });

  // Fail-safe direction: every "cannot tell" is reported as a stall. No worker,
  // a dead one, or one that had not booted before the gap must never turn a
  // real stall into a "system suspended" line.
  it("reports a stall when there is no worker to ask", () => {
    const { log, suspendAndTick } = harness({ observer: null });
    suspendAndTick(1_003_500);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("reports a stall when the worker is not live (checks() is null)", () => {
    const observer = { beat: vi.fn(), start: vi.fn(), stop: vi.fn(), checks: vi.fn(() => null), checkIntervalMs: CHECK };
    const { log, suspendAndTick } = harness({ observer });
    suspendAndTick(1_003_500);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("reports a stall when the worker had never been seen running before the gap", () => {
    // Count still at 0 = the worker was booting. Standing still is not frozen.
    let checks = 0;
    const observer = { beat: vi.fn(), start: vi.fn(), stop: vi.fn(), checks: vi.fn(() => checks), checkIntervalMs: CHECK };
    const { log, suspendAndTick } = harness({ observer });
    checks = 1; // its first look lands on wake — the same delta a sleep shows
    suspendAndTick(1_003_500);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
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
  // Date.now() moves backwards and forwards: an NTP or manual clock STEP would
  // fabricate a stall out of nothing, writing a bogus "blocked for <hours>ms"
  // line — and a CPU profile — into the very log this feature exists to make
  // readable. Lag must be measured monotonically. What a monotonic clock does
  // NOT buy is immunity to system SLEEP: performance.now() keeps counting
  // through one on macOS, so a resume DOES arrive as a lag the size of the
  // sleep (three ~1000s maintenance sleeps did, as "blocked for 1000519ms").
  // That case is decided by the worker's check count — see "a system
  // suspension is not a stall" — never by the choice of clock.
  it("ignores a wall-clock step: no stall is fabricated from Date.now()", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

// ─────────────────────── the off-thread half ────────────────────────────────
// The regression these cover: reporting a stall by noticing your own sample was
// late only works if the loop COMES BACK. On 2026-07-28 the loop wedged at
// 15:29:21 and the process was killed still wedged — zero sentinel lines, no
// profile, for the one stall the user actually felt. The worker half must
// report a stall IN PROGRESS, which is something the main thread can never do.

/** Drives createStallWatch with an injected clock and a hand-cranked beat, so
 *  "the main thread is wedged" is expressed as "no beat" and nothing sleeps. */
function watchHarness(opts: { warnMs?: number; repeatCapMs?: number } = {}) {
  let clock = 10_000;
  let beat = 7; // arbitrary start — only CHANGES mean anything
  let published = 0;
  const lines: string[] = [];
  const watch = createStallWatch({
    now: () => clock,
    readBeat: () => beat,
    publishCheck: () => { published += 1; },
    checkIntervalMs: CHECK,
    warnMs: opts.warnMs ?? WARN,
    repeatCapMs: opts.repeatCapMs ?? REPEAT_CAP,
    emit: (line) => lines.push(line),
  });
  /** The main thread beat, then the worker looked. */
  const alive = (ms = CHECK) => { clock += ms; beat += 2; watch.check(); };
  /** The main thread is WEDGED — no beat — and the worker looked anyway. */
  const wedged = (ms = CHECK) => { clock += ms; watch.check(); };
  const reported = () => lines
    .filter((l) => l.includes("STILL BLOCKED"))
    .map((l) => Number(/at least (\d+)ms/.exec(l)?.[1] ?? -1));
  return { lines, alive, wedged, reported, published: () => published };
}

describe("stall watch — reports a stall that is still happening", () => {
  it("says nothing while the beats keep arriving", () => {
    const { lines, alive } = watchHarness();
    for (let i = 0; i < 30; i++) alive();
    expect(lines).toEqual([]);
  });

  it("stays quiet under the threshold", () => {
    const { lines, wedged } = watchHarness();
    for (let i = 0; i < 4; i++) wedged(); // 4s wedged, warn is 5s
    expect(lines).toEqual([]);
  });

  // THE POINT OF THE WHOLE FILE: the main loop never resumes, and the stall is
  // reported anyway. Nothing in the on-resume path can produce this line.
  it("reports the block WITHOUT the main thread ever coming back", () => {
    const { lines, wedged, reported } = watchHarness();
    for (let i = 0; i < 6; i++) wedged(); // wedged forever; no beat, no resume
    expect(reported()).toEqual([5_000]);
    expect(lines[0]).toContain("STILL BLOCKED");
    expect(lines.join("\n")).not.toContain("beat again"); // it never came back
  });

  it("is honest that it cannot see what the main thread was holding", () => {
    const { lines, wedged } = watchHarness();
    for (let i = 0; i < 6; i++) wedged();
    expect(lines[0]).toContain("handles, requests and active turns are unreadable");
    expect(lines[0]).toContain("at least"); // never inflates the elapsed time
  });

  it("keeps reporting while the stall grows, on a backed-off cadence", () => {
    const { lines, wedged, reported } = watchHarness();
    for (let i = 0; i < 300; i++) wedged(); // five minutes wedged, 300 looks
    const seen = reported();
    expect(seen.length).toBeGreaterThanOrEqual(6); // it reports repeatedly…
    expect(lines.length).toBeLessThan(15);         // …but does not spam 300 lines
    expect([...seen].sort((a, b) => a - b)).toEqual(seen); // the number climbs
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(200_000);
  });

  it("brackets the stall when the loop returns, then re-arms for the next one", () => {
    const { lines, alive, wedged } = watchHarness();
    for (let i = 0; i < 10; i++) wedged();
    alive(); // the loop finally comes back
    expect(lines.at(-1)).toContain("beat again after roughly 11000ms");
    const closed = lines.length;
    for (let i = 0; i < 6; i++) wedged(); // a SECOND, independent stall
    expect(lines.length).toBeGreaterThan(closed);
    expect(lines.at(-1)).toContain("in-progress report 1"); // counter re-armed
    expect(lines.at(-1)).toContain("at least 5000ms");      // not cumulative
  });

  it("publishes one check per look, so the main thread can count them", () => {
    const { alive, wedged, published } = watchHarness();
    for (let i = 0; i < 4; i++) alive();
    for (let i = 0; i < 3; i++) wedged();
    expect(published()).toBe(7);
  });
});

describe("stall watch — a system suspension is not a stall", () => {
  // The worker's own timer is frozen with the rest of the process during a
  // sleep, so on wake exactly ONE check fires, with a self-gap the size of the
  // sleep and no beat — which used to be written up as "STILL BLOCKED — no
  // liveness beat for at least 1000519ms". Nothing was blocked; nothing ran.
  it("says nothing when its one check after a huge self-gap finds no beat", () => {
    const { lines, alive, wedged } = watchHarness();
    for (let i = 0; i < 5; i++) alive();
    wedged(1_000_000); // the whole process was asleep; this is the wake check
    expect(lines).toEqual([]);
  });

  it("still reports a stall it watched happen, look by look", () => {
    // The same elapsed time delivered the way a real block is experienced:
    // the worker kept looking. The existing contract, pinned next to its twin.
    const { reported, wedged } = watchHarness();
    for (let i = 0; i < 1_000; i++) wedged(1_000);
    expect(reported()[0]).toBe(5_000);
    expect(Math.max(...reported())).toBeGreaterThanOrEqual(900_000);
  });

  it("strikes the sleep from a stall that straddles it instead of inflating it", () => {
    const { lines, reported, wedged } = watchHarness();
    for (let i = 0; i < 8; i++) wedged(); // 8s wedged before the machine slept
    expect(reported()).toEqual([5_000]);
    wedged(1_000_000);                     // asleep, then the wake check
    for (let i = 0; i < 7; i++) wedged();  // and the loop is STILL wedged after
    expect(reported()).toEqual([5_000, 15_000]); // 15s of block, not 1015s
    expect(lines.join("\n")).not.toContain("1015000");
  });

  it("keeps watching normally after the wake", () => {
    const { lines, alive, wedged, reported } = watchHarness();
    wedged(1_000_000);                    // asleep
    alive();                              // the loop is fine after the wake
    for (let i = 0; i < 6; i++) wedged(); // then a real, separate stall
    expect(lines.join("\n")).not.toContain("beat again"); // nothing to bracket
    expect(reported()).toEqual([5_000]);
  });
});

/** Records what the observer does to its worker without spawning a thread. */
function stubWorker() {
  const listeners = new Map<string, (arg: never) => void>();
  const counts = { unref: 0, terminate: 0 };
  /** Call ORDER, not just counts: unref() before an on("message") is undone by
   *  node and pins the process open, and a count cannot see that. */
  const calls: string[] = [];
  const handle: SentinelWorkerHandle = {
    unref() { counts.unref += 1; calls.push("unref"); },
    terminate() { counts.terminate += 1; calls.push("terminate"); return 0; },
    on(event: string, listener: (arg: never) => void) {
      listeners.set(event, listener);
      calls.push(`on:${event}`);
      return handle;
    },
  };
  const fire = (event: string, arg: unknown): void => {
    const listener = listeners.get(event) as ((a: unknown) => void) | undefined;
    expect(listener, `no ${event} listener registered`).toBeTruthy();
    listener?.(arg);
  };
  return { handle, counts, calls, fire };
}

function observerHarness(overrides: Partial<Parameters<typeof createWorkerStallObserver>[0]> = {}) {
  const spawns: SentinelWorkerData[] = [];
  const issues: string[] = [];
  const worker = stubWorker();
  const observer = createWorkerStallObserver({
    logPath: join(tmpdir(), "unused-by-this-test.log"),
    warnMs: WARN,
    checkIntervalMs: CHECK,
    repeatCapMs: REPEAT_CAP,
    onIssue: (message) => issues.push(message),
    spawn: (data) => { spawns.push(data); return worker.handle; },
    ...overrides,
  });
  return { observer, spawns, issues, worker };
}

describe("worker stall observer — the main-thread half", () => {
  it("hands the worker a shared beat cell that beat() bumps", () => {
    const { observer, spawns } = observerHarness();
    observer.start();
    const beats = new Int32Array(spawns[0].beats);
    const before = Atomics.load(beats, BEAT_INDEX);
    observer.beat();
    observer.beat();
    // The worker reads this cell on ITS loop — no message, no allocation, and
    // nothing for a blocked main thread to deliver.
    expect(Atomics.load(beats, BEAT_INDEX)).toBe(before + 2);
  });

  it("beats safely before the worker exists", () => {
    const { observer, spawns } = observerHarness();
    expect(() => observer.beat()).not.toThrow();
    expect(spawns).toEqual([]);
  });

  it("spawns one worker however many times start is called, and unrefs it", () => {
    const { observer, spawns, worker } = observerHarness();
    observer.start();
    observer.start();
    observer.start();
    expect(spawns).toHaveLength(1);
    // Unref'd, or a diagnostic would keep a finished process alive.
    expect(worker.counts.unref).toBe(1);
    observer.stop();
    expect(worker.counts.terminate).toBe(1);
  });

  // The count above is NOT enough on its own: node re-ref()s a Worker's public
  // MessagePort whenever a "message" listener is added, so an unref() that runs
  // before the listeners is undone and the process is pinned open forever while
  // the count still reads 1. The real proof is the child-process test at the
  // bottom of this file; this is the cheap guard that catches a reorder in
  // milliseconds instead of 45 seconds.
  it("unrefs the worker only after every listener is attached", () => {
    const { observer, worker } = observerHarness();
    observer.start();
    expect(worker.calls).toContain("on:message");
    expect(worker.calls.at(-1)).toBe("unref");
  });

  it("announces a dead observer instead of pretending it is still watching", () => {
    const { observer, issues, worker } = observerHarness();
    observer.start();
    worker.fire("exit", 7);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("exited (code 7)");
    expect(issues[0]).toContain("ONLY once the loop resumes");
  });

  it("says nothing when the worker exits because we stopped it", () => {
    const { observer, issues, worker } = observerHarness();
    observer.start();
    observer.stop();
    worker.fire("exit", 0);
    expect(issues).toEqual([]);
  });

  // terminate() resolves ASYNCHRONOUSLY: the first worker's "exit" lands after
  // a stop/start cycle has already installed its successor. An observer that
  // treats any exit as its own would then drop the live worker on the floor and
  // announce that the in-progress half is dead while it is happily watching —
  // and the next start() would spawn a duplicate thread writing duplicate stall
  // lines. Only the handle that is currently live may speak for the observer.
  it("ignores a replaced worker's late exit instead of clobbering the live one", () => {
    const spawned: Array<ReturnType<typeof stubWorker>> = [];
    const issues: string[] = [];
    const observer = createWorkerStallObserver({
      logPath: join(tmpdir(), "unused-by-this-test.log"),
      warnMs: WARN,
      onIssue: (message) => issues.push(message),
      spawn: () => { const w = stubWorker(); spawned.push(w); return w.handle; },
    });
    observer.start();
    observer.stop();
    observer.start(); // the second worker is the live observer from here on
    spawned[0].fire("exit", 0); // …and only now does the first one's exit arrive

    expect(issues).toEqual([]); // nothing is wrong: the observer is watching
    observer.start(); // already running — must not spawn a third thread
    expect(spawned).toHaveLength(2);
    observer.stop();
    expect(spawned[1].counts.terminate).toBe(1); // the LIVE worker was stopped
  });

  it("reports the live worker's own exit even after an earlier restart", () => {
    const spawned: Array<ReturnType<typeof stubWorker>> = [];
    const issues: string[] = [];
    const observer = createWorkerStallObserver({
      logPath: join(tmpdir(), "unused-by-this-test.log"),
      warnMs: WARN,
      onIssue: (message) => issues.push(message),
      spawn: () => { const w = stubWorker(); spawned.push(w); return w.handle; },
    });
    observer.start();
    observer.stop();
    observer.start();
    spawned[1].fire("exit", 9); // the CURRENT worker died on its own
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("exited (code 9)");
    // …and the observer is free to be started again afterwards.
    observer.start();
    expect(spawned).toHaveLength(3);
    observer.stop();
  });

  it("surfaces a worker that cannot write its log, and a spawn that fails", () => {
    const { observer, issues, worker } = observerHarness();
    observer.start();
    worker.fire("message", { kind: "log-failed", message: "EACCES" });
    worker.fire("error", new Error("boom"));
    expect(issues[0]).toContain("cannot write");
    expect(issues[0]).toContain("EACCES");
    expect(issues[1]).toContain("boom");

    const failing = observerHarness({ spawn: () => { throw new Error("no threads"); } });
    failing.observer.start();
    expect(failing.issues[0]).toContain("no threads");
    // A failed spawn must not leave a half-started observer that never retries
    // silently: start() can be called again.
    expect(() => failing.observer.beat()).not.toThrow();
  });
});

describe("event-loop sentinel — main thread drives the off-thread observer", () => {
  it("publishes a beat on every sample, healthy or stalled", () => {
    const { observer, advanceAndTick } = harness();
    advanceAndTick(INTERVAL);
    advanceAndTick(INTERVAL);
    advanceAndTick(90_000); // a stall is still a sample: it must beat too
    expect(observer.beat).toHaveBeenCalledTimes(3);
  });

  it("starts and stops the observer with the sentinel", () => {
    const { observer, sentinel } = harness();
    sentinel.start();
    sentinel.start();
    expect(observer.start).toHaveBeenCalledTimes(1);
    sentinel.stop();
    expect(observer.stop).toHaveBeenCalledTimes(1);
  });

  // The two halves are complementary, not redundant: only the main thread can
  // read handles/requests/turns, and it can only do it on the way out.
  it("still takes the on-resume snapshot when the loop does come back", () => {
    const { log, collectSnapshot, advanceAndTick } = harness();
    advanceAndTick(90_000 + INTERVAL);
    expect(collectSnapshot).toHaveBeenCalledWith(90_000);
    expect(String(log.error.mock.calls[0][0])).toContain('"handles":{"Socket":2}');
  });
});

describe("event-loop sentinel — a stall that NEVER ends is reported anyway", () => {
  // Real beat cell, real beat(), real watch — only the thread is faked. The
  // main thread wedges and never returns, so its own half stays silent by
  // construction; the log still gets the stall.
  it("the worker reports it in progress while the main thread stays wedged", () => {
    const { observer, spawns, issues } = observerHarness();
    observer.start();
    const data = spawns[0];
    const beats = new Int32Array(data.beats);

    let mainClock = 1_000_000;
    let workerClock = 1_000_000; // separate clock: the threads share no timeOrigin
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const lines: string[] = [];
    const sentinel = createEventLoopSentinel({
      now: () => mainClock,
      logger: log,
      intervalMs: INTERVAL,
      warnMs: WARN,
      profileEnabled: false,
      observer,
    });
    const watch = createStallWatch({
      now: () => workerClock,
      readBeat: () => Atomics.load(beats, BEAT_INDEX),
      publishCheck: () => { Atomics.add(beats, CHECKS_INDEX, 1); },
      checkIntervalMs: data.checkIntervalMs,
      warnMs: data.warnMs,
      repeatCapMs: data.repeatCapMs,
      emit: (line) => lines.push(line),
    });

    // Healthy: samples land on time and the worker sees the beats.
    for (let i = 0; i < 10; i++) {
      mainClock += INTERVAL;
      sentinel.tick();
      workerClock += INTERVAL;
      watch.check();
    }
    expect(lines).toEqual([]);

    // 15:29:21 — the loop wedges and tick() is NEVER called again. No resume,
    // no on-resume snapshot, no profile: the user force-quits instead.
    for (let i = 0; i < 60; i++) {
      workerClock += CHECK;
      watch.check();
    }

    expect(log.error).not.toHaveBeenCalled(); // the main half has nothing to say
    const reported = lines.map((l) => Number(/at least (\d+)ms/.exec(l)?.[1] ?? -1));
    expect(reported.length).toBeGreaterThanOrEqual(3);
    expect(lines.every((l) => l.includes("STILL BLOCKED"))).toBe(true);
    expect(reported[0]).toBe(5_000);
    expect(reported.at(-1)).toBeGreaterThanOrEqual(35_000); // and it keeps growing
    expect(issues).toEqual([]);
  });
});

describe("event-loop sentinel — both halves agree a sleep was a sleep", () => {
  // Real beat cell, real check counter, real observer — only the thread is
  // faked. The sentinel's verdict is read back through the same
  // SharedArrayBuffer slot the worker's watch writes, so this proves the
  // transport, not a stub answering the question for it.
  it("reads the worker's check count through the shared cell and stays quiet on wake", () => {
    const { observer, spawns, issues } = observerHarness();
    observer.start();
    const data = spawns[0];
    const slots = new Int32Array(data.beats);

    let mainClock = 1_000_000;
    let workerClock = 1_000_000;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const lines: string[] = [];
    const collectSnapshot = vi.fn((lagMs: number): StallSnapshot => ({
      lagMs, handles: {}, requests: {},
      memoryMb: { rss: 1, heapUsed: 1, heapTotal: 1, external: 1 }, activeTurns: [],
    }));
    const sentinel = createEventLoopSentinel({
      now: () => mainClock,
      logger: log,
      intervalMs: INTERVAL,
      warnMs: WARN,
      profileEnabled: false,
      collectSnapshot,
      observer,
    });
    const watch = createStallWatch({
      now: () => workerClock,
      readBeat: () => Atomics.load(slots, BEAT_INDEX),
      publishCheck: () => { Atomics.add(slots, CHECKS_INDEX, 1); },
      checkIntervalMs: data.checkIntervalMs,
      warnMs: data.warnMs,
      repeatCapMs: data.repeatCapMs,
      emit: (line) => lines.push(line),
    });

    // Healthy for five seconds: the worker looks once per two samples.
    for (let i = 0; i < 10; i++) {
      if (i % 2) { workerClock += CHECK; watch.check(); }
      mainClock += INTERVAL;
      sentinel.tick();
    }
    expect(lines).toEqual([]);
    expect(log.info).not.toHaveBeenCalled();

    // The machine sleeps for 1003s. Nothing runs. On wake the worker's overdue
    // check fires first, then the main thread's overdue sample.
    workerClock += 1_003_500;
    watch.check();
    mainClock += 1_003_500;
    sentinel.tick();

    expect(lines).toEqual([]); // no "STILL BLOCKED for 1003500ms" from the worker
    expect(log.error).not.toHaveBeenCalled();
    expect(collectSnapshot).toHaveBeenCalledWith(1_003_000); // the evidence is kept
    expect(log.info).toHaveBeenCalledTimes(1);
    const line = String(log.info.mock.calls[0][0]);
    expect(line).toContain("system suspended for 1003s");
    expect(line).toContain("~1s observed by the worker");

    // …and a real block afterwards is still seen by BOTH halves.
    for (let i = 0; i < 8; i++) { workerClock += CHECK; watch.check(); }
    mainClock += 8_500;
    sentinel.tick();
    expect(lines.some((l) => l.includes("STILL BLOCKED"))).toBe(true);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain("event loop blocked for 8000ms");
    expect(collectSnapshot).toHaveBeenCalledWith(8_000);
    expect(issues).toEqual([]);
  });
});

/** Lines the worker wrote, newest last. */
function readStallLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.includes("[loop-sentinel:worker]"));
  } catch {
    return []; // not created yet
  }
}

function stampOf(line: string): number {
  return Date.parse(line.slice(1, line.indexOf("]")));
}

async function waitForStallLines(path: string, atLeast: number, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = readStallLines(path);
    if (lines.length >= atLeast) return lines;
    if (Date.now() > deadline) throw new Error(`only ${lines.length} worker lines after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("event-loop sentinel — a REAL worker logging a REAL wedge", () => {
  // Everything above drives the logic with injected clocks. This one proves the
  // thing those cannot: that a genuinely blocked main thread does not stop the
  // worker from writing to the log. Real time is unavoidable here — a fake
  // clock cannot express "this thread is not running".
  it("appends in-progress lines while the main thread is busy-blocked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-loop-sentinel-live-"));
    const logPath = join(dir, "server.log");
    const issues: string[] = [];
    // Compressed thresholds: this stall starts at worker boot (nothing ever
    // beats) and the whole test must fit in a second.
    const observer = createWorkerStallObserver({
      logPath,
      warnMs: 120,
      checkIntervalMs: 25,
      repeatCapMs: 200,
      onIssue: (message) => issues.push(message),
    });
    observer.start();
    try {
      // The worker boots and reports while the loop is free — no resume needed.
      const booted = await waitForStallLines(logPath, 1, 20_000);
      expect(booted[0]).toContain("STILL BLOCKED");

      const blockStart = Date.now();
      while (Date.now() - blockStart < 900) { /* wedge the main thread */ }
      const blockEnd = Date.now();

      const during = readStallLines(logPath).filter((l) => {
        const at = stampOf(l);
        return at >= blockStart && at <= blockEnd;
      });
      expect(during.length).toBeGreaterThanOrEqual(2);
      for (const line of during) {
        expect(line).toContain("STILL BLOCKED");
        expect(line).toContain("ERROR [loop-sentinel:worker]"); // server.log shape
      }
      // The elapsed number grows across the block, i.e. these are reports of one
      // stall in progress — not one line replayed on resume.
      const grew = during.map((l) => Number(/at least (\d+)ms/.exec(l)?.[1] ?? -1));
      expect(grew.at(-1)).toBeGreaterThan(grew[0]);
      expect(issues).toEqual([]);
    } finally {
      observer.stop();
      await new Promise((resolve) => setTimeout(resolve, 100)); // let it die before rm
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});

/**
 * The child: start the observer, wait until the worker is demonstrably watching,
 * wedge the main thread, publish the wedge window, then RETURN — no
 * process.exit(), no observer.stop(). Whether it dies is entirely up to whether
 * the observer still holds a ref.
 */
const WEDGE_THEN_EXIT_CHILD = `
import { readFileSync, writeFileSync } from "node:fs";

const [moduleUrl, logPath, windowPath] = process.argv.slice(2);
const { createWorkerStallObserver } = await import(moduleUrl);

const issues = [];
const observer = createWorkerStallObserver({
  logPath,
  warnMs: 120,
  checkIntervalMs: 25,
  repeatCapMs: 200,
  onIssue: (m) => issues.push(m),
});
observer.start();

// Nothing ever beats here, so the worker reports as soon as it is up. Waiting
// for that first line is what guarantees the wedge below lands inside its watch
// rather than during its boot.
const deadline = Date.now() + 20000;
for (;;) {
  let seen = 0;
  try {
    seen = readFileSync(logPath, "utf8").split("\\n").filter((l) => l.includes("[loop-sentinel:worker]")).length;
  } catch { /* the worker has not written yet */ }
  if (seen >= 1) break;
  if (Date.now() > deadline) {
    writeFileSync(windowPath, JSON.stringify({ error: "the worker never reported" }));
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 25));
}

const blockStart = Date.now();
while (Date.now() - blockStart < 900) { /* wedge the main thread */ }
const blockEnd = Date.now();
writeFileSync(windowPath, JSON.stringify({ blockStart, blockEnd, issues }));
`;

describe("event-loop sentinel — the observer must never keep the process alive", () => {
  // THE case a stub cannot reach. `expect(counts.unref).toBe(1)` passes on a
  // handle that is pinned open, because node re-ref()s a Worker's public
  // MessagePort when a "message" listener is attached — so unref()ing before
  // that listener silently undoes itself and the process can never exit again.
  // Observed for real: this child hung past 25s before the ordering fix and
  // exits in ~2.5s after it. Only a real process can tell those apart, so this
  // spawns one, wedges its main thread, and demands that it die by itself.
  it("lets a process whose main thread was wedged exit on its own, worker and all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-loop-sentinel-exit-"));
    const logPath = join(dir, "server.log");
    const windowPath = join(dir, "window.json");
    const childPath = join(dir, "wedge-then-exit.mjs");
    writeFileSync(childPath, WEDGE_THEN_EXIT_CHILD);
    // Same tsx/dist split the observer's own spawn uses (see spawnSentinelWorker).
    const isTsRuntime = import.meta.url.endsWith(".ts");
    const moduleUrl = new URL(
      isTsRuntime ? "./event-loop-sentinel-worker.ts" : "./event-loop-sentinel-worker.js",
      import.meta.url,
    ).href;
    const child = spawn(
      process.execPath,
      [...(isTsRuntime ? ["--import", "tsx"] : []), childPath, moduleUrl, logPath, windowPath],
      // cwd so `--import tsx` resolves; fileURLToPath, never url.pathname — this
      // repo lives under a path with a space in it.
      { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    let hung = false;
    const killer = setTimeout(() => { hung = true; child.kill(); }, 45_000);
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    clearTimeout(killer);

    try {
      expect(hung, `the child never exited — the observer is holding the process open. stderr: ${stderr}`).toBe(false);
      expect(code, `child failed: ${stderr}`).toBe(0);

      // …and it exited because the worker was unref'd, NOT because the observer
      // was neutered: it has to have reported the wedge while it was happening.
      const window = JSON.parse(readFileSync(windowPath, "utf8")) as {
        blockStart: number; blockEnd: number; issues: string[]; error?: string;
      };
      expect(window.error).toBeUndefined();
      const during = readStallLines(logPath).filter((l) => {
        const at = stampOf(l);
        return at >= window.blockStart && at <= window.blockEnd;
      });
      expect(during.length).toBeGreaterThanOrEqual(2);
      expect(during.every((l) => l.includes("STILL BLOCKED"))).toBe(true);
      expect(window.issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90_000);
});
