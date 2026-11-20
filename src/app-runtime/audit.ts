import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { deriveChainHash, GENESIS_PREV_HASH, signAuditEntry } from "./audit-signing.js";
import { AUDIT_DIR, auditPath } from "./paths.js";
import type { AuditEntry } from "./types.js";
import { atomicWriteFileSync } from "../util/json-store.js";
import { createLogger } from "../logger.js";

const logger = createLogger("app-runtime.audit");

const MAX_PER_APP_ENTRIES = 1000;
const MAX_GLOBAL_ENTRIES = 5000;

/** The log's entries. One that cannot be read is moved aside, never written
 *  over: rewriting it from an empty list erased every entry it held. */
function loadEntries(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    const aside = `${path}.unreadable-${Date.now()}`;
    try { renameSync(path, aside); } catch { /* the next write replaces it; the warning still names it */ }
    logger.warn(`audit log ${path} could not be read (${(e as Error).message}); kept as ${aside}, a new chain starts`);
    return [];
  }
}

function chainPrevHash(entries: AuditEntry[]): string {
  if (entries.length === 0) return GENESIS_PREV_HASH;
  return deriveChainHash(entries[entries.length - 1].signature);
}

// Builds a signed entry for a specific chain. We deliberately produce TWO
// entries per writeAuditEntry call (one per-app, one global) because each
// log is its own chain — their prevHash and therefore their signature
// differ. Sharing a signature across logs would mean only one chain could
// ever be verified.
function buildSignedFor(
  base: Omit<AuditEntry, "signature" | "prevHash">,
  prevHash: string,
): AuditEntry {
  const unsigned: Omit<AuditEntry, "signature"> = { ...base, prevHash };
  return { ...unsigned, signature: signAuditEntry(unsigned) };
}

export function writeAuditEntry(
  appId: string,
  actor: string,
  action: string,
  details: Record<string, unknown> = {},
): AuditEntry {
  const base: Omit<AuditEntry, "signature" | "prevHash"> = {
    id: `aud_${Date.now()}_${randomBytes(4).toString("hex")}`,
    timestamp: Date.now(),
    actor,
    action,
    appId,
    details,
  };

  const appAuditPath = auditPath(appId);
  const appEntries = loadEntries(appAuditPath);
  const appSigned = buildSignedFor(base, chainPrevHash(appEntries));
  appEntries.push(appSigned);
  const trimmedApp = appEntries.length > MAX_PER_APP_ENTRIES
    ? appEntries.slice(-MAX_PER_APP_ENTRIES)
    : appEntries;
  try { atomicWriteFileSync(appAuditPath, JSON.stringify(trimmedApp, null, 2), { encoding: "utf-8" }); } catch { /* best effort */ }

  const globalPath = join(AUDIT_DIR, "global.json");
  const globalEntries = loadEntries(globalPath);
  const globalSigned = buildSignedFor(base, chainPrevHash(globalEntries));
  globalEntries.push(globalSigned);
  const trimmedGlobal = globalEntries.length > MAX_GLOBAL_ENTRIES
    ? globalEntries.slice(-MAX_GLOBAL_ENTRIES)
    : globalEntries;
  try { atomicWriteFileSync(globalPath, JSON.stringify(trimmedGlobal, null, 2), { encoding: "utf-8" }); } catch { /* best effort */ }

  // Return the per-app entry as the canonical result. Callers that care
  // about the global chain entry would need a different API; today nothing
  // does — the return value is only used to surface "an entry was written".
  return appSigned;
}

export function readAuditLog(appId: string, limit = 50): AuditEntry[] {
  const p = auditPath(appId);
  if (!existsSync(p)) return [];
  try {
    const entries: AuditEntry[] = JSON.parse(readFileSync(p, "utf-8"));
    return entries.slice(-limit);
  } catch { return []; }
}

export function readGlobalAuditLog(limit = 100): AuditEntry[] {
  const p = join(AUDIT_DIR, "global.json");
  if (!existsSync(p)) return [];
  try {
    const entries: AuditEntry[] = JSON.parse(readFileSync(p, "utf-8"));
    return entries.slice(-limit);
  } catch { return []; }
}
