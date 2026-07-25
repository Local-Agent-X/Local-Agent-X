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
 * The archive is VERSIONED: archived.json may hold more than one record for a
 * name, discriminated by `archivedTs`. It has to be. `createProtocol` only
 * rejects collisions against the LIVE catalog, so an archived name is instantly
 * re-creatable — and an agent that re-authors protocols on its own initiative
 * hits that constantly. When the archive held one record per name, the second
 * archive of a name had nowhere to put the live copy and deleted it instead:
 * a silent, unrecoverable loss on the ordinary path. Multiple records cost a
 * little disk in a file the 30-day purge already bounds; the single-record
 * invariant cost user content.
 *
 * "Active" vs "stale" is computed from telemetry, not stored — see
 * computeProtocolState().
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { atomicWriteFileSync } from "../util/json-store.js";
import type { Protocol } from "../protocols/index.js";
import { loadCustomProtocols, saveCustomProtocols } from "./builder.js";
import { noteCatalogReadFailure } from "./loader.js";
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

/** Read archived.json, distinguishing "empty" from "could not be read".
 *
 *  archived.json is git-synced and holds EVERY version of every archived name,
 *  so a merge-conflict blob or a half-synced file here is the most destructive
 *  degraded read in the subsystem: the read degrades to `[]`, and the next
 *  archive/purge writes its own one-element array straight over the top,
 *  erasing every version that was in there. Callers that WRITE must refuse on
 *  `failed`; callers that only read can use the empty list. */
function readArchived(): { records: ArchivedRecord[]; failed: boolean } {
  const p = archivePath();
  if (!existsSync(p)) return { records: [], failed: false };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (!Array.isArray(parsed)) {
      logger.warn(`[archive] ${p} is not an array — refusing to treat it as an empty archive`);
      noteCatalogReadFailure();
      return { records: [], failed: true };
    }
    return { records: parsed, failed: false };
  } catch (e) {
    logger.warn(`[archive] read failed: ${(e as Error).message}`);
    noteCatalogReadFailure();
    return { records: [], failed: true };
  }
}

export function loadArchived(): ArchivedRecord[] {
  return readArchived().records;
}

/** Atomic for the same reason as saveCustomProtocols: archived.json is the
 *  only copy of a soft-deleted protocol, and loadArchived() reads a torn file
 *  as an empty archive — which would turn a recoverable delete into a silent
 *  permanent one. */
export function saveArchived(records: ArchivedRecord[]): void {
  atomicWriteFileSync(archivePath(), JSON.stringify(records, null, 2), { encoding: "utf-8" });
}

// Version order is INSERTION order, not timestamp order.
//
// archived.json is only ever appended to (archiveProtocol pushes), so the array
// itself records which version was archived after which — and it is the only
// record of that which cannot be wrong. `archivedTs` cannot carry it: the
// system clock can step backwards (NTP correction, DST-adjacent tooling, a VM
// resume), which would make the newer version sort as older and hand a restore
// the wrong content and a purge the wrong victim; and a record written before
// stamps existed has no `archivedTs` at all, where any `>=` comparison against
// `undefined` is false, so it would pin itself as "newest" forever and make the
// current version unreachable. `archivedTs` stays the caller-facing
// discriminator for targeted restores; it is not the ordering.

/** Index of the LAST-archived record for a name, or -1. */
function newestArchivedIdx(archived: ArchivedRecord[], name: string): number {
  for (let i = archived.length - 1; i >= 0; i -= 1) {
    if (archived[i]?.protocol?.name === name) return i;
  }
  return -1;
}

/** Index of the FIRST-archived record for a name, or -1. */
function oldestArchivedIdx(archived: ArchivedRecord[], name: string): number {
  for (let i = 0; i < archived.length; i += 1) {
    if (archived[i]?.protocol?.name === name) return i;
  }
  return -1;
}

/** Move a custom protocol from live → archived. Returns null ONLY when the name
 *  isn't in custom.json — the one case where there is nothing to archive.
 *
 *  This never deletes without archiving. An existing archive record for the
 *  same name is not a conflict: the new record is appended alongside it and the
 *  two are told apart by `archivedTs`. The previous behaviour — "already
 *  archived, so hard-remove the live copy" — destroyed content whenever the two
 *  copies differed, and returned null, so every caller reported "already
 *  archived / not found" for a deletion the call itself had just performed.
 *
 *  This does not drop the embedding cache entry, so an unarchive that happens
 *  before the next dedup pass skips the re-embed — but the entry is not
 *  durable: refreshCache() reconciles the cache against the LIVE catalog, so an
 *  archived protocol's vector is pruned the next time anything authors a
 *  protocol. Correct trade: one re-embed on a late unarchive, versus orphans
 *  accumulating forever in a git-synced file.
 *
 *  THROWS if archived.json exists but cannot be read. Writing then would
 *  replace every archived version with a one-element array — strictly worse
 *  than the clash branch this replaced. Callers surface the failure; none of
 *  them may translate it into "not found". */
