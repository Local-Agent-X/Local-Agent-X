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

import { deviceCodeLogin, withDeviceKey, type LoginPrompt } from "../vendor/index.js";
import type {
  StartedDeviceCode,
  DeviceCodePoll,
  RegisteredDevice,
  IssuedPairing,
  PairingEntry,
} from "../vendor/index.js";
import type { DeviceIdentity } from "./identity.js";
import { pinnedKeyFor } from "../signal-auth.js";
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
  /** The paired phone's key is pinned, so every connection from it is checked
   *  (signal-auth.ts). False for a pairing made before pinning existed. */
  phoneVerified: boolean;
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
  /** This desktop's public key as the QR carries it (identity.ts rawPublicKey). */
  rawPublicKey: () => string;
  /** A fresh one-time pairing secret: 32 random bytes, unpadded base64url. */
  newPairingSecret: () => string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Called once a pairing is established — the activation hook starts broker presence. */
  onPaired?: (state: AccountState) => void;
}

/** Poll interval while waiting for the phone to scan + redeem the QR. */
const PAIR_POLL_MS = 2000;
/** Grace after the challenge expiry to catch a pairing created just before it. */
const PAIR_GRACE_MS = 5000;

/** This desktop's pairings, newest first. The server keeps every pairing a desktop
 *  has made — a new phone adds a row and the old one stays — so "the" pairing is the
 *  newest, and a re-pair is done when a row appears that was not there before. Taking
 *  the FIRST row for this desktop kept a Mac on a July phone after a second phone
 *  paired with it (2026-11-06): the poll never saw a change and the new phone's
 *  "couldn't connect" had no desktop waiting for it at the broker. */
function pairingsOf(pairings: PairingEntry[], deviceId: string): PairingEntry[] {
  return pairings.filter((p) => p.desktopDeviceId === deviceId).sort((a, b) => b.createdAt - a.createdAt);
}

const rowKey = (p: PairingEntry) => `${p.pairingId}|${p.phoneDeviceId}`;

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
      phoneVerified: s ? pinnedKeyFor(s) !== null : false,
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
      const saved: AccountState = {
        email: result.email,
        sessionToken: result.token,
        deviceId: reg.deviceId,
        sessionRenewedAt: this.deps.now(),
      };
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
    const [mine] = pairingsOf(await this.deps.api.listPairings(state.sessionToken), state.deviceId);
    if (!mine) return false;
    const next = this.deps.updateState({ pairedPhoneId: mine.phoneDeviceId });
    if (next) this.deps.onPaired?.(next);
    return true;
  }

  /** Begin pairing: request a challenge, show its QR, then poll until a phone redeems
   *  it and the pairing appears. No-op if not signed in / already paired / running.
   *  `force` shows a QR even while paired (re-pair): a phone that never actually scanned
   *  this desktop — login adopts lingering server pairings, so "Connected" doesn't prove
   *  the phone knows about us — can scan it without a destructive Disconnect first. */
  startPairing(opts: { force?: boolean } = {}): Promise<void> {
    const state = this.deps.loadState();
    if (!state || this.pairingRunning) return Promise.resolve();
    if (state.pairedPhoneId && !opts.force) return Promise.resolve();
    this.pairingRunning = true;
    this.error = null;
    return this.runPairing(state, Boolean(opts.force && state.pairedPhoneId));
  }

  private async runPairing(state: AccountState, repair: boolean): Promise<void> {
    try {
      // Already paired server-side? Adopt it instead of issuing a challenge: the poll below
      // would otherwise find the stale pairing on its first tick and "complete" instantly,
      // tearing the QR down before you could scan it. A forced re-pair instead SNAPSHOTS
      // every existing row, so the poll completes only on a row it has not seen — the
      // pairing the scanning phone just created — never on a pre-existing one.
      let seen = new Set<string>();
      if (repair) {
        const rows = pairingsOf(await this.deps.api.listPairings(state.sessionToken), state.deviceId);
        // Behind the server? A phone that already redeemed this desktop's QR has a row a
        // re-scan would only return again (redeem is idempotent) — adopt it, no QR.
        if (rows[0] && rows[0].phoneDeviceId !== state.pairedPhoneId) {
          const next = this.deps.updateState({ pairedPhoneId: rows[0].phoneDeviceId });
          if (next) this.deps.onPaired?.(next);
          return;
        }
        seen = new Set(rows.map(rowKey));
      } else if (await this.adoptExistingPairing(state)) return;
      const issued = await this.deps.api.requestPairingChallenge(state.sessionToken, state.deviceId);
      this.pairing = { qrDataUrl: await this.deps.renderQr(this.withKey(issued.qrPayload)), expiresAt: issued.expiresAt };

      const deadline = issued.expiresAt + PAIR_GRACE_MS;
      while (this.deps.now() < deadline) {
        await this.deps.sleep(PAIR_POLL_MS);
        const fresh = pairingsOf(await this.deps.api.listPairings(state.sessionToken), state.deviceId)
          .find((p) => !seen.has(rowKey(p)));
        if (fresh) {
          const next = this.deps.updateState({ pairedPhoneId: fresh.phoneDeviceId });
          if (next) this.deps.onPaired?.(next);
          return;
        }
      }
      // A same-phone re-scan redeems idempotently (same row, no change to detect) and needs
      // no state change here — so a re-pair QR lapsing is NOT an error; we're still paired.
      if (!repair) this.error = "Pairing timed out — generate a new QR and scan it again.";
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.pairingRunning = false;
      this.pairing = null;
    }
  }

  /** Add this desktop's key and a fresh pairing secret to the server's QR payload, so the
   *  phone that scans it can prove so on its first connection (signal-auth.ts). Neither
   *  passes through the server or the broker. The secret is saved first: the QR must
   *  never show one the desktop can't check. */
  private withKey(serverPayload: string): string {
    const secret = this.deps.newPairingSecret();
    const shown = withDeviceKey(serverPayload, this.deps.rawPublicKey(), secret);
    if (!shown) return serverPayload;
    this.deps.updateState({ pairingSecret: secret });
    return shown;
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
      // Every row: revoking only the first left a newer phone's pairing live, and the next
      // sign-in re-adopted it.
      for (const p of pairingsOf(await this.deps.api.listPairings(state.sessionToken), state.deviceId)) {
        await this.deps.api.revokePairing(state.sessionToken, p.pairingId);
      }
      this.deps.updateState({ pairedPhoneId: undefined, pinnedPhone: undefined, pairingSecret: undefined });
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** Surface a terminal broker auth refusal on the account page. The persisted session
   *  LOOKS signed-in ("Connected"), but the broker rejects its token/pairing — without
   *  this the desktop's presence loop died quietly and the user had no idea why the
   *  phone couldn't connect. Cleared by the next startLogin/signOut. */
  flagSessionInvalid(message: string): void {
    this.error = message;
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
