import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hasPersistedAuditKey } from "../app-runtime/audit-signing.js";
import { createLogger } from "../logger.js";
import {
  GENESIS_ANCHOR_HASH,
  GENESIS_PREV_HASH,
  anchorPathFor,
  computeAnchorHash,
  computeEntryHash,
  currentAuditDate,
  eraMarkerPresent,
  legacyPayload,
  markerPathFor,
  verifyAnchors,
  writeEraMarker,
  type AnchorRecord,
  type AuditEntry,
} from "./audit-crypto.js";

export type { AnchorRecord, AuditEntry } from "./audit-crypto.js";

const logger = createLogger("threat.audit-trail");

export class CryptoAuditTrail {
  private entries: AuditEntry[] = [];
  private prevHash = GENESIS_PREV_HASH;
  private prevAnchor = GENESIS_ANCHOR_HASH;
  private seq = 0;
  private auditDir: string;
  private fileDate: string;
  // Assigned via resolveForDate() in the constructor (and on each daily
  // rollover); the `!` tells TS the constructor path guarantees them.
  private filePath!: string;
  private anchorPath!: string;
  private markerPath!: string;

  constructor(dataDir: string) {
    this.auditDir = join(dataDir, "audit");
    if (!existsSync(this.auditDir)) mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    // Daily audit files — resolve today's file and resume its chains.
    this.fileDate = currentAuditDate();
    this.resolveForDate(this.fileDate);
  }

