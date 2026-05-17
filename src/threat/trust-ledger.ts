/**
 * Layer C — persistent trust ledger.
 *
 * After the user has approved an exfil pattern via /approve (Layer B),
 * record its fingerprint here. Future tool chains matching the same
 * fingerprint auto-allow without requiring /approve again. The result:
 * "just works" UX once the user has proven a workflow is legitimate.
 *
 * Fingerprint shape: `<sourceType>:<sinkHostname>` —
 *   e.g. `shell:cloud.thrivemetrics.com`
 *
 * Why hostname (not full URL): the same pattern (extract PDF locally,
 * navigate to SaaS) hits dozens of different URLs on the same host
 * (POs, invoices, customers, vendors). Hostname is the trust boundary;
 * path is incidental.
 *
 * Storage: ~/.lax/threat-trust-ledger.json (per-machine, never synced —
 * security state stays local). Persists across server restarts; cleared
 * only by explicit user action.
 *
 * Threshold: 1 approval. The user said yes once = trust the pattern.
 * Re-prompting on every restart of the same flow is exactly the friction
 * we're trying to remove.
 *
 * Decay: none for now. Revisit if we want a 90-day TTL later.
 * Adding now would be premature complexity.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logger.js";

const logger = createLogger("threat.trust-ledger");

// Resolved on every load/save (not cached at import) so test isolation
// via HOME / USERPROFILE redirects writes to a temp dir. Reads env vars
// directly — Node's os.homedir() on Windows goes through
// GetUserProfileDirectory() (Win32 API) and ignores process.env, so
// env-based isolation only works if we read the env ourselves. Mirrors
// the pattern in src/config.ts:getConfigDir.
function ledgerPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, ".lax", "threat-trust-ledger.json");
}

export interface LearnedPattern {
  fingerprint: string;
  approvals: number;
  firstApprovedAt: number;
  lastApprovedAt: number;
  reason: string;
}

interface LedgerFile {
  version: 1;
  patterns: LearnedPattern[];
}

let cache: Map<string, LearnedPattern> | null = null;

function load(): Map<string, LearnedPattern> {
  if (cache) return cache;
  cache = new Map();
  const path = ledgerPath();
  if (!existsSync(path)) return cache;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as LedgerFile;
    if (parsed.version === 1 && Array.isArray(parsed.patterns)) {
      for (const p of parsed.patterns) cache.set(p.fingerprint, p);
    }
  } catch (e) {
    logger.warn(`[trust-ledger] load failed (treating as empty): ${(e as Error).message}`);
  }
  return cache;
}

function save(): void {
  const map = load();
  const payload: LedgerFile = { version: 1, patterns: [...map.values()] };
  const path = ledgerPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
  } catch (e) {
    logger.warn(`[trust-ledger] save failed: ${(e as Error).message}`);
  }
}

/** Build a fingerprint from the exfil chain's source type + sink target URL. */
export function fingerprintOf(sourceType: string, sinkTarget: string): string | null {
  if (!sourceType) return null;
  let host = sinkTarget;
  try {
    const url = new URL(sinkTarget);
    host = url.hostname.toLowerCase();
  } catch {
    // Not a URL — bash command, shell action, etc. Fall back to a
    // shortened raw target. If the sink isn't a URL we can't really
    // build a learnable pattern, so refuse to record.
    return null;
  }
  if (!host) return null;
  return `${sourceType}:${host}`;
}

/** Record a user approval. Idempotent — re-recording an existing pattern
 *  bumps its approvals count and lastApprovedAt. */
export function recordApproval(fingerprint: string, reason: string): void {
  const map = load();
  const existing = map.get(fingerprint);
  const now = Date.now();
  if (existing) {
    existing.approvals += 1;
    existing.lastApprovedAt = now;
    existing.reason = reason; // latest reason wins
  } else {
    map.set(fingerprint, {
      fingerprint,
      approvals: 1,
      firstApprovedAt: now,
      lastApprovedAt: now,
      reason,
    });
  }
  save();
  logger.info(`[trust-ledger] recorded approval for ${fingerprint} (total approvals: ${map.get(fingerprint)!.approvals})`);
}

/** True when a pattern has at least one prior approval. */
export function isLearned(fingerprint: string): boolean {
  return load().has(fingerprint);
}

/** Read-only view of all learned patterns for UI display. */
export function listLearned(): LearnedPattern[] {
  return [...load().values()].sort((a, b) => b.lastApprovedAt - a.lastApprovedAt);
}

/** Forget a learned pattern. Returns true if the pattern was present. */
export function forget(fingerprint: string): boolean {
  const map = load();
  const had = map.delete(fingerprint);
  if (had) save();
  return had;
}

/** Test-only — drops the in-memory cache so tests get a clean read. */
export function _resetLedgerCacheForTests(): void {
  cache = null;
}
