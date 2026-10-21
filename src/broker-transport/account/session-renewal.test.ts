import { describe, it, expect } from "vitest";
import { ApiError } from "./api-client.js";
import { RENEW_AFTER_MS, renewSessionIfDue, type SessionRenewalDeps } from "./session-renewal.js";
import type { AccountState } from "./storage.js";

function harness(initial: AccountState | null, refresh: SessionRenewalDeps["refresh"]) {
  let state = initial;
  let now = 10 * RENEW_AFTER_MS;
  const refused: string[] = [];
  const deps: SessionRenewalDeps = {
    loadState: () => state,
    updateState: (patch) => (state = state ? { ...state, ...patch } : null),
    refresh,
    now: () => now,
    onRefused: (code) => refused.push(code),
    log: () => {},
  };
  return {
    deps,
    refused,
    state: () => state,
    setState: (s: AccountState | null) => void (state = s),
    advance: (ms: number) => void (now += ms),
    now: () => now,
  };
}

const paired: AccountState = { email: "a@x", sessionToken: "old", deviceId: "desk_1", pairedPhoneId: "ph_1" };

describe("renewSessionIfDue", () => {
  it("renews a token from before renewal existed and stamps when", async () => {
    const h = harness({ ...paired }, async (token, deviceId) => `new-for-${token}-${deviceId}`);
    expect(await renewSessionIfDue(h.deps)).toBe("renewed");
    expect(h.state()?.sessionToken).toBe("new-for-old-desk_1");
    expect(h.state()?.sessionRenewedAt).toBe(h.now());
  });

  it("does nothing until a day has passed, then renews", async () => {
    let calls = 0;
    const h = harness(null, async () => `t${++calls}`);
    h.setState({ ...paired, sessionRenewedAt: h.now() });
    h.advance(RENEW_AFTER_MS - 1);
    expect(await renewSessionIfDue(h.deps)).toBe("not_due");
    expect(calls).toBe(0);
    h.advance(1);
    expect(await renewSessionIfDue(h.deps)).toBe("renewed");
    expect(h.state()?.sessionToken).toBe("t1");
  });

  it("an expired token is a terminal refusal (unauthorized)", async () => {
    const h = harness({ ...paired }, async () => {
      throw new ApiError(401, "unauthenticated", "expired");
    });
    expect(await renewSessionIfDue(h.deps)).toBe("refused");
    expect(h.refused).toEqual(["unauthorized"]);
    expect(h.state()?.sessionToken).toBe("old");
  });

  it("a revoked pairing is a terminal refusal (not_paired)", async () => {
    const h = harness({ ...paired }, async () => {
      throw new ApiError(403, "not_paired", "revoked");
    });
    expect(await renewSessionIfDue(h.deps)).toBe("refused");
    expect(h.refused).toEqual(["not_paired"]);
  });

  it("a network failure waits for the next check without refusing", async () => {
    const h = harness({ ...paired }, async () => {
      throw new ApiError(0, "network_error", "offline");
    });
    expect(await renewSessionIfDue(h.deps)).toBe("failed");
    expect(h.refused).toEqual([]);
    expect(h.state()?.sessionToken).toBe("old");
  });

  it("a sign-in that lands while the request is out keeps its own token", async () => {
    const h = harness({ ...paired }, async () => {
      h.setState({ ...paired, sessionToken: "fresh-login" });
      return "renewed-old";
    });
    expect(await renewSessionIfDue(h.deps)).toBe("signed_out");
    expect(h.state()?.sessionToken).toBe("fresh-login");
  });

  it("signed out: nothing to renew", async () => {
    const h = harness(null, async () => "x");
    expect(await renewSessionIfDue(h.deps)).toBe("signed_out");
  });
});
