import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLaxDir } from "../lax-data-dir.js";
import type { AuditEntry } from "./types.js";

// Persistent HMAC key for tamper detection. Resolution order:
//   1. process.env.LAX_AUDIT_KEY / SAX_AUDIT_KEY (ops-managed override)
//   2. <laxDir>/audit-key on disk, 32 random bytes, mode 0o600
//   3. In-process random fallback if disk read/write fails (loud error logged)
//
// Cached per-process. Persisting to disk is the whole point — signatures
// must survive process restarts so a hash-chained audit log stays verifiable
// across crashes and reboots.

let cachedKey: Buffer | string | null = null;

function keyPath(): string {
  return join(getLaxDir(), "audit-key");
}

function loadOrCreateDiskKey(): Buffer {
  const path = keyPath();
  if (existsSync(path)) {
    return readFileSync(path);
  }
  const fresh = randomBytes(32);
  // Atomic write: tmp + rename, mode 0o600. Rename is atomic on a single
  // filesystem; two racing processes may both write, but each ends with a
  // valid 32-byte key file, and one wins the rename. The losing process
  // will reload the winner's key on next call (cache is in-memory).
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, fresh, { mode: 0o600 });
  renameSync(tmp, path);
  return fresh;
}

export function getAuditHmacKey(): Buffer | string {
  if (cachedKey !== null) return cachedKey;
  const envKey = process.env.LAX_AUDIT_KEY ?? process.env.SAX_AUDIT_KEY;
  if (envKey) {
    cachedKey = envKey;
    return cachedKey;
  }
  try {
    cachedKey = loadOrCreateDiskKey();
    return cachedKey;
  } catch (err) {
    // Disk unavailable (permissions, missing dir, read-only fs). Fall back
    // to an in-process random key. Same risk profile as the old behavior:
    // signatures don't survive a restart. Loud log so this is visible.
    // eslint-disable-next-line no-console
    console.error("[audit] failed to persist HMAC key, using in-process fallback:", err);
    cachedKey = randomBytes(32);
    return cachedKey;
  }
}

// Test hook — reset the in-process cache so each test gets a fresh resolve.
// Not exported via the barrel; only used by the audit-signing test file.
export function _resetAuditKeyCacheForTests(): void {
  cachedKey = null;
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
