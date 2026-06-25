import { describe, it, expect } from "vitest";
import { AgentxosAccountManager, type AccountApi, type AccountManagerDeps } from "./account-manager.js";
import type { AccountState } from "./storage.js";
import type { DeviceCodePoll, PairingEntry, StartedDeviceCode } from "./api-client.js";

const STARTED: StartedDeviceCode = {
  deviceCode: "dc", userCode: "ABCD2345", userCodeDisplay: "ABCD-2345",
  verificationUri: "https://app.agentxos.ai/link", verificationUriComplete: "https://app.agentxos.ai/link?code=ABCD2345",
  expiresIn: 600, interval: 5,
};

/** A controllable fake of the account API + an in-memory store. */
function harness(opts: { polls?: DeviceCodePoll[]; pairings?: () => PairingEntry[] } = {}) {
  let state: AccountState | null = null;
  let pollI = 0;
  const polls = opts.polls ?? [{ status: "approved", token: "TOK", accountId: "acct-1", email: "a@b.co" }];
  const registered: unknown[] = [];
  const api: AccountApi = {
    startDeviceCode: async () => STARTED,
    pollDeviceCode: async () => polls[Math.min(pollI++, polls.length - 1)],
    registerDevice: async (token, input) => {
      registered.push({ token, input });
      return { deviceId: "desk-1", created: true };
    },
    requestPairingChallenge: async () => ({ code: "C", expiresAt: 90_000, qrPayload: '{"v":1,"code":"C","connectUrl":"u"}' }),
    listPairings: async () => (opts.pairings ? opts.pairings() : []),
  };
  let t = 0;
  const deps: AccountManagerDeps = {
    api,
    identity: () => ({ publicKey: "PUBPEM", privateKey: "PRIVPEM" }),
    deviceLabel: "Test-Mac",
    loadState: () => state,
    saveState: (s) => { state = s; },
    updateState: (patch) => { state = state ? { ...state, ...patch } : null; return state; },
    clearState: () => { state = null; },
    renderQr: async (text) => `data:image/png;base64,${Buffer.from(text).toString("base64")}`,
    sleep: async () => { t += 2000; },
    now: () => t,
  };
  return { manager: new AgentxosAccountManager(deps), getState: () => state, registered };
}

describe("AgentxosAccountManager — login", () => {
  it("logs in, registers the desktop, and persists the session", async () => {
    const { manager, getState, registered } = harness({
      polls: [{ status: "pending" }, { status: "approved", token: "TOK", accountId: "acct-1", email: "a@b.co" }],
    });
    await manager.startLogin();
    const s = getState();
    expect(s).toMatchObject({ email: "a@b.co", sessionToken: "TOK", deviceId: "desk-1" });
    expect(registered).toEqual([{ token: "TOK", input: { kind: "desktop", publicKey: "PUBPEM", label: "Test-Mac" } }]);
    expect(manager.status().signedIn).toBe(true);
  });

  it("surfaces an actionable error when the grant is denied (and stays signed out)", async () => {
    const { manager, getState } = harness({ polls: [{ status: "denied" }] });
    await manager.startLogin();
    expect(getState()).toBeNull();
    expect(manager.status().error).toMatch(/rejected/i);
  });

  it("does not start a second login when already signed in", async () => {
    const { manager } = harness();
    await manager.startLogin(); // signs in
    const before = manager.status();
    await manager.startLogin(); // no-op
    expect(manager.status().signedIn).toBe(before.signedIn);
  });
});

describe("AgentxosAccountManager — pairing", () => {
  it("issues a QR, discovers the paired phone, and stores its id", async () => {
    // The phone 'pairs' after the first poll: listPairings returns the pairing.
    let paired = false;
    const { manager, getState } = harness({
      pairings: () => (paired ? [{ pairingId: "p1", desktopDeviceId: "desk-1", phoneDeviceId: "phone-9", desktopLabel: null, phoneLabel: null, createdAt: 1 }] : []),
    });
    await manager.startLogin();
    paired = true; // phone scans + redeems between issue and the first discovery poll
    await manager.startPairing();
    expect(getState()?.pairedPhoneId).toBe("phone-9");
    expect(manager.status().paired).toBe(true);
  });

  it("times out with an actionable error if no phone pairs before expiry", async () => {
    const { manager } = harness({ pairings: () => [] }); // never pairs
    await manager.startLogin();
    await manager.startPairing();
    expect(manager.status().paired).toBe(false);
    expect(manager.status().error).toMatch(/timed out/i);
  });

  it("won't pair when signed out", async () => {
    const { manager } = harness();
    await manager.startPairing(); // not signed in → no-op
    expect(manager.status().pairing).toBeNull();
  });
});
