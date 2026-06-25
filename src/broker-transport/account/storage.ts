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
   *  + the account API. Short-TTL; re-login when it expires. */
  sessionToken: string;
  /** Server-assigned device id for THIS desktop (POST /api/devices/register). The
   *  broker `device=` on connect; also what a pairing names this machine by. */
  deviceId: string;
  /** The paired phone's device id — the broker `target=` this desktop waits to meet.
   *  Undefined until a phone scans this desktop's QR + a pairing is discovered. */
  pairedPhoneId?: string;
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
      };
    }
  } catch {
    /* corrupt → treated as signed out */
  }
  return null;
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
