/**
 * Protocol archive — soft-delete with recovery, plus lifecycle helpers.
 *
 * Why a separate file from builder.ts:
 *   - Builder owns the live custom.json (loadCustomProtocols / saveCustomProtocols
 *     / createProtocol / editProtocol / deleteProtocol). Those are the primitives.
 *   - Archive owns archived.json + the move-between operations.
 *
 * Storage: workspace/protocols/archived.json — same workspace dir as custom.json
 * and embeddings.json, so the archive syncs across the user's machines along
 * with the live catalog. Restoring on machine B requires the same workspace
 * snapshot that created the archive on machine A.
 *
 * Lifecycle:
 *   custom.json (active/stale)
 *      ↓ archiveProtocol()        ↑ unarchiveProtocol()
 *   archived.json
 *      ↓ purgeArchivedProtocol()  — irrecoverable, drops embedding
 *
 * "Active" vs "stale" is computed from telemetry, not stored — see
 * computeProtocolState().
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeConfig } from "../config.js";
import type { Protocol } from "../protocols.js";
import { loadCustomProtocols, saveCustomProtocols, deleteProtocol } from "./builder.js";
import { getProtocolStats, readAllUsage } from "./usage.js";
import { createLogger } from "../logger.js";

const logger = createLogger("protocols.archive");

export interface ArchivedRecord {
  archivedTs: number;
  reason?: string;
  protocol: Protocol;
}

function archiveDir(): string {
  const cfg = getRuntimeConfig();
  const dir = resolve(cfg.workspace, "protocols");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function archivePath(): string {
  return join(archiveDir(), "archived.json");
}

export function loadArchived(): ArchivedRecord[] {
  const p = archivePath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logger.warn(`[archive] read failed: ${(e as Error).message}`);
    return [];
  }
}

export function saveArchived(records: ArchivedRecord[]): void {
  writeFileSync(archivePath(), JSON.stringify(records, null, 2), "utf-8");
}

/** Move a custom protocol from live → archived. Returns null if not found in
 *  custom.json or already archived. The embedding cache is preserved so an
 *  unarchive doesn't have to re-embed. */
export function archiveProtocol(name: string, reason?: string): ArchivedRecord | null {
  const live = loadCustomProtocols();
  const idx = live.findIndex((p) => p.name === name);
  if (idx === -1) return null;

  const archived = loadArchived();
  if (archived.some((r) => r.protocol.name === name)) {
    // Already archived. Hard-remove from live so we don't end up in both lists.
    live.splice(idx, 1);
    saveCustomProtocols(live);
    return null;
  }

  const protocol = live[idx];
  const record: ArchivedRecord = { archivedTs: Date.now(), reason, protocol };
  archived.push(record);
  saveArchived(archived);

  live.splice(idx, 1);
  saveCustomProtocols(live);
  return record;
}

/** Move an archived protocol back to live. Refuses if a live protocol of the
 *  same name already exists — caller must rename or delete the conflict. */
export function unarchiveProtocol(name: string): { restored?: Protocol; error?: string } {
  const archived = loadArchived();
  const idx = archived.findIndex((r) => r.protocol.name === name);
  if (idx === -1) return { error: `"${name}" is not archived` };

  const live = loadCustomProtocols();
  if (live.some((p) => p.name === name)) {
    return { error: `cannot unarchive: a live protocol named "${name}" already exists` };
  }

  const restored = archived[idx].protocol;
  live.push(restored);
  saveCustomProtocols(live);

  archived.splice(idx, 1);
  saveArchived(archived);
  return { restored };
}

/** Hard-remove an archived protocol. Drops the embedding cache entry too. */
export function purgeArchivedProtocol(name: string): boolean {
  const archived = loadArchived();
  const idx = archived.findIndex((r) => r.protocol.name === name);
  if (idx === -1) return false;
  archived.splice(idx, 1);
  saveArchived(archived);
  void import("./dedup.js").then((m) => m.dropEmbedding(name)).catch(() => { /* best-effort */ });
  return true;
}

export type ProtocolState = "active" | "stale" | "archived";

/** Derive a protocol's lifecycle state from telemetry + archive membership.
 *  Pure function; no I/O beyond the caller-provided maps. */
