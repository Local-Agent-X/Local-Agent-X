import { createHmac, randomBytes } from "node:crypto";

import type { AuditEntry } from "./types.js";

// HMAC key. Read from env at module load. Defaults to a random per-process key
// if neither LAX_AUDIT_KEY nor SAX_AUDIT_KEY is set — that means signatures
// are valid only within a single process lifetime when no env key is provided.
const AUDIT_HMAC_KEY = (process.env.LAX_AUDIT_KEY ?? process.env.SAX_AUDIT_KEY) || randomBytes(32).toString("hex");

export function signAuditEntry(entry: Omit<AuditEntry, "signature">): string {
  const payload = `${entry.id}|${entry.timestamp}|${entry.actor}|${entry.action}|${entry.appId}`;
  return createHmac("sha256", AUDIT_HMAC_KEY).update(payload).digest("hex").slice(0, 16);
}

export function verifyAuditEntry(entry: AuditEntry): boolean {
  const expected = signAuditEntry(entry);
  return entry.signature === expected;
}
