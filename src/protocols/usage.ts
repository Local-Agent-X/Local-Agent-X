/**
 * Protocol usage telemetry.
 *
 * Append-only JSONL log at workspace/protocols/usage.jsonl. Lives under
 * workspace so usage signal syncs across the user's machines (the same
 * reasoning protocols-in-workspace was based on — a protocol's value
 * depends on how often it actually fires, and that signal is per-user
 * not per-machine).
 *
 * Three event types capture the loop:
 *   - "searched": agent called protocol_search; we record the query and
 *     whether ANY result was returned (hit). Drives "queries that found
 *     nothing" reports — those are signals to add new protocols.
 *   - "invoked": agent called protocol_get on a specific name. The strongest
 *     signal of actual use; drives the never-used / least-used reports
 *     that protocol_prune consumes.
 *   - "built": agent created a new protocol via protocol_create / build.
 *
 * Aggregation is lazy: we walk the JSONL on every stats call. With ~50
 * protocols × a few events/day, the file stays small for a long time.
 * If it ever crosses ~5MB we can compact (last-N-days kept verbatim,
 * earlier rolled up to per-name counters).
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { createLogger } from "../logger.js";

const logger = createLogger("protocols.usage");

export type UsageAction = "searched" | "invoked" | "built";

export interface UsageRecord {
  ts: number;
  action: UsageAction;
  name: string;
  sessionId?: string;
  /** For "searched": did the query return any results? Drives "search misses" reports. */
  hit?: boolean;
  /** For "searched": the raw query string. Helps detect queries that consistently miss. */
  query?: string;
}

function usageDir(): string {
  const cfg = getRuntimeConfig();
  const dir = resolve(cfg.workspace, "protocols");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function usagePath(): string {
  return join(usageDir(), "usage.jsonl");
}

/** Append one usage record. Best-effort — never throws into the caller. */
export function recordUsage(rec: Omit<UsageRecord, "ts">): void {
  try {
    const full: UsageRecord = { ts: Date.now(), ...rec };
    appendFileSync(usagePath(), JSON.stringify(full) + "\n", { encoding: "utf-8" });
  } catch (e) {
    logger.warn(`[usage] record failed: ${(e as Error).message}`);
  }
}

/** Read all records. Returns empty array on missing file. */
export function readAllUsage(): UsageRecord[] {
  const p = usagePath();
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf-8");
    const out: UsageRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch { /* skip malformed line — append-only logs tolerate partial writes */ }
    }
    return out;
  } catch (e) {
    logger.warn(`[usage] read failed: ${(e as Error).message}`);
    return [];
  }
}

export interface ProtocolStat {
  name: string;
  invocations: number;
  lastInvokedTs: number | null;
  lastInvokedDaysAgo: number | null;
}

/** Aggregate invocations per protocol name. */
export function getProtocolStats(): ProtocolStat[] {
  const recs = readAllUsage();
  const byName = new Map<string, ProtocolStat>();
  const now = Date.now();
  for (const r of recs) {
    if (r.action !== "invoked") continue;
    const existing = byName.get(r.name) || { name: r.name, invocations: 0, lastInvokedTs: null, lastInvokedDaysAgo: null };
    existing.invocations += 1;
    if (!existing.lastInvokedTs || r.ts > existing.lastInvokedTs) existing.lastInvokedTs = r.ts;
    byName.set(r.name, existing);
  }
  for (const s of byName.values()) {
    if (s.lastInvokedTs) s.lastInvokedDaysAgo = Math.floor((now - s.lastInvokedTs) / 86_400_000);
  }
  return Array.from(byName.values()).sort((a, b) => b.invocations - a.invocations);
}

/** Search queries that returned no hits — signal that the catalog has a gap. */
export function getSearchMisses(limit = 20): Array<{ query: string; count: number; lastTs: number }> {
  const recs = readAllUsage();
  const byQuery = new Map<string, { query: string; count: number; lastTs: number }>();
  for (const r of recs) {
    if (r.action !== "searched" || r.hit !== false || !r.query) continue;
    const q = r.query.toLowerCase().trim();
    const e = byQuery.get(q) || { query: r.query, count: 0, lastTs: 0 };
    e.count += 1;
    if (r.ts > e.lastTs) e.lastTs = r.ts;
    byQuery.set(q, e);
  }
  return Array.from(byQuery.values()).sort((a, b) => b.count - a.count).slice(0, limit);
}

/** Protocols never invoked, or invoked but not in N days. Drives protocol_prune. */
export function listUnusedProtocols(allProtocolNames: string[], olderThanDays: number): Array<{ name: string; reason: "never" | "stale"; daysAgo?: number }> {
  const stats = new Map(getProtocolStats().map((s) => [s.name, s]));
  const cutoffDays = Math.max(1, olderThanDays);
  const out: Array<{ name: string; reason: "never" | "stale"; daysAgo?: number }> = [];
  for (const name of allProtocolNames) {
    const s = stats.get(name);
    if (!s || !s.lastInvokedTs) {
      out.push({ name, reason: "never" });
      continue;
    }
    if (s.lastInvokedDaysAgo !== null && s.lastInvokedDaysAgo >= cutoffDays) {
      out.push({ name, reason: "stale", daysAgo: s.lastInvokedDaysAgo });
    }
  }
  return out;
}

/** Best-effort file-size check so callers can warn when usage.jsonl needs compaction. */
export function usageFileSizeBytes(): number {
  try {
    return statSync(usagePath()).size;
  } catch {
    return 0;
  }
}
