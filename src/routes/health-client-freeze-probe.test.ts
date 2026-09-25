/**
 * The renderer freeze probe (public/js/perf-longtask.js) — the instrument every
 * "the UI locked up" investigation depends on.
 *
 * It is asserted by EXECUTION, not by source text, because all three defects it
 * shipped with were logic, not wording: a backgrounded window's clamped timers
 * read as 59-second freezes, a flat per-session report cap went permanently
 * silent once spent, and a failed POST dropped its batch. Together they meant
 * server.log held 320 throttle artifacts out of 401 reports and nothing at all
 * from the window the user was actually complaining about.
 *
 * The file is a self-contained IIFE over a handful of globals, so a vm context
 * with driven time and a captured interval is enough to test it honestly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../../public/js/perf-longtask.js", import.meta.url), "utf8");

interface Harness {
  /** Run one watchdog tick, advancing the fake clock by `elapsedMs` first. */
  tick(elapsedMs: number): void;
  /** Fire the earliest pending timer (the batch flush). */
  runNextTimer(): Promise<void>;
  setHidden(hidden: boolean): void;
  /** Entries the probe has POSTed, flattened across batches. */
  posted: Array<{ kind: string; ms: number }>;
  /** Every stall the probe recorded locally, reported or not. */
  log(): Array<{ kind: string; ms: number }>;
  pendingTimers(): number;
  /** Make the next POST fail; `undefined` restores success. */
  failNextPost(mode?: "reject" | "500"): void;
}

