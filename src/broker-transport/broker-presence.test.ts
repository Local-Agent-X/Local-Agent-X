import { describe, it, expect } from "vitest";
import { BrokerPresence, MAX_RECONNECT_MS, type BrokerPresenceDeps, type DialerHandle } from "./broker-presence.js";

interface FakeDialer extends DialerHandle {
  connectUrl: string;
  stopped: boolean;
  fireClosed: () => void;
}

function harness(token = "tok", random: () => number = () => 0.5) {
  const dialers: FakeDialer[] = [];
  let timerFn: (() => void) | null = null;
  let lastDelay = 0;
  let clock = 0; // tests advance this to simulate dialer uptime
  const deps: BrokerPresenceDeps = {
    createDialer: (connectUrl, _token, onClosed) => {
      const d: FakeDialer = { connectUrl, stopped: false, stop: () => { d.stopped = true; }, fireClosed: onClosed };
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
    now: () => clock,
    random, // default 0.5 → no jitter: backoff lands exactly on the capped base*factor^n
  };
  const presence = new BrokerPresence(
    { brokerWsUrl: "wss://broker.agentxos.ai", deviceId: "desk-1", pairedPhoneId: "phone-9", getToken: () => token },
    deps,
  );
  return {
    presence,
    dialers,
    runTimer: () => timerFn?.(),
    hasTimer: () => timerFn !== null,
    lastDelay: () => lastDelay,
    advance: (ms: number) => { clock += ms; },
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
