import { describe, it, expect } from "vitest";
import { BrokerPresence, MAX_RECONNECT_MS, type BrokerPresenceDeps, type DialerHandle } from "./broker-presence.js";

/** A wall-clock jump comfortably past SUSPEND_GAP_MS (60s) — "the machine slept". */
const SUSPEND_TEST_GAP_MS = 900_000;

interface FakeDialer extends DialerHandle {
  connectUrl: string;
  stopped: boolean;
  fireClosed: () => void;
  fireAuthError: (code: "unauthorized") => void;
}

function harness(token = "tok", random: () => number = () => 0.5) {
  const dialers: FakeDialer[] = [];
  const authErrors: string[] = [];
  let timerFn: (() => void) | null = null;
  let lastDelay = 0;
  let clock = 0; // tests advance this to simulate dialer uptime
  let watchdogFn: (() => void) | null = null;
  const deps: BrokerPresenceDeps = {
    createDialer: (connectUrl, _token, onClosed, onAuthError) => {
      const d: FakeDialer = {
        connectUrl,
        stopped: false,
        stop: () => { d.stopped = true; },
        fireClosed: onClosed,
        fireAuthError: onAuthError,
      };
      dialers.push(d);
      return d;
    },
    reconnectMs: 3000,
    setTimer: (fn, ms) => {
      timerFn = fn;
      lastDelay = ms;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      timerFn = null;
    },
    setIntervalFn: (fn) => {
      watchdogFn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {
      watchdogFn = null;
    },
    now: () => clock,
    random, // default 0.5 → no jitter: backoff lands exactly on the capped base*factor^n
  };
  const presence = new BrokerPresence(
    {
      brokerWsUrl: "wss://broker.agentxos.ai",
      deviceId: "desk-1",
      pairedPhoneId: "phone-9",
      getToken: () => token,
      onAuthError: (code) => authErrors.push(code),
    },
    deps,
  );
  return {
    presence,
    dialers,
    authErrors,
    runTimer: () => timerFn?.(),
    hasTimer: () => timerFn !== null,
    lastDelay: () => lastDelay,
    advance: (ms: number) => { clock += ms; },
    tickWatchdog: () => watchdogFn?.(),
    hasWatchdog: () => watchdogFn !== null,
  };
}

describe("BrokerPresence", () => {
  it("dials the broker as the desktop with the right role/target/device on start", () => {
    const { presence, dialers } = harness();
    presence.start();
    expect(dialers).toHaveLength(1);
    const u = new URL(dialers[0].connectUrl);
    expect(u.searchParams.get("role")).toBe("desktop");
    expect(u.searchParams.get("target")).toBe("phone-9");
    expect(u.searchParams.get("device")).toBe("desk-1");
    expect(u.searchParams.get("token")).toBe("tok");
  });

  it("reconnects (new dialer) after the current one closes", () => {
    const { presence, dialers, runTimer } = harness();
    presence.start();
    dialers[0].fireClosed(); // phone left / transport drop
    expect(dialers).toHaveLength(1); // not immediate — scheduled
    runTimer();
    expect(dialers).toHaveLength(2); // re-dialed
  });

  it("stop() cancels a pending reconnect and stops the live dialer", () => {
    const { presence, dialers, runTimer, hasTimer } = harness();
    presence.start();
    presence.stop();
    expect(dialers[0].stopped).toBe(true);
    // A close after stop must NOT schedule a reconnect.
    dialers[0].fireClosed();
    expect(hasTimer()).toBe(false);
    runTimer(); // no-op
    expect(dialers).toHaveLength(1);
  });

  it("does not dial when there is no token (signed out / expired)", () => {
    const { presence, dialers } = harness("");
    presence.start();
    expect(dialers).toHaveLength(0);
  });

  it("grows the reconnect delay exponentially on consecutive fast failures, capped", () => {
    const h = harness();
    h.presence.start();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      h.dialers.at(-1)!.fireClosed(); // fast fail — no uptime advanced (outage/500 loop)
      delays.push(h.lastDelay());
      h.runTimer(); // re-dial
    }
    expect(delays).toEqual([3000, 6000, 12000, 24000, 48000, MAX_RECONNECT_MS]);
  });

  it("resets the backoff after a dialer held a stable session", () => {
    const h = harness();
    h.presence.start();
    h.dialers.at(-1)!.fireClosed(); // attempt 1
    h.runTimer();
    h.dialers.at(-1)!.fireClosed(); // attempt 2
    expect(h.lastDelay()).toBe(6000);
    h.runTimer();
    h.advance(15_000); // the new dialer ran a real session before dropping
    h.dialers.at(-1)!.fireClosed();
    expect(h.lastDelay()).toBe(3000); // reset → base, not 12000
  });

  it("re-dials immediately after a system-sleep gap (the zombie-socket incident)", () => {
    // Live incident 2026-08-23: sleep killed the broker socket SILENTLY (no close
    // event — keepalive offload kept it looking open), so the desktop held a zombie
    // presence for 6 hours while the phone waited for a desktop that never came.
    // The watchdog detects the wall-clock gap on resume and force-re-dials.
    const h = harness();
    h.presence.start();
    expect(h.dialers).toHaveLength(1);

    h.advance(SUSPEND_TEST_GAP_MS); // the machine slept 15 minutes
    h.tickWatchdog();
    expect(h.dialers[0].stopped).toBe(true); // zombie dropped
    expect(h.dialers).toHaveLength(2); // fresh dial, immediately (no backoff wait)

    // The zombie's LATE close (async teardown) must not clobber the fresh dialer.
    h.dialers[0].fireClosed();
    expect(h.dialers).toHaveLength(2); // ignored — no extra reconnect scheduled
    expect(h.hasTimer()).toBe(false);
  });

  it("watchdog ticks without a sleep gap leave a healthy dialer alone", () => {
    const h = harness();
    h.presence.start();
    h.advance(5000); // normal tick cadence
    h.tickWatchdog();
    h.advance(5000);
    h.tickWatchdog();
    expect(h.dialers).toHaveLength(1);
    expect(h.dialers[0].stopped).toBe(false);
  });

  it("stop() also stops the suspension watchdog", () => {
    const h = harness();
    h.presence.start();
    expect(h.hasWatchdog()).toBe(true);
    h.presence.stop();
    expect(h.hasWatchdog()).toBe(false);
  });

  it("STOPS on a terminal auth refusal (no reconnect) and surfaces the code to the owner", () => {
    // The bug: a dead/rotated session token failed every dial with `unauthorized`, and
    // the supervisor re-dialed forever (quietly, capped at 60s) while the account page
    // said Connected. A terminal refusal must stop the loop and tell the owner.
    const h = harness();
    h.presence.start();
    h.dialers[0].fireAuthError("unauthorized");
    expect(h.authErrors).toEqual(["unauthorized"]);
    expect(h.hasTimer()).toBe(false); // no reconnect scheduled
    h.runTimer(); // no-op
    expect(h.dialers).toHaveLength(1); // never re-dialed
  });

  it("jitters the backoff so a recovering broker avoids a synchronized reconnect stampede", () => {
    const low = harness("tok", () => 0); // 0.75x of base
    low.presence.start();
    low.dialers.at(-1)!.fireClosed();
    expect(low.lastDelay()).toBe(2250);

    const high = harness("tok", () => 0.999); // ~1.25x of base
    high.presence.start();
    high.dialers.at(-1)!.fireClosed();
    expect(high.lastDelay()).toBeGreaterThan(3000);
    expect(high.lastDelay()).toBeLessThanOrEqual(3750);
  });
});
