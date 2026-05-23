import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { signAuditEntry } from "./audit-signing.js";
import { AUDIT_DIR, auditPath } from "./paths.js";
import type { AuditEntry } from "./types.js";

const MAX_PER_APP_ENTRIES = 1000;
const MAX_GLOBAL_ENTRIES = 5000;

export function writeAuditEntry(
  appId: string,
  actor: string,
  action: string,
  details: Record<string, unknown> = {},
): AuditEntry {
  const entry: Omit<AuditEntry, "signature"> = {
    id: `aud_${Date.now()}_${randomBytes(4).toString("hex")}`,
    timestamp: Date.now(),
    actor,
    action,
    appId,
    details,
  };
  const signed: AuditEntry = { ...entry, signature: signAuditEntry(entry) };

  const appAuditPath = auditPath(appId);
  let entries: AuditEntry[] = [];
  try { if (existsSync(appAuditPath)) entries = JSON.parse(readFileSync(appAuditPath, "utf-8")); } catch { entries = []; }
  entries.push(signed);
  if (entries.length > MAX_PER_APP_ENTRIES) entries = entries.slice(-MAX_PER_APP_ENTRIES);
  try { writeFileSync(appAuditPath, JSON.stringify(entries, null, 2), "utf-8"); } catch { /* best effort */ }

  const globalPath = join(AUDIT_DIR, "global.json");
  let global: AuditEntry[] = [];
  try { if (existsSync(globalPath)) global = JSON.parse(readFileSync(globalPath, "utf-8")); } catch { global = []; }
  global.push(signed);
  if (global.length > MAX_GLOBAL_ENTRIES) global = global.slice(-MAX_GLOBAL_ENTRIES);
  try { writeFileSync(globalPath, JSON.stringify(global, null, 2), "utf-8"); } catch { /* best effort */ }

  return signed;
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
