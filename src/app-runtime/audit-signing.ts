import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getOrCreateMasterKey } from "../keychain.js";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";
import type { AuditEntry } from "./types.js";

const logger = createLogger("audit.signing");

// Persistent HMAC key (the audit "seed") for tamper detection. Resolution:
//   1. process.env.LAX_AUDIT_KEY (ops-managed override — never persisted)
//   2. <laxDir>/audit-key.enc — the seed sealed with the OS-keychain master
//      key (AES-256-GCM). A legacy plaintext <laxDir>/audit-key is migrated
//      into this form on first read (SAME bytes — a migration, never a
//      rotation) and then securely wiped.
//   3. In-process random fallback if the seed can't be resolved (loud error).
//
// Why sealed: a plaintext seed file let a filesystem-only attacker read it and
// forge the entire chain — directly defeating the "filesystem-only attacker
// cannot forge" property the audit trail advertises. Sealing it under the
// keychain master key means an at-rest/disk/backup/swap reader gets only
// ciphertext; forging now needs the OS-login-gated master key.
// Honest limit: a LIVE process can still recover the seed (it holds the master
// key), so this closes the at-rest vector, NOT a live-process compromise.
// True forward-secrecy would need the seed escrowed off-device.
//
// Cached per-process. Persisting is the whole point — signatures must survive
// restarts so a hash-chained audit log stays verifiable across reboots.

let cachedKey: Buffer | string | null = null;

function encPath(): string {
  return join(getLaxDir(), "audit-key.enc");
}

function plaintextPath(): string {
  return join(getLaxDir(), "audit-key");
}

/** AES-256-GCM seal: output hex = iv(12) || authTag(16) || ciphertext. */
function sealSeed(seed: Buffer, masterKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(seed), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("hex");
}