export function archiveProtocol(name: string, reason?: string): ArchivedRecord | null {
  const live = loadCustomProtocols();
  const idx = live.findIndex((p) => p.name === name);
  if (idx === -1) return null;

  const { records: archived, failed } = readArchived();
  if (failed) {
    throw new Error(
      `refusing to archive "${name}": ${archivePath()} could not be read, and archiving would overwrite it. ` +
      `Fix or move that file first — every archived version is in it.`,
    );
  }
  const protocol = live[idx];
  // archivedTs is the caller-facing discriminator between versions of a name —
  // targeted restores name it — so it has to be unique per name. Date.now() has
  // millisecond resolution and archive/re-create/archive is a sub-millisecond
  // sequence for a programmatic caller, so nudge forward on a collision rather
  // than mint an ambiguous key. This is uniqueness, NOT ordering: see the note
  // above newestArchivedIdx for why ordering can't be built on a clock.
  let archivedTs = Date.now();
  while (archived.some((r) => r.protocol?.name === name && r.archivedTs === archivedTs)) archivedTs += 1;
  const record: ArchivedRecord = { archivedTs, reason, protocol };
  archived.push(record);
  saveArchived(archived);

  live.splice(idx, 1);
  saveCustomProtocols(live);
  return record;
}

/** Move an archived protocol back to live. Restores the LAST-ARCHIVED record
 *  for the name by default; pass `archivedTs` to restore a specific earlier one
 *  (the discriminator listed by protocol(action:'list_archived') and
 *  GET /api/protocols/archived). Refuses if a live protocol of the same name
 *  already exists — caller must archive or remove the conflict first, and
 *  archiving it is now non-destructive, so that is a real way out and not a
 *  demand to delete the copy the user was trying to keep. */
export function unarchiveProtocol(
  name: string,
  opts: { archivedTs?: number } = {},
): { restored?: Protocol; error?: string } {
  const { records: archived, failed } = readArchived();
  if (failed) {
    return { error: `the archive at ${archivePath()} could not be read — fix or move that file, then retry` };
  }
  const idx = opts.archivedTs === undefined
    ? newestArchivedIdx(archived, name)
    : archived.findIndex((r) => r.protocol?.name === name && r.archivedTs === opts.archivedTs);
  if (idx === -1) {
    return {
      error: opts.archivedTs === undefined
        ? `"${name}" is not archived`
        : `"${name}" has no archived version stamped ${opts.archivedTs}`,
    };
  }

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

/** Hard-remove ONE archived record — the FIRST-archived one for that name,
 *  which is the one the age-based purge is walking. Drops the embedding cache
 *  entry only when no other copy of the name survives (another archived version
 *  or a live protocol), so purging an old version doesn't force a re-embed of
 *  the one still in use. Returns false — writing nothing — if the archive
 *  can't be read. */
export function purgeArchivedProtocol(name: string): boolean {
  const { records: archived, failed } = readArchived();
  if (failed) return false;
  const idx = oldestArchivedIdx(archived, name);
  if (idx === -1) return false;
  archived.splice(idx, 1);
  saveArchived(archived);
  const survives = archived.some((r) => r.protocol?.name === name)
    || loadCustomProtocols().some((p) => p.name === name);
  if (!survives) {
    void import("./dedup.js").then((m) => m.dropEmbedding(name)).catch(() => { /* best-effort */ });
  }
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

  // Both passes WRITE archived.json. If it can't be read, every write replaces
  // the whole file, so this sweep — which runs unattended on a timer — is
  // exactly where an unreadable archive turns into permanent loss. Do nothing
  // and report nothing; the next sweep retries. Same trade as the embedding
  // prune: skipping costs one cycle of retention, acting costs content.
  if (readArchived().failed) {
    logger.warn(`[archive] skipping automatic transitions: ${archivePath()} could not be read`);
    return report;
  }

  // ── Pass 1: archive stale custom protocols ──
  const stats = new Map(getProtocolStats().map((s) => [s.name, s]));
  const live = loadCustomProtocols();
  report.scanned = live.length;

  // Walk a copy so we can mutate `live` mid-iteration via archiveProtocol().
  for (const p of [...live]) {
    // custom.json is hand-editable and git-synced: `[null]` and `[{}]` both
    // parse as arrays, so the shape guard in loadCustomProtocols() lets them
    // through and this loop is where they'd throw.
    if (!p?.name) continue;
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
    // Same reason as pass 1: a hand-edited or half-merged archived.json can
    // hold a record with no protocol. Skipping one malformed record is right;
    // throwing out of an unattended sweep would strand the rest.
    if (!r?.protocol?.name) continue;
    // No usable stamp = unknown age. Never purge what we can't date — an
    // undated record is content someone may still want, and `now - undefined`
    // is NaN, which compares false and would silently mean "keep forever"
    // without saying so.
    if (typeof r.archivedTs !== "number" || !Number.isFinite(r.archivedTs)) continue;
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
