// AgentxosAccountManager — the desktop server's orchestration of agentxos account
// setup: device-code login → device registration → QR pairing → discover the paired
// phone. The in-app account page drives it through thin HTTP endpoints that call
// startLogin()/startPairing()/status()/signOut(); the actual device-code + pairing
// poll loops run in the BACKGROUND here, and the page reflects their progress by
// polling status() (the in-flight login prompt / pairing QR live in this manager).
//
// Pure over injected deps (api client, identity, storage fns, QR renderer, clock/sleep),
// so the whole flow unit-tests offline with fakes. The one stateful thing it owns is the
// in-flight UI state (loginPrompt / pairing); persisted state lives in storage.ts.

import { deviceCodeLogin, type LoginPrompt } from "./device-code-login.js";
import type {
  StartedDeviceCode,
  DeviceCodePoll,
  RegisteredDevice,
  IssuedPairing,
  PairingEntry,
} from "./api-client.js";
import type { DeviceIdentity } from "./identity.js";
import type { AccountState } from "./storage.js";

/** The api surface the manager uses (AgentxosApiClient satisfies it; tests fake it). */
export interface AccountApi {
  startDeviceCode(): Promise<StartedDeviceCode>;
  pollDeviceCode(deviceCode: string): Promise<DeviceCodePoll>;
  registerDevice(
    token: string,
    input: { kind: "desktop" | "phone"; publicKey: string; label: string },
  ): Promise<RegisteredDevice>;
  requestPairingChallenge(token: string, desktopDeviceId: string): Promise<IssuedPairing>;
  listPairings(token: string): Promise<PairingEntry[]>;
  revokePairing(token: string, pairingId: string): Promise<void>;
}

/** What the account page renders. `login`/`pairing` are non-null only while a flow is
 *  in progress; persisted facts (signedIn/paired) come from storage. */
export interface AccountStatus {
  signedIn: boolean;
  email: string | null;
  deviceId: string | null;
  paired: boolean;
  pairedPhoneId: string | null;
  /** In-flight device-code login prompt (what to type + where), or null. */
  login: LoginPrompt | null;
  /** In-flight pairing QR (data URL + challenge expiry), or null. */
  pairing: { qrDataUrl: string; expiresAt: number } | null;
  /** Last actionable error from a flow, surfaced to the page (§16). */
  error: string | null;
}

export interface AccountManagerDeps {
  api: AccountApi;
  /** This machine's stable identity (getOrCreateDeviceIdentity). */
  identity: () => DeviceIdentity;
  /** A human label for this device on registration (e.g. os.hostname()). */
  deviceLabel: string;
  loadState: () => AccountState | null;
  saveState: (state: AccountState) => void;
  updateState: (patch: Partial<AccountState>) => AccountState | null;
  clearState: () => void;
  renderQr: (text: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Called once a pairing is established — the activation hook starts broker presence. */
  onPaired?: (state: AccountState) => void;
}

/** Poll interval while waiting for the phone to scan + redeem the QR. */
const PAIR_POLL_MS = 2000;
/** Grace after the challenge expiry to catch a pairing created just before it. */
const PAIR_GRACE_MS = 5000;

export class AgentxosAccountManager {
  private readonly deps: AccountManagerDeps;
  private loginPrompt: LoginPrompt | null = null;
  private loginRunning = false;
  private pairing: { qrDataUrl: string; expiresAt: number } | null = null;
  private pairingRunning = false;
  private error: string | null = null;

  constructor(deps: AccountManagerDeps) {
    this.deps = deps;
  }

  status(): AccountStatus {
    const s = this.deps.loadState();
    return {
      signedIn: s !== null,
      email: s?.email ?? null,
      deviceId: s?.deviceId ?? null,
      paired: Boolean(s?.pairedPhoneId),
      pairedPhoneId: s?.pairedPhoneId ?? null,
      login: this.loginPrompt,
      pairing: this.pairing,
      error: this.error,
    };
  }

  /** Begin device-code login (no-op if already signed in or a login is running). The
   *  poll runs in the background; the page sees the prompt via status(). Returns the
   *  background task so tests can await completion. */
  startLogin(): Promise<void> {
    if (this.loginRunning || this.deps.loadState()) return Promise.resolve();
    this.loginRunning = true;
    this.error = null;
    return this.runLogin();
  }