function loadProbe(): Harness {
  let nowMs = 0;
  // The drift watchdog measures with performance.now(); the report window is
  // wall-clock (Date.now()). Both advance together so a driven tick moves both.
  let wallMs = Date.now();
  const FakeDate = class extends Date {
    static now(): number {
      return wallMs;
    }
  };
  let tickFn: (() => void) | null = null;
  const timers: Array<{ id: number; fn: () => void; at: number }> = [];
  let nextTimerId = 1;
  const visibility: Array<() => void> = [];
  const posted: Array<{ kind: string; ms: number }> = [];
  let failMode: "reject" | "500" | undefined;

  const doc = {
    hidden: false,
    addEventListener(ev: string, fn: () => void) {
      if (ev === "visibilitychange") visibility.push(fn);
    },
  };

  const ctx: Record<string, unknown> = {
    document: doc,
    performance: { now: () => nowMs },
    // The watchdog installs exactly one interval; capture it so ticks are driven.
    setInterval: (fn: () => void) => {
      tickFn = fn;
      return { unref() {} };
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimerId++;
      timers.push({ id, fn, at: nowMs + ms });
      return id;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    console: { warn() {}, info() {}, log() {} },
    AUTH_TOKEN: "test-token",
    Date: FakeDate,
    JSON,
    Math,
    fetch: (_url: string, init: { body: string }) => {
      if (failMode === "reject") {
        failMode = undefined;
        return Promise.reject(new Error("server wedged"));
      }
      if (failMode === "500") {
        failMode = undefined;
        return Promise.resolve({ status: 503 });
      }
      const body = JSON.parse(init.body) as { entries: Array<{ kind: string; ms: number }> };
      posted.push(...body.entries);
      return Promise.resolve({ status: 200 });
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  return {
    tick(elapsedMs: number) {
      nowMs += elapsedMs;
      wallMs += elapsedMs;
      tickFn?.();
    },
    async runNextTimer() {
      const next = timers.shift();
      if (!next) return;
      next.fn();
      // Let the POST's promise callbacks settle.
      await Promise.resolve();
      await Promise.resolve();
    },
    setHidden(hidden: boolean) {
      doc.hidden = hidden;
      for (const fn of visibility) fn();
    },
    posted,
    log: () => (ctx.window as { __laxFreezeLog: Array<{ kind: string; ms: number }> }).__laxFreezeLog,
    pendingTimers: () => timers.length,
    failNextPost(mode: "reject" | "500" = "reject") {
      failMode = mode;
    },
  };
}

// TICK is 1000ms and THRESHOLD 800ms, so a 1000ms interval that takes 3000ms of
// wall clock is a ~2000ms block.
const FREEZE_TICK = 3_000;
const QUIET_TICK = 1_000;

describe("renderer freeze probe: what it reports", () => {
  it("records a real block while the window is visible", () => {
    const h = loadProbe();
    h.tick(FREEZE_TICK);
    expect(h.log()).toHaveLength(1);
    expect(h.log()[0].kind).toBe("freeze");
    expect(h.log()[0].ms).toBe(2_000);
  });

  it("does not report a quiet tick", () => {
    const h = loadProbe();
    h.tick(QUIET_TICK);
    expect(h.log()).toHaveLength(0);
  });

  // The 59-second artifact. A hidden window has its timers clamped to roughly
  // one firing per minute; the old watchdog read that as a 59s freeze and filed
  // one every minute for as long as the window stayed in the background.
  it("ignores clamped ticks while the window is hidden", () => {
    const h = loadProbe();
    h.setHidden(true);
    for (let i = 0; i < 5; i++) h.tick(60_000);
    expect(h.log()).toHaveLength(0);
  });

  // The tick that straddles the unhide is throttled for part of its span, so it
  // carries no information either — sampling document.hidden at tick time alone
  // would have let this one through.
  it("ignores the tick spanning an unhide, then measures normally", () => {
    const h = loadProbe();
    h.setHidden(true);
    h.tick(60_000);
    h.setHidden(false);
    h.tick(60_000); // straddles hidden→visible: discarded
    expect(h.log()).toHaveLength(0);
    h.tick(FREEZE_TICK); // fully visible: real evidence again
    expect(h.log()).toHaveLength(1);
  });
});

describe("renderer freeze probe: delivery", () => {
  it("posts a recorded stall to the intake", async () => {
    const h = loadProbe();
    h.tick(FREEZE_TICK);
    await h.runNextTimer();
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].ms).toBe(2_000);
  });

  // The batch used to be spliced out of the queue before the POST, with an empty
  // catch — so reports were lost precisely when the server was wedged, which is
  // the one case the probe exists to capture.
  it("keeps a batch the server could not accept and delivers it on retry", async () => {
    const h = loadProbe();
    h.tick(FREEZE_TICK);
    h.failNextPost("reject");
    await h.runNextTimer();
    expect(h.posted).toHaveLength(0);
    expect(h.pendingTimers()).toBeGreaterThan(0); // retry armed

    await h.runNextTimer();
    expect(h.posted).toHaveLength(1);
  });

  it("retries a 5xx from a server that is only just coming back", async () => {
    const h = loadProbe();
    h.tick(FREEZE_TICK);
    h.failNextPost("500");
    await h.runNextTimer();
    expect(h.posted).toHaveLength(0);
    await h.runNextTimer();
    expect(h.posted).toHaveLength(1);
  });

  // The cap is a rolling window, not a session total. Spent report budget used to
  // silence the probe for the rest of the window's life — visible in server.log
  // as per-day counts landing on exact multiples of the old cap (40/80/120).
  it("still has report budget for a freeze happening now", async () => {
    const h = loadProbe();
    // Burn well past the old 40-report session cap.
    for (let i = 0; i < 60; i++) {
      h.tick(FREEZE_TICK);
      await h.runNextTimer();
    }
    const before = h.posted.length;
    // A later window reports again rather than staying silent forever.
    h.tick(10 * 60 * 1000 + 1_000);
    h.tick(FREEZE_TICK);
    await h.runNextTimer();
    expect(h.posted.length).toBeGreaterThan(before);
  });

  it("bounds how many reports one window can send", async () => {
    const h = loadProbe();
    for (let i = 0; i < 60; i++) {
      h.tick(FREEZE_TICK);
      await h.runNextTimer();
    }
    // 20 per 10-minute window; the ticks above span far less than that.
    expect(h.posted.length).toBeLessThanOrEqual(20);
    // Local evidence is still complete regardless of what was shipped.
    expect(h.log().length).toBeGreaterThan(h.posted.length);
  });
});
