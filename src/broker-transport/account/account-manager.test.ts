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
  let challenges = 0;
  const api: AccountApi = {
    startDeviceCode: async () => STARTED,
    pollDeviceCode: async () => polls[Math.min(pollI++, polls.length - 1)],
    registerDevice: async (token, input) => {
      registered.push({ token, input });
      return { deviceId: "desk-1", created: true };
    },
    requestPairingChallenge: async () => { challenges++; return { code: "C", expiresAt: 90_000, qrPayload: '{"v":1,"code":"C","connectUrl":"u"}' }; },
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
  return { manager: new AgentxosAccountManager(deps), getState: () => state, registered, challengeCount: () => challenges };
}

const PAIRING = (over: Partial<PairingEntry> = {}): PairingEntry => ({
  pairingId: "p1", desktopDeviceId: "desk-1", phoneDeviceId: "phone-9", desktopLabel: null, phoneLabel: null, createdAt: 1, ...over,
});

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
  it("issues a QR and discovers a phone that pairs DURING the poll", async () => {
    // No pairing exists at login or when the QR goes up; the phone scans on a later poll.
    // listPairings is hit at login-reconcile, the startPairing adopt-check, then each poll —
    // so gate the pairing to appear only after the QR is shown (3rd call onward).
    let calls = 0;
    const { manager, getState, challengeCount } = harness({
      pairings: () => (++calls >= 3 ? [PAIRING()] : []),
    });
    await manager.startLogin();
    await manager.startPairing();
    expect(challengeCount()).toBe(1); // a QR was genuinely issued
    expect(getState()?.pairedPhoneId).toBe("phone-9");
    expect(manager.status().paired).toBe(true);
  });

  it("adopts an existing server-side pairing at login instead of showing a QR", async () => {
    // The bug: sign-out clears the LOCAL pairing but never the server record, so a returning
    // user is still paired. We must adopt it (→ Connected), NOT issue a QR that completes
    // instantly off the stale record and tears the window down before a scan. Regression.
    const { manager, getState, challengeCount } = harness({ pairings: () => [PAIRING()] });
    await manager.startLogin(); // login-time reconcile adopts it
    expect(getState()?.pairedPhoneId).toBe("phone-9");
    expect(manager.status().paired).toBe(true);
    expect(manager.status().pairing).toBeNull(); // never showed a QR
    expect(challengeCount()).toBe(0); // no challenge requested at all
  });

  it("startPairing adopts a pairing that appeared after login, without issuing a QR", async () => {
    // Defense in depth: if login-reconcile missed it (lookup failed, or the pairing landed
    // later), the startPairing guard still adopts rather than showing a doomed QR.
    let exists = false;
    const { manager, getState, challengeCount } = harness({ pairings: () => (exists ? [PAIRING()] : []) });
    await manager.startLogin();
    expect(manager.status().paired).toBe(false);
    exists = true;
    await manager.startPairing();
    expect(challengeCount()).toBe(0); // guard adopted at the first listPairings — no QR
    expect(getState()?.pairedPhoneId).toBe("phone-9");
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
