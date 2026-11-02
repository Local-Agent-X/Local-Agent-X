// The desktop's agentxos ACCOUNT/SESSION state, persisted in ~/.lax (0600 — it holds
// the session bearer token). Distinct from identity.ts (the stable keypair): this is
// what login establishes and logout clears — the session token, the account email, the
// server-assigned deviceId (from registration), and the paired phone's device id (the
// broker `target`, learned once a phone pairs). The broker activation reads this to
// decide whether it can dial (needs token + deviceId + pairedPhoneId all present).

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { atomicWriteFileSync } from "../../server-utils.js";

export interface AccountState {
  /** The signed-in account's email (for display). */
  email: string;
  /** The agentxos session bearer token (device-code login). Presented to the broker
   *  + the account API. Short-TTL; session-renewal.ts swaps it for a fresh one about
   *  once a day while paired, so it only lapses if the desktop is off for a week. */
  sessionToken: string;
  /** When the token was last issued or renewed (epoch ms). Absent on an install that
   *  predates renewal, which renews at the first check. */
  sessionRenewedAt?: number;
  /** Server-assigned device id for THIS desktop (POST /api/devices/register). The
   *  broker `device=` on connect; also what a pairing names this machine by. */
  deviceId: string;
  /** The paired phone's device id — the broker `target=` this desktop waits to meet.
   *  Undefined until a phone scans this desktop's QR + a pairing is discovered. */
  pairedPhoneId?: string;
  /** The phone key this desktop pinned for a pairing, learned from the phone's first
   *  answer after it scanned this desktop's QR (signal-auth.ts). While `deviceId` matches
   *  pairedPhoneId, every answer must be signed by `key`. A different paired phone is
   *  unverified until it, too, pairs by QR. */
  pinnedPhone?: { deviceId: string; key: string };
  /** The one-time secret in the pairing QR this desktop last showed. The phone proves it
   *  scanned that QR with an HMAC under it; cleared once a key is pinned. */
  pairingSecret?: string;
}

function accountPath(): string {
  return join(getLaxDir(), "agentxos-account.json");
}

/** Load the account state, or null if not signed in / corrupt. */
export function loadAccountState(): AccountState | null {
  const path = accountPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AccountState>;
    if (
      typeof parsed.email === "string" &&
      typeof parsed.sessionToken === "string" &&
      typeof parsed.deviceId === "string"
    ) {
      return {
        email: parsed.email,
        sessionToken: parsed.sessionToken,
        deviceId: parsed.deviceId,
        pairedPhoneId: typeof parsed.pairedPhoneId === "string" ? parsed.pairedPhoneId : undefined,
        sessionRenewedAt: typeof parsed.sessionRenewedAt === "number" ? parsed.sessionRenewedAt : undefined,
        pinnedPhone: isPinnedPhone(parsed.pinnedPhone) ? parsed.pinnedPhone : undefined,
        pairingSecret: typeof parsed.pairingSecret === "string" ? parsed.pairingSecret : undefined,
      };
    }
  } catch {
    /* corrupt → treated as signed out */
  }
  return null;
}

function isPinnedPhone(v: unknown): v is { deviceId: string; key: string } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.deviceId === "string" && typeof r.key === "string";
}

/** Persist the full account state (atomic, 0600). */
export function saveAccountState(state: AccountState): void {
  atomicWriteFileSync(accountPath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Merge a patch into the stored state and persist. Returns the new state, or null if
 *  there was nothing to patch (not signed in). Used to record pairedPhoneId post-pairing. */
export function updateAccountState(patch: Partial<AccountState>): AccountState | null {
  const current = loadAccountState();
  if (!current) return null;
  const next: AccountState = { ...current, ...patch };
  saveAccountState(next);
  return next;
}

/** Sign out: remove the persisted session (the keypair identity is kept). */
export function clearAccountState(): void {
  rmSync(accountPath(), { force: true });
}