  private async runLogin(): Promise<void> {
    try {
      const result = await deviceCodeLogin({
        api: this.deps.api,
        onPrompt: (p) => {
          this.loginPrompt = p;
        },
        sleep: this.deps.sleep,
        now: this.deps.now,
      });
      if (!result.ok) {
        this.error = loginErrorMessage(result.reason);
        return;
      }
      // Register THIS desktop under the account (idempotent on the public key).
      const id = this.deps.identity();
      const reg = await this.deps.api.registerDevice(result.token, {
        kind: "desktop",
        publicKey: id.publicKey,
        label: this.deps.deviceLabel,
      });
      const saved: AccountState = { email: result.email, sessionToken: result.token, deviceId: reg.deviceId };
      this.deps.saveState(saved);
      // A returning user (signed out, then back in) is still paired server-side — sign-out
      // never revokes the pairing. Reconcile so we show "Connected" instead of a QR that
      // can't pair anything. Best-effort: a failed lookup just falls through to the pairing
      // screen, whose own guard re-checks before ever showing a QR.
      try { await this.adoptExistingPairing(saved); } catch { /* best-effort reconcile */ }
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loginRunning = false;
      this.loginPrompt = null;
    }
  }

  /** Adopt this desktop's existing server-side pairing if one is live. Sign-out clears the
   *  LOCAL pairing but never the server record, and redeem is idempotent (re-scanning the
   *  same phone returns the SAME pairing) — so a pre-existing pairing means we ARE paired and
   *  there is nothing to scan. Sets pairedPhoneId + fires onPaired. Returns whether it found one. */
  private async adoptExistingPairing(state: AccountState): Promise<boolean> {
    const mine = (await this.deps.api.listPairings(state.sessionToken)).find(
      (p) => p.desktopDeviceId === state.deviceId,
    );
    if (!mine) return false;
    const next = this.deps.updateState({ pairedPhoneId: mine.phoneDeviceId });
    if (next) this.deps.onPaired?.(next);
    return true;
  }

  /** Begin pairing: request a challenge, show its QR, then poll until a phone redeems
   *  it and the pairing appears. No-op if not signed in / already paired / running. */
  startPairing(): Promise<void> {
    const state = this.deps.loadState();
    if (!state || this.pairingRunning || state.pairedPhoneId) return Promise.resolve();
    this.pairingRunning = true;
    this.error = null;
    return this.runPairing(state);
  }

  private async runPairing(state: AccountState): Promise<void> {
    try {
      // Already paired server-side? Adopt it instead of issuing a challenge: the poll below
      // would otherwise find the stale pairing on its first tick and "complete" instantly,
      // tearing the QR down before you could scan it.
      if (await this.adoptExistingPairing(state)) return;
      const issued = await this.deps.api.requestPairingChallenge(state.sessionToken, state.deviceId);
      this.pairing = { qrDataUrl: await this.deps.renderQr(issued.qrPayload), expiresAt: issued.expiresAt };

      const deadline = issued.expiresAt + PAIR_GRACE_MS;
      while (this.deps.now() < deadline) {
        await this.deps.sleep(PAIR_POLL_MS);
        const pairings = await this.deps.api.listPairings(state.sessionToken);
        const mine = pairings.find((p) => p.desktopDeviceId === state.deviceId);
        if (mine) {
          const next = this.deps.updateState({ pairedPhoneId: mine.phoneDeviceId });
          if (next) this.deps.onPaired?.(next);
          return;
        }
      }
      this.error = "Pairing timed out — generate a new QR and scan it again.";
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.pairingRunning = false;
      this.pairing = null;
    }
  }

  /** Disconnect the paired phone for REAL: revoke the server-side pairing (not just the
   *  local record — sign-out leaves the pairing live, which is why a re-login re-adopts it)
   *  and clear pairedPhoneId. After this the page drops to "Pair your phone". The caller
   *  stops broker presence. No-op if signed out. */
  async unpair(): Promise<void> {
    const state = this.deps.loadState();
    if (!state) return;
    this.error = null;
    try {
      const mine = (await this.deps.api.listPairings(state.sessionToken)).find(
        (p) => p.desktopDeviceId === state.deviceId,
      );
      if (mine) await this.deps.api.revokePairing(state.sessionToken, mine.pairingId);
      this.deps.updateState({ pairedPhoneId: undefined });
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** Sign out: clear the persisted session (the keypair identity is kept). In-flight
   *  state is reset; the caller stops any broker presence. */
  signOut(): void {
    this.deps.clearState();
    this.loginPrompt = null;
    this.pairing = null;
    this.error = null;
  }
}

/** Actionable copy for a terminal login outcome (§16). */
function loginErrorMessage(reason: "expired" | "denied" | "aborted"): string {
  if (reason === "expired") return "Sign-in timed out. Start again to get a new code.";
  if (reason === "denied") return "That sign-in code was rejected. Start again.";
  return "Sign-in was cancelled.";
}
