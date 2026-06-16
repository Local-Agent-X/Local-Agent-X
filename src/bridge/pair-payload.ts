// Canonical pairing-QR payload contract (single source of truth).
//
// The desktop "Pair a phone" panel renders a QR the mobile app scans. The
// mobile chunk-3 parser expects EXACTLY this JSON shape:
//
//   { v: 1, tailnetAddr, pairingSecret, expiresAt }
//
// Defining the shape here (and returning it from the issue route) keeps the
// contract server-authoritative — the browser just encodes the string it's
// handed, so the QR can never drift from the parser. `v` is the schema version
// the phone checks before trusting the rest.

import type { PairingChallenge } from "./pairing.js";

/** Current pairing-payload schema version. Bump only with a parser change. */
export const PAIR_PAYLOAD_VERSION = 1 as const;

export interface PairQrPayload {
  v: typeof PAIR_PAYLOAD_VERSION;
  tailnetAddr: string;
  pairingSecret: string;
  expiresAt: number;
}

/** Build the versioned QR payload object from an issued challenge. */
export function buildPairQrPayload(challenge: PairingChallenge): PairQrPayload {
  return {
    v: PAIR_PAYLOAD_VERSION,
    tailnetAddr: challenge.tailnetAddr,
    pairingSecret: challenge.pairingSecret,
    expiresAt: challenge.expiresAt,
  };
}

/** Serialize the QR payload to the exact string the phone scans + parses. */
export function encodePairQrPayload(challenge: PairingChallenge): string {
  return JSON.stringify(buildPairQrPayload(challenge));
}
