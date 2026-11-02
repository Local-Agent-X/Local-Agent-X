// What the desktop's pairing QR encodes — a tiny, pure payload builder/parser. NO
// QR-image library is pulled in (this package stays offline-safe and client-bundle
// safe, constitution §6); the desktop app renders the returned string as a QR and
// the phone app parses the scanned string back.
//
// The server builds the payload with the one-time challenge code and the broker
// connect URL — both non-secret (the code is single-use and TTL'd; the URL is public).
// The desktop then adds two fields of its own with `withDeviceKey` before it renders
// the QR: its device public key and a one-time pairing secret. Those never pass
// through the broker or the server, which is what lets the phone and the desktop
// recognize each other later without trusting the broker (signal-auth.ts). They are
// optional, so a phone build from before them still reads the code and connect URL.

/** The fields a scanned QR yields. `code` is the one-time PairingChallenge code;
 *  `connectUrl` is where the phone POSTs the scan to redeem it. */
export interface QrPairingPayload {
  v: number;
  code: string;
  connectUrl: string;
  /** The desktop's ed25519 signing key, 32 bytes base64url. */
  desktopKey?: string;
  /** The one-time secret the phone proves it scanned, 32 bytes base64url. */
  pairingSecret?: string;
}

/** Payload schema version, so a future field change is detectable by old clients. */
export const QR_PAIRING_PAYLOAD_VERSION = 1;

/** Build the string the desktop renders as a QR. JSON keeps it self-describing and
 *  versioned. */
export function buildQrPayload(code: string, connectUrl: string): string {
  const payload: QrPairingPayload = { v: QR_PAIRING_PAYLOAD_VERSION, code, connectUrl };
  return JSON.stringify(payload);
}

/** The desktop's step: add its key and a fresh pairing secret to the server's payload.
 *  Returns null when the server's payload doesn't parse. */
export function withDeviceKey(serverPayload: string, desktopKey: string, pairingSecret: string): string | null {
  const parsed = parseQrPayload(serverPayload);
  if (!parsed) return null;
  const payload: QrPairingPayload = { ...parsed, desktopKey, pairingSecret };
  return JSON.stringify(payload);
}

/**
 * Parse a scanned QR string back to its fields. The scanned text is
 * attacker-controlled, so every field is validated at this boundary (constitution:
 * validate untrusted input) and a malformed payload returns null rather than
 * throwing — the caller surfaces an actionable "couldn't read that QR" message.
 * The key fields come back only as a well-formed pair; a half or malformed pair is
 * dropped, and the phone pairs as it did before them.
 */
export function parseQrPayload(raw: string): QrPairingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  // narrowing an untrusted JSON value to an index signature for field checks
  const r = parsed as Record<string, unknown>;
  if (r.v !== QR_PAIRING_PAYLOAD_VERSION) return null;
  if (typeof r.code !== "string" || r.code.length === 0) return null;
  if (typeof r.connectUrl !== "string" || r.connectUrl.length === 0) return null;
  const payload: QrPairingPayload = { v: QR_PAIRING_PAYLOAD_VERSION, code: r.code, connectUrl: r.connectUrl };
  if (isKey(r.desktopKey) && isKey(r.pairingSecret)) {
    payload.desktopKey = r.desktopKey;
    payload.pairingSecret = r.pairingSecret;
  }
  return payload;
}

/** 32 bytes as unpadded base64url. Local, not signal-auth's helper, so the QR contract
 *  stays importable on its own. */
function isKey(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);
}
