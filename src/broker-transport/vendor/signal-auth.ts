// Device-key proof on WebRTC signaling. The broker introduces the two devices and relays
// their offer and answer, and the DTLS fingerprints inside those SDPs are what the
// encrypted link is keyed to. A broker that swapped an SDP could therefore sit in the
// middle of the link. Each device signs what it sends with its own ed25519 key, and the
// other checks the signature against the key it learned at QR pairing (which the broker
// never sees), so a swapped SDP fails the check before it is applied.
//
// This file holds only the bytes that get signed and the shape on the wire. Each app
// signs and verifies with its own crypto (node:crypto on the desktop, @noble on the
// phone), so the two must build the message from these functions and nothing else.
//
// Keys, signatures and MACs travel as unpadded base64url.

/** Proof, on the phone's first answer after a QR scan, that it scanned that QR: its
 *  signing key, and an HMAC-SHA256 under the QR's one-time secret (`pairingProofMessage`).
 *  The desktop pins `key` for the pairing only if the MAC checks out. */
export interface PairingProof {
  /** The phone's ed25519 public key, 32 bytes. */
  key: string;
  /** HMAC-SHA256 of `pairingProofMessage` under the QR's pairing secret, 32 bytes. */
  mac: string;
}

/** What an offer or answer carries to prove which device sent it. */
export interface SignalAuth {
  /** ed25519 signature of `signalAuthMessage`, 64 bytes. */
  sig: string;
  pair?: PairingProof;
}

/** What a signature covers. The answer covers the offer it answers too, so an answer can
 *  only be applied to the offer the phone actually saw; the device ids bind both to one
 *  pairing. */
export interface SignalAuthInput {
  kind: "offer" | "answer";
  desktopDeviceId: string;
  phoneDeviceId: string;
  offerSdp: string;
  /** Required when kind is "answer". */
  answerSdp?: string;
}

/** The exact string each side signs and verifies (as UTF-8). JSON keeps every field
 *  length-delimited, so no SDP content can shift one field into another. */
export function signalAuthMessage(input: SignalAuthInput): string {
  return JSON.stringify([
    "agentxos-signal-auth",
    1,
    input.kind,
    input.desktopDeviceId,
    input.phoneDeviceId,
    input.offerSdp,
    input.kind === "answer" ? (input.answerSdp ?? "") : null,
  ]);
}

/** The exact string the pairing MAC covers: the phone's key and the answer it signed. */
export function pairingProofMessage(phoneKey: string, signed: SignalAuthInput): string {
  return JSON.stringify(["agentxos-pairing-proof", 1, phoneKey, signalAuthMessage(signed)]);
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** True when `s` is unpadded base64url of exactly `bytes` bytes. */
export function isBase64UrlOfLength(s: unknown, bytes: number): s is string {
  return typeof s === "string" && BASE64URL.test(s) && s.length === Math.ceil((bytes * 4) / 3);
}

/** Validate an untrusted auth field. A malformed one is dropped (undefined), never
 *  thrown: the receiver then treats the signal as unsigned, and its own policy decides. */
export function parseSignalAuth(raw: unknown): SignalAuth | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  // narrowing an untrusted JSON value to an index signature for field checks
  const r = raw as Record<string, unknown>;
  if (!isBase64UrlOfLength(r.sig, 64)) return undefined;
  if (r.pair === undefined) return { sig: r.sig };
  if (typeof r.pair !== "object" || r.pair === null) return undefined;
  const p = r.pair as Record<string, unknown>;
  if (!isBase64UrlOfLength(p.key, 32) || !isBase64UrlOfLength(p.mac, 32)) return undefined;
  return { sig: r.sig, pair: { key: p.key, mac: p.mac } };
}
