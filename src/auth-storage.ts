/**
 * Auth-token at-rest encryption.
 *
 * Wraps the JSON blob written to ~/.lax/auth.json with AES-256-GCM
 * using the OS-keychain master key (see keychain.ts). The plaintext file
 * format that comparable local agents ship is a stolen-laptop hazard —
 * any disk-image leak hands an attacker the user's live OAuth access
 * and refresh tokens. With this wrapper, attackers need the OS keychain
 * (DPAPI / macOS Keychain / libsecret) as well.
 *
 * Envelope format (also the format marker for migration detection):
 *   {
 *     "format": "lax-auth-v1",
 *     "iv": "<base64 12-byte IV>",
 *     "ciphertext": "<base64 ciphertext>",
 *     "tag": "<base64 16-byte GCM auth tag>"
 *   }
 *
 * Legacy plaintext files (with `accessToken` / `refreshToken` at the
 * top level) are detected and returned verbatim so the caller can
 * re-save them encrypted on next load.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getOrCreateMasterKey } from "./keychain.js";
import { createLogger } from "./logger.js";

const logger = createLogger("auth-storage");

export const ENVELOPE_FORMAT = "lax-auth-v1" as const;

interface Envelope {
  format: typeof ENVELOPE_FORMAT;
  iv: string;
  ciphertext: string;
  tag: string;
}

/** Resolve the master key from the OS keychain. Cached per-process so
 *  every saveTokens / loadTokens doesn't re-hit DPAPI / PowerShell. */
let _cachedKey: Buffer | null = null;
function resolveMasterKey(dataDir: string): Buffer {
  if (_cachedKey) return _cachedKey;
  const { key } = getOrCreateMasterKey(dataDir);
  if (key.length !== 32) {
    throw new Error(`auth-storage: master key must be 32 bytes, got ${key.length}`);
  }
  _cachedKey = key;
  return key;
}

/** Test seam: drop the cached key so a test can swap the underlying keychain. */
export function _resetMasterKeyCacheForTests(): void {
  _cachedKey = null;
}

/** Encrypt with an explicit key. Pure function — used by the public
 *  `encryptAuthBlob` and by tests that want to verify wrong-key rejection. */
export function encryptWithKey(plaintext: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error(`auth-storage: encryption key must be 32 bytes, got ${key.length}`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const env: Envelope = {
    format: ENVELOPE_FORMAT,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
  return JSON.stringify(env);
}

/** Decrypt an envelope with an explicit key. Throws on tamper / wrong key
 *  (AES-GCM auth tag failure) or malformed envelope. */
export function decryptWithKey(envelopeJson: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error(`auth-storage: decryption key must be 32 bytes, got ${key.length}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeJson);
  } catch (e) {
    throw new Error(`auth-storage: envelope is not valid JSON: ${(e as Error).message}`);
  }
  if (!isEnvelope(parsed)) {
    throw new Error("auth-storage: envelope is missing required fields (format/iv/ciphertext/tag)");
  }
  const iv = Buffer.from(parsed.iv, "base64");
  const ciphertext = Buffer.from(parsed.ciphertext, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  if (iv.length !== 12) {
    throw new Error(`auth-storage: iv must be 12 bytes, got ${iv.length}`);
  }
  if (tag.length !== 16) {
    throw new Error(`auth-storage: tag must be 16 bytes, got ${tag.length}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf-8");
}

/** Type guard for the envelope shape. */
function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.format === ENVELOPE_FORMAT &&
    typeof o.iv === "string" &&
    typeof o.ciphertext === "string" &&
    typeof o.tag === "string"
  );
}

/** Detect whether a string is a legacy plaintext OAuth tokens blob.
 *  Plaintext files have `accessToken`/`refreshToken` at the top level. */
function isLegacyPlaintext(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.accessToken === "string" && typeof o.refreshToken === "string";
}

/** Encrypt a JSON string using the OS-keychain master key. */
export function encryptAuthBlob(plaintext: string, dataDir: string): string {
  const key = resolveMasterKey(dataDir);
  return encryptWithKey(plaintext, key);
}

/**
 * Decrypt or pass through. If the input is an envelope, decrypts and
 * returns the inner JSON with `wasEncrypted: true`. If the input is
 * legacy plaintext (recognized by top-level `accessToken`), returns it
 * verbatim with `wasEncrypted: false`. Any other shape (malformed,
 * tampered, wrong key) throws — the caller treats it as a load failure.
 */
export function decryptAuthBlob(
  blob: string,
  dataDir: string,
): { plaintext: string; wasEncrypted: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch (e) {
    throw new Error(`auth-storage: input is not valid JSON: ${(e as Error).message}`);
  }
  if (isLegacyPlaintext(parsed)) {
    return { plaintext: blob, wasEncrypted: false };
  }
  if (isEnvelope(parsed)) {
    const key = resolveMasterKey(dataDir);
    const plaintext = decryptWithKey(blob, key);
    return { plaintext, wasEncrypted: true };
  }
  throw new Error(
    "auth-storage: blob is neither legacy plaintext nor a recognized envelope — refusing to guess",
  );
}

/** Surface the cached key for diagnostics. Exported for the unencrypted
 *  fallback path in saveTokens, so we can log which keychain provider
 *  was used. */
export function getCachedKeyInfo(): { hasKey: boolean } {
  return { hasKey: _cachedKey !== null };
}

// Re-export the logger so the wiring module can share a tag. Not used
// internally here; kept for symmetry with secrets.ts.
export { logger as _authStorageLogger };