  /**
   * Point filePath/anchorPath/markerPath at `<auditDir>/<date>.jsonl` and resume
   * seq/prevHash/prevAnchor from that file. For a brand-new day the file does
   * not exist yet, so the chains reset to genesis — exactly the behavior a fresh
   * per-day instance would have. Shared with the constructor so the daily
   * ROLLOVER path (a long-lived shared instance crossing midnight) and first-file
   * resume use one code path.
   */
  private resolveForDate(date: string): void {
    this.fileDate = date;
    this.filePath = join(this.auditDir, `${date}.jsonl`);
    this.anchorPath = anchorPathFor(this.filePath);
    this.markerPath = markerPathFor(this.filePath);
    this.prevHash = GENESIS_PREV_HASH;
    this.prevAnchor = GENESIS_ANCHOR_HASH;
    this.seq = 0;
    // Resume chain from existing file
    if (existsSync(this.filePath)) {
      try {
        const lines = readFileSync(this.filePath, "utf-8").trim().split("\n");
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          const lastEntry = JSON.parse(lastLine) as AuditEntry;
          this.prevHash = lastEntry.hash;
          this.seq = lastEntry.seq + 1;
        }
      } catch { /* Start fresh if corrupt */ }
    }
    // Resume the independent anchor chain from its last record.
    if (existsSync(this.anchorPath)) {
      try {
        const lines = readFileSync(this.anchorPath, "utf-8").trim().split("\n");
        const last = lines[lines.length - 1];
        if (last) this.prevAnchor = (JSON.parse(last) as AnchorRecord).anchorHash;
      } catch { /* Start anchor chain fresh if corrupt */ }
    }
  }

  /** Record an audit entry with cryptographic chaining */
  record(entry: Omit<AuditEntry, "seq" | "hash" | "prevHash" | "timestamp">): AuditEntry {
    // Daily rollover: a long-lived (shared) instance must not keep appending to
    // a stale date after midnight. If the calendar day has advanced, re-resolve
    // to the new day's file and resume its chains (genesis for a brand-new day).
    // Done synchronously before computing the entry so seq/prevHash reflect the
    // file we're about to write.
    const today = currentAuditDate();
    if (today !== this.fileDate) this.resolveForDate(today);

    const full: AuditEntry = {
      ...entry,
      seq: this.seq++,
      timestamp: new Date().toISOString(),
      prevHash: this.prevHash,
      hash: "", // computed below
      hashScheme: "hmac-v1",
    };

    // HMAC-SHA256 over the canonical payload of ALL security-relevant fields
    // (decision, reason, role, threatScore, dataLabels, …). Keyed so a
    // filesystem-only attacker can't forge a valid chain.
    full.hash = computeEntryHash(full);
    this.prevHash = full.hash;

    this.entries.push(full);

    // First hmac-v1 write enters the "hmac-v1 era" — persist the sealed marker
    // so verify() can refuse the unkeyed legacy fallback from here on. Best
    // effort: a marker write failure must not crash the agent, and the chain
    // still verifies as hmac-v1 on its own scheme tags.
    try {
      writeEraMarker(this.markerPath);
    } catch { /* marker write failure shouldn't crash the agent */ }

    // Append to daily file (JSONL format)
    try {
      writeFileSync(this.filePath, JSON.stringify(full) + "\n", { flag: "a", mode: 0o600 });
    } catch { /* Audit write failure shouldn't crash the agent */ }

    // External anchor: pin the new chain head in the independent anchor chain
    // and emit it to the app log. The on-disk anchor catches tail-truncation;
    // the emitted head is the off-box copy a log shipper can hold.
    const anchor: AnchorRecord = {
      seq: full.seq,
      count: full.seq + 1,
      chainHash: full.hash,
      prevAnchor: this.prevAnchor,
      anchorHash: "",
    };
    anchor.anchorHash = computeAnchorHash(anchor);
    this.prevAnchor = anchor.anchorHash;
    try {
      writeFileSync(this.anchorPath, JSON.stringify(anchor) + "\n", { flag: "a", mode: 0o600 });
    } catch { /* Anchor write failure shouldn't crash the agent */ }
    logger.info(`[audit-anchor] seq=${anchor.seq} count=${anchor.count} head=${anchor.chainHash}`);

    return full;
  }

  /**
   * Verify the integrity of the audit chain.
   *
   * Fail-closed era gate, driven by KEY PRESENCE (the C3 ratchet): the audit dir
   * is in the "hmac-v1 era" if a real persisted/env audit seed is resolvable
   * (hasPersistedAuditKey), OR the sealed `.hmac-v1.marker` is present, OR the
   * chain itself still contains any hmac-v1 row. In the era, EVERY entry must be
   * `hashScheme: "hmac-v1"` and is recomputed with the keyed HMAC, so the unkeyed
   * legacy SHA-256 branch is UNREACHABLE.
   *
   * Key-presence is the load-bearing signal: a keyed install signs 100% hmac-v1,
   * so even if a filesystem-only attacker DELETES the marker AND the anchor and
   * rewrites every row as a self-consistent plain-SHA-256 chain (no key needed),
   * the seed still resolves → era still active → that downgrade returns
   * `valid:false`. The marker and row-tag signals are now belt-and-suspenders;
   * deleting them can't re-open the legacy path.
   *
   * The legacy branch survives ONLY for the genuine pre-key back-compat window:
   * NO seed resolvable, NO marker, NO hmac-v1 rows. There an old pre-upgrade dev
   * file still verifies under plain SHA-256 so boot never crashes. A keyed
   * install is 100% hmac-v1.
   */
  static verify(filePath: string): { valid: boolean; brokenAt?: number; total: number; anchorChecked?: boolean } {
    if (existsSync(filePath) === false) return { valid: true, total: 0 };
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    let prevHash = GENESIS_PREV_HASH;
    const heads: { seq: number; hash: string }[] = [];

    // hmac-v1 era is active if a real persisted/env audit seed is resolvable,
    // OR the sealed marker exists, OR any row is still tagged hmac-v1. Key
    // presence is the primary ratchet (C3): a keyed install is 100% hmac-v1, so
    // deleting the marker + anchor and rewriting every row as self-consistent
    // plain-SHA-256 (no key needed) can't downgrade past it — the seed still
    // resolves and the legacy fallback stays off-limits. The marker and row-tag
    // checks are the back-compat catch for files predating the key.
    const markerPath = markerPathFor(filePath);
    const parsed: (AuditEntry | null)[] = lines.map(l => {
      try { return JSON.parse(l) as AuditEntry; } catch { return null; }
    });
    const eraActive =
      hasPersistedAuditKey() ||
      eraMarkerPresent(markerPath) ||
      parsed.some(e => e !== null && e.hashScheme === "hmac-v1");

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as AuditEntry;

        // Era gate: in the hmac-v1 era, refuse any non-hmac-v1 row. This is the
        // line that closes the legacy-downgrade forge — the unkeyed branch
        // below is unreachable once the era is active.
        if (eraActive && entry.hashScheme !== "hmac-v1") {
          return { valid: false, brokenAt: i, total: lines.length };
        }

        // Reject NULL/empty anchors except the single legitimate genesis row.
        // Only index 0 may carry the GENESIS anchor; any later GENESIS/empty
        // prevHash means the chain was truncated or re-rooted.
        const anchorEmpty = entry.prevHash == null || entry.prevHash === "";
        if (anchorEmpty || (i > 0 && entry.prevHash === GENESIS_PREV_HASH)) {
          return { valid: false, brokenAt: i, total: lines.length };
        }

        if (entry.prevHash !== prevHash) {
          return { valid: false, brokenAt: i, total: lines.length };
        }

        const computed =
          entry.hashScheme === "hmac-v1"
            ? computeEntryHash(entry)
            : createHash("sha256").update(legacyPayload(entry)).digest("hex");
        if (computed !== entry.hash) {
          return { valid: false, brokenAt: i, total: lines.length };
        }
        heads.push({ seq: entry.seq, hash: entry.hash });
        prevHash = entry.hash;
      } catch {
        return { valid: false, brokenAt: i, total: lines.length };
      }
    }

    // Cross-check against the external anchor chain. The linear chain above
    // can't detect tail-truncation (a valid prefix is still a valid chain);
    // the anchor file pins (seq, head, count) so a dropped tail no longer
    // matches. `eraActive` here is key-presence-driven, so in the keyed era an
    // ABSENT anchor file beside a non-empty audit file is itself truncation
    // evidence and fails closed — the attacker who drops the tail also deletes
    // the anchor. Only a genuine pre-key/pre-anchoring log (no seed, no era,
    // no anchor) skips the cross-check.
    const anchorResult = verifyAnchors(anchorPathFor(filePath), heads, eraActive);
    if (anchorResult.broken) {
      return { valid: false, brokenAt: anchorResult.brokenAt, total: lines.length, anchorChecked: true };
    }
    return { valid: true, total: lines.length, anchorChecked: anchorResult.checked };
  }

  getRecent(count: number = 20): AuditEntry[] {
    return this.entries.slice(-count);
  }
}

