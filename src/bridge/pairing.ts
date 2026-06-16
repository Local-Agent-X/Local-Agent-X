// Bridge pairing handshake (constitution §4, architecture "Auth model").
//
// Flow:
//   1. Desktop issues a short-lived, ONE-SHOT pairing challenge:
//        { tailnetAddr, pairingSecret, expiresAt }
//      The desktop renders this as a QR for the phone to scan.
//   2. Phone POSTs { pairingSecret, deviceLabel }. We verify the secret is
//      live + unused, mint a long-lived per-device token (returned ONCE),
//      record its hash in the device registry, and burn the secret.
//   3. A reused or expired secret is rejected (the route maps that to 409).
//
// The challenge store is in-memory only: pairing secrets are ephemeral by
// design and must not survive a restart (a leaked secret from a previous boot
// should never be claimable). The minted device token is what persists, via
// the registry.

import { randomBytes } from "node:crypto";
import { getDeviceRegistry, type DeviceRecord } from "./device-registry.js";
import { createLogger } from "../logger.js";

const logger = createLogger("bridge.pairing");

/** Pairing secret lifetime. Short by design — the QR is on screen briefly. */
export const PAIRING_TTL_MS = 60_000;

export interface PairingChallenge {
  tailnetAddr: string;
  pairingSecret: string;
  expiresAt: number;
}

interface PendingChallenge {
  secret: string;
  expiresAt: number;
  used: boolean;
}

export type ClaimResult =
  | { ok: true; deviceToken: string; device: Omit<DeviceRecord, "tokenHash"> }
  | { ok: false; reason: string };

// In-memory pending challenges, keyed by the secret itself. One-shot: claiming
// (or expiry sweep) removes the entry.
const pending = new Map<string, PendingChallenge>();

function sweepExpired(now: number): void {
  for (const [secret, c] of pending) {
    if (c.expiresAt <= now || c.used) pending.delete(secret);
  }
}

/**
 * Issue a fresh one-shot pairing challenge. `tailnetAddr` is the address the
 * phone should dial (host:port over the tailnet) — passed in by the caller so
 * this module stays transport-agnostic.
 */
export function issueChallenge(tailnetAddr: string): PairingChallenge {
  const now = Date.now();
  sweepExpired(now);
  const pairingSecret = randomBytes(24).toString("base64url");
  const expiresAt = now + PAIRING_TTL_MS;
  pending.set(pairingSecret, { secret: pairingSecret, expiresAt, used: false });
  logger.info(`[pairing] issued challenge (expires in ${PAIRING_TTL_MS / 1000}s)`);
  return { tailnetAddr, pairingSecret, expiresAt };
}

/**
 * Claim a pairing secret and mint a long-lived per-device token. The raw token
 * is returned ONCE here and never stored — only its hash lands in the registry.
 * A reused, unknown, or expired secret returns { ok:false } so the route can
 * answer 409.
 */
export function claim(pairingSecret: string, deviceLabel: string): ClaimResult {
  const now = Date.now();
  const challenge = pending.get(pairingSecret);
  if (!challenge) return { ok: false, reason: "Unknown or already-used pairing secret" };
  if (challenge.used) { pending.delete(pairingSecret); return { ok: false, reason: "Pairing secret already used" }; }
  if (challenge.expiresAt <= now) { pending.delete(pairingSecret); return { ok: false, reason: "Pairing secret expired" }; }

  // Burn the secret BEFORE minting so a racing second claim can't reuse it.
  challenge.used = true;
  pending.delete(pairingSecret);

  // 256-bit device token. Returned once; the registry keeps only its hash.
  const deviceToken = randomBytes(32).toString("hex");
  const record = getDeviceRegistry().register(deviceLabel, deviceToken);
  const { tokenHash: _drop, ...safe } = record;
  logger.info(`[pairing] device paired: ${record.id} (${record.label})`);
  return { ok: true, deviceToken, device: safe };
}

/** Test seam — clear pending challenges between tests. */
export function clearPendingForTest(): void {
  pending.clear();
}