/** Inverse of sealSeed. Throws if the auth tag fails (wrong master key). */
function openSeed(hex: string, masterKey: Buffer): Buffer {
  const data = Buffer.from(hex, "hex");
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ct = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Atomic write (tmp + rename), mode 0o600 — mirrors the old key writer. */
function writeAtomic(path: string, contents: string | Buffer): void {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Best-effort wipe of a plaintext seed file: overwrite then unlink. */
function shredPlaintext(path: string): void {
  try {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size > 0) writeFileSync(path, randomBytes(size), { mode: 0o600 });
    unlinkSync(path);
  } catch { /* best-effort — namespace removal is the point, not forensic erasure */ }
}

function loadOrCreateProtectedKey(): Buffer {
  // file-fallback never throws (returns a machine-identity key); keychain
  // strength tracks the provider. Seal strength == master-key strength.
  const masterKey = getOrCreateMasterKey(getLaxDir()).key;
  const enc = encPath();
  const plain = plaintextPath();

  // 1. Sealed seed already present — open it (and drop any stale plaintext).
  if (existsSync(enc)) {
    const seed = openSeed(readFileSync(enc, "utf-8").trim(), masterKey);
    shredPlaintext(plain);
    return seed;
  }

  // 2. Legacy plaintext seed — migrate the SAME bytes into the sealed store,
  //    then wipe the plaintext. Not a rotation: existing chains still verify.
  if (existsSync(plain)) {
    const seed = readFileSync(plain);
    writeAtomic(enc, sealSeed(seed, masterKey));
    shredPlaintext(plain);
    logger.info("[audit] migrated plaintext audit seed into keychain-sealed store (audit-key.enc)");
    return seed;
  }

  // 3. First run — generate a fresh seed and store only the sealed form.
  const seed = randomBytes(32);
  writeAtomic(enc, sealSeed(seed, masterKey));
  return seed;
}

export function getAuditHmacKey(): Buffer | string {
  if (cachedKey !== null) return cachedKey;
  const envKey = process.env.LAX_AUDIT_KEY;
  if (envKey) {
    cachedKey = envKey;
    return cachedKey;
  }
  try {
    cachedKey = loadOrCreateProtectedKey();
    return cachedKey;
  } catch (err) {
    // Seed unresolvable: keychain/master-key unavailable, or an existing
    // audit-key.enc that won't open (master key rotated). We do NOT
    // regenerate over an existing sealed seed — that would silently
    // invalidate every prior entry (the keychain.ts:217 rotation incident
    // class). Fall back to an in-process key so auditing continues this
    // process; entries won't verify across restart until the seed is
    // recovered. Loud log so it's visible.
    // eslint-disable-next-line no-console
    console.error("[audit] failed to resolve sealed HMAC seed, using in-process fallback:", err);
    cachedKey = randomBytes(32);
    return cachedKey;
  }
}

// Test hook — reset the in-process cache so each test gets a fresh resolve.
// Not exported via the barrel; only used by the audit-signing test file.
export function _resetAuditKeyCacheForTests(): void {
  cachedKey = null;
}

/**
 * Is a REAL persisted/env audit seed resolvable right now, WITHOUT minting one?
 * True iff the ops env override is set, or a sealed/legacy seed file already
 * exists on disk. This deliberately does NOT call getAuditHmacKey() (which would
 * MINT and persist a fresh seed on first run) and deliberately ignores any
 * in-process random fallback in `cachedKey` (that fallback is not a persisted
 * seed — it can't survive a restart, so it must not be treated as one).
 *
 * Why it exists: the threat audit trail's "hmac-v1 era" ratchet keys off seed
 * PRESENCE, not just the on-disk era marker/row tags. A keyed install signs
 * 100% hmac-v1, so if a seed exists the unkeyed legacy verify path must be
 * unreachable — otherwise a filesystem-only attacker who deletes the marker and
 * rewrites every row as plain SHA-256 downgrades back onto it. Presence here is
 * the upstream signal that closes that downgrade.
 */
export function hasPersistedAuditKey(): boolean {
  if (process.env.LAX_AUDIT_KEY) return true;
  return existsSync(encPath()) || existsSync(plaintextPath());
}

// Keyed MAC over a fixed marker string, used by the threat audit trail to seal
// its "hmac-v1 era has begun" marker file under the SAME audit key. Computing or
// validating the marker requires the key, so a filesystem-only attacker can
// neither forge the marker nor delete-and-recreate it convincingly — exactly the
// property the sealed seed gives the key itself. Kept here (not in audit-trail)
// so all audit-key use stays behind this one provider.
export function computeAuditMarkerMac(marker: string): string {
  return createHmac("sha256", getAuditHmacKey()).update(marker).digest("hex");
}

export function signAuditEntry(entry: Omit<AuditEntry, "signature">): string {
  const payload = `${entry.id}|${entry.timestamp}|${entry.actor}|${entry.action}|${entry.appId}|${entry.prevHash}`;
  return createHmac("sha256", getAuditHmacKey()).update(payload).digest("hex").slice(0, 16);
}

// SHA-256 of the previous entry's signature, used to chain entries. Choosing
// the signature (not the full canonical payload) keeps the derive function
// simple and means a tampered prior entry breaks the chain regardless of
// whether the attacker fixed the signature — they'd have to fix every
// subsequent prevHash too, which requires the HMAC key.
export function deriveChainHash(prevSignature: string): string {
  return createHash("sha256").update(prevSignature).digest("hex");
}

export const GENESIS_PREV_HASH = "genesis";
export const LEGACY_PREV_HASH = "<legacy>";

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

export function verifyAuditEntry(entry: AuditEntry, prevEntry: AuditEntry | null): VerifyResult {
  if (entry.prevHash === LEGACY_PREV_HASH) {
    return { valid: false, reason: "pre-chain legacy entry" };
  }
  const expectedPrev = prevEntry === null ? GENESIS_PREV_HASH : deriveChainHash(prevEntry.signature);
  if (entry.prevHash !== expectedPrev) {
    return { valid: false, reason: "prevHash mismatch" };
  }
  const { signature, ...unsigned } = entry;
  const expectedSig = signAuditEntry(unsigned);
  if (signature !== expectedSig) {
    return { valid: false, reason: "signature mismatch" };
  }
  return { valid: true };
}

export interface ChainVerifyResult {
  valid: boolean;
  brokenAt?: number;
  reason?: string;
}

export function verifyAuditChain(entries: AuditEntry[]): ChainVerifyResult {
  for (let i = 0; i < entries.length; i++) {
    const prev = i === 0 ? null : entries[i - 1];
    const result = verifyAuditEntry(entries[i], prev);
    if (!result.valid) {
      return { valid: false, brokenAt: i, reason: result.reason };
    }
  }
  return { valid: true };
}