// ═══════════════════════════════════════════════════════════════════
// SHARED SINGLE-WRITER REGISTRY (finding H10)
// ═══════════════════════════════════════════════════════════════════
//
// Multiple independent writers (declassify in data-lineage, canary-exfil in
// canaries, every per-turn ThreatEngine) all target the SAME daily audit file.
// Each `new CryptoAuditTrail` only resumes the chain head in its constructor,
// then mutates its OWN in-memory seq/prevHash and blind-appends. Two live
// instances at the same head write conflicting prevHash/seq (and colliding
// anchor counts), permanently breaking verify() during NORMAL operation — a
// denial-of-integrity an attacker can trigger by interleaving writes.
//
// Fix: hand every writer for a given audit location the SAME instance. record()
// is synchronous (no await between reading prevHash and appending), so Node's
// single thread naturally serializes interleaved record() calls on one shared
// instance — no lock needed.
//
// Concurrency honesty: this closes the SAME-PROCESS multi-instance desync, which
// is the actual bug. The app writes audit from a single process, so that's the
// whole exposure. It does NOT add cross-PROCESS file locking — if two OS
// processes ever wrote this file concurrently they could still race the append;
// that's out of scope here (no flock) because no such second writer exists.
const sharedAuditTrails = new Map<string, CryptoAuditTrail>();

/**
 * Return the process-wide SHARED CryptoAuditTrail for `<dataDir>/audit`,
 * constructing it once and memoizing per resolved audit location. Repeated calls
 * for the same dataDir return the SAME object, so all writers for one daily file
 * stay on a single serialized chain head.
 */
export function getSharedAuditTrail(dataDir: string): CryptoAuditTrail {
  const key = join(dataDir, "audit");
  let trail = sharedAuditTrails.get(key);
  if (!trail) {
    trail = new CryptoAuditTrail(dataDir);
    sharedAuditTrails.set(key, trail);
  }
  return trail;
}
