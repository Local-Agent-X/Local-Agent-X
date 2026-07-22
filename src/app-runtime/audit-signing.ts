import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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

// Basenames this module persists under getLaxDir(). Exported so the build-time
// enrollment assertion (audit-signing.test.ts) can pin them to the canonical
// APP_AT_REST_SECRET_BASENAMES set without re-typing the strings — adding a new
// key/seed file here without enrolling it there fails CI.
export const AUDIT_SEED_BASENAMES = ["audit-key", "audit-key.enc"] as const;

function encPath(): string {
  return join(getLaxDir(), AUDIT_SEED_BASENAMES[1]);
}

function plaintextPath(): string {
  return join(getLaxDir(), AUDIT_SEED_BASENAMES[0]);
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

/**
 * Wipe a plaintext seed file: overwrite then unlink. The plaintext seed is the
 * at-rest forge vector the sealed store exists to eliminate, so a FAILED removal
 * is fatal, not best-effort: if the readable plaintext can't be removed we must
 * NOT proceed (the caller surfaces the throw to the in-process-fallback path and
 * logs loudly), rather than silently leaving a forgeable seed on disk. Throwing
 * mirrors how the rest of init surfaces unresolved-seed failures.
 *
 * (The OVERWRITE is still best-effort hardening — forensic erasure on modern
 * filesystems isn't guaranteed — but the UNLINK is load-bearing and must
 * succeed: namespace removal is the security property we depend on.)
 */
function shredPlaintext(path: string): void {
  if (!existsSync(path)) return;
  try {
    const size = statSync(path).size;
    if (size > 0) writeFileSync(path, randomBytes(size), { mode: 0o600 });
  } catch (err) {
    // Overwrite failed (e.g. EACCES on the content) — log, but still attempt the
    // unlink below; removing the name is the property we actually need.
    logger.warn(`[audit] could not overwrite plaintext seed before unlink: ${String(err)}`);
  }
  // Unlink is NOT swallowed: a still-readable plaintext seed defeats the sealed
  // store, so a failed removal aborts (caller falls back to an in-process key and
  // logs) instead of running auditing with a forgeable seed on disk.
  unlinkSync(path);
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
  const keyFile = process.env.LAX_AUDIT_KEY_FILE;
  if (keyFile) {
    cachedKey = readProjectedAuditKey(keyFile);
    return cachedKey;
  }
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
  if (process.env.LAX_AUDIT_KEY_FILE || process.env.LAX_AUDIT_KEY) return true;
  return existsSync(encPath()) || existsSync(plaintextPath());
}

function readProjectedAuditKey(path: string): Buffer {
  if (!isAbsolute(path)) throw new Error("projected audit key path must be absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) {
    throw new Error("projected audit key must be a small regular file");
  }
  const encoded = readFileSync(path, "utf8").trim();
  if (/^[a-f0-9]{64}$/.test(encoded)) return Buffer.from(encoded, "hex");
  let projected: { schemaVersion?: unknown; key?: unknown };
  try { projected = JSON.parse(encoded); }
  catch { throw new Error("projected audit key is invalid"); }
  if (projected.schemaVersion !== 1 || typeof projected.key !== "string"
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(projected.key)) {
    throw new Error("projected audit key is invalid");
  }
  const key = Buffer.from(projected.key, "base64");
  if (key.length < 1 || key.length > 1024 || key.toString("base64") !== projected.key) {
    throw new Error("projected audit key is invalid");
  }
  return key;
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

/** Domain-separated integrity MAC for other durable security records. Reuses
 * the sealed per-install audit seed; callers never receive the key itself. */
export function computeDurableRecordMac(domain: string, payload: string): string {
  return createHmac("sha256", getAuditHmacKey()).update(`${domain}\0${payload}`).digest("hex");
}

export function verifyDurableRecordMac(domain: string, payload: string, mac: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(mac)) return false;
  const expected = Buffer.from(computeDurableRecordMac(domain, payload), "hex");
  const actual = Buffer.from(mac, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
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