export function computeProtocolState(
  name: string,
  ctx: {
    archivedNames: Set<string>;
    /** Days since the protocol was last invoked, or null if never invoked. */
    lastInvokedDaysAgo: number | null;
    /** Stale threshold in days. Default 30. */
    staleAfterDays?: number;
  },
): ProtocolState {
  if (ctx.archivedNames.has(name)) return "archived";
  const cutoff = ctx.staleAfterDays ?? 30;
  if (ctx.lastInvokedDaysAgo === null) return "stale"; // never invoked
  return ctx.lastInvokedDaysAgo >= cutoff ? "stale" : "active";
}

export interface TransitionReport {
  archived: Array<{ name: string; daysSinceInvocation: number | null; reason: string }>;
  purged: Array<{ name: string; daysSinceArchive: number }>;
  scanned: number;
  skippedPinned: number;
}

/** Apply automatic lifecycle transitions.
 *  - Custom protocols stale ≥ archiveAfterDays AND not pinned → archived
 *  - Archive records older than purgeArchivedAfterDays → hard-deleted
 *
 *  Returns a report of what changed. Idempotent: running twice produces an
 *  empty report on the second run (nothing else has aged).
 */
export function applyAutomaticTransitions(opts: {
  archiveAfterDays?: number;
  purgeArchivedAfterDays?: number;
} = {}): TransitionReport {
  const archiveAfter = opts.archiveAfterDays ?? 90;
  const purgeAfter = opts.purgeArchivedAfterDays ?? 30;
  const report: TransitionReport = { archived: [], purged: [], scanned: 0, skippedPinned: 0 };

  // ── Pass 1: archive stale custom protocols ──
  const stats = new Map(getProtocolStats().map((s) => [s.name, s]));
  const live = loadCustomProtocols();
  report.scanned = live.length;

  // Walk a copy so we can mutate `live` mid-iteration via archiveProtocol().
  for (const p of [...live]) {
    if (p.pinned) { report.skippedPinned += 1; continue; }
    const s = stats.get(p.name);
    const daysAgo = s?.lastInvokedDaysAgo ?? null;

    let shouldArchive = false;
    let reason = "";
    if (daysAgo === null) {
      // Never invoked. We can't tell its true age without a "built" event;
      // protocol_create now records that, but legacy entries may not have one.
      // Be conservative: only auto-archive if never-invoked AND we have a built
      // event indicating it's at least `archiveAfter` days old.
      const builtTs = inferBuiltTs(p.name);
      if (builtTs !== null) {
        const ageDays = Math.floor((Date.now() - builtTs) / 86_400_000);
        if (ageDays >= archiveAfter) {
          shouldArchive = true;
          reason = `never invoked in ${ageDays}d since creation`;
        }
      }
    } else if (daysAgo >= archiveAfter) {
      shouldArchive = true;
      reason = `not invoked in ${daysAgo}d`;
    }

    if (shouldArchive) {
      const rec = archiveProtocol(p.name, reason);
      if (rec) report.archived.push({ name: p.name, daysSinceInvocation: daysAgo, reason });
    }
  }

  // ── Pass 2: purge old archive records ──
  const archived = loadArchived();
  const now = Date.now();
  for (const r of [...archived]) {
    const daysSinceArchive = Math.floor((now - r.archivedTs) / 86_400_000);
    if (daysSinceArchive >= purgeAfter) {
      if (purgeArchivedProtocol(r.protocol.name)) {
        report.purged.push({ name: r.protocol.name, daysSinceArchive });
      }
    }
  }

  if (report.archived.length > 0 || report.purged.length > 0) {
    logger.info(`[archive] transitions: archived=${report.archived.length} purged=${report.purged.length}`);
  }
  return report;
}

/** Best-effort lookup: earliest "built" event for a protocol name.
 *  Returns ms-since-epoch, or null if no event recorded. */
function inferBuiltTs(name: string): number | null {
  try {
    const recs = readAllUsage();
    let earliest: number | null = null;
    for (const r of recs) {
      if (r.action === "built" && r.name === name) {
        if (earliest === null || r.ts < earliest) earliest = r.ts;
      }
    }
    return earliest;
  } catch {
    return null;
  }
}

/** Hard-delete a protocol from custom.json without archiving. Internal callers
 *  use this when archival makes no sense (supersedes from protocol_create).
 *  External callers go through archiveProtocol. */
export function hardDeleteCustom(name: string): boolean {
  return deleteProtocol(name);
}
