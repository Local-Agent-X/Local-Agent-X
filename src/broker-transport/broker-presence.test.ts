import { describe, it, expect } from "vitest";
import { BrokerPresence, type BrokerPresenceDeps, type DialerHandle } from "./broker-presence.js";

interface FakeDialer extends DialerHandle {
  connectUrl: string;
  stopped: boolean;
  fireClosed: () => void;
}

function harness(token = "tok") {
  const dialers: FakeDialer[] = [];
  let timerFn: (() => void) | null = null;
  const deps: BrokerPresenceDeps = {
    createDialer: (connectUrl, _token, onClosed) => {
      const d: FakeDialer = { connectUrl, stopped: false, stop: () => { d.stopped = true; }, fireClosed: onClosed };
      dialers.push(d);
      return d;
    },
    reconnectMs: 3000,
    setTimer: (fn) => {
      timerFn = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      timerFn = null;
    },
  };
  const presence = new BrokerPresence(
    { brokerWsUrl: "wss://broker.agentxos.ai", deviceId: "desk-1", pairedPhoneId: "phone-9", getToken: () => token },
    deps,
  );
  return { presence, dialers, runTimer: () => timerFn?.(), hasTimer: () => timerFn !== null };
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
});
