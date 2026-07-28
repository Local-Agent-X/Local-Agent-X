import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
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

// How often record() re-checks that its held handles still point at the live
// files and that the era marker is still sealed (see revalidate()). The record cap
// bounds COST during a burst; the wall-clock cap bounds EXPOSURE when records are
// sparse — the real agent workload, where a tool call every few hundred ms gives
// effectively per-record self-healing. Measured over 1500-record bursts:
// reopen-per-append 1265-2101µs/record, held handles 55µs, held+tick 128-176µs.
const REVALIDATE_EVERY_RECORDS = 8;
const REVALIDATE_EVERY_MS = 250;

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
  // Held append handles for the current daily file and its anchor file, opened
  // LAZILY on the first record() and dropped on the daily rollover. Lazy on
  // purpose: constructing a trail must not create the day's file — a trail that
  // never records leaves no audit file behind (see appendLine()).
  private mainFd: number | null = null;
  private anchorFd: number | null = null;
  // Revalidation tick state (see revalidate()). Seeded past the cap so the
  // FIRST record against any daily file always revalidates.
  private recordsSinceRevalidate = REVALIDATE_EVERY_RECORDS;
  private lastRevalidateAt = 0;

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
    // Drop the previous day's append handles before repointing — the next
    // record() reopens against the new file. No-op on the constructor path.
    this.closeHandle("mainFd");
    this.closeHandle("anchorFd");
    this.recordsSinceRevalidate = REVALIDATE_EVERY_RECORDS;
    this.lastRevalidateAt = 0;
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

  /**
   * Append one line through a HELD append-mode handle, opening it on first use.
   * Holding it IS the optimization: the open, not the write, is the expensive
   * half (see the cadence constants above for the measured split).
   *
   * Deliberately NOT a write buffer. Each record still writes SYNCHRONOUSLY, so
   * its bytes are with the OS before record() returns — byte-identical output,
   * and the same CRASH durability as the per-call writeFileSync it replaces (a
   * child doing 50 record()s then process.abort() lands 50/50 rows). What a held
   * handle does NOT inherit is that open()'s implicit SELF-HEALING, so PATH
   * durability is revalidate()'s job, not this function's. Buffering stays off
   * the table: a crash would drop the chain tail from the main file AND the
   * anchor file CONSISTENTLY, and verify() accepts a consistently-shortened pair
   * as clean — the silent tail-truncation the anchor chain exists to catch.
   *
   * The write must LOOP: writeSync issues ONE write and may return a SHORT
   * count, where writeFileSync looped until every byte landed. Unchecked, it
   * would truncate a JSONL line — a chain break manufactured by the writer.
   *
   * Write failures stay swallowed (an audit write failure must not crash the
   * agent) and drop the suspect handle so the next record retries the open. The
   * two files fail INDEPENDENTLY, as the old per-call try/catch did: a dead
   * anchor handle must not suppress the main append — the mismatch is evidence.
   */
  private appendLine(handle: "mainFd" | "anchorFd", path: string, line: string): void {
    try {
      const fd = this[handle] ?? openSync(path, "a", 0o600);
      this[handle] = fd;
      const buf = Buffer.from(line, "utf8");
      for (let off = 0; off < buf.length;) {
        const n = writeSync(fd, buf, off, buf.length - off);
        if (n <= 0) throw new Error(`audit append stalled at ${off}/${buf.length} bytes`);
        off += n;
      }
    } catch {
      this.closeHandle(handle);
    }
  }

  /**
   * Close and forget one append handle (idempotent). Called on the daily
   * rollover, on a stale/failed handle, and never at process exit: nothing is
   * buffered behind them, so an abrupt exit loses nothing the OS already has.
   */
  private closeHandle(handle: "mainFd" | "anchorFd"): void {
    const fd = this[handle];
    this[handle] = null;
    if (fd !== null) {
      try { closeSync(fd); } catch { /* handle already gone */ }
    }
  }

  /**
   * Has `fd` stopped being the file at `path`? IDENTITY, not mere existence: an
   * attacker who unlinks the log and drops a valid PREFIX back at the same path
   * satisfies existsSync() while the handle feeds the dead inode, leaving a
   * short self-consistent chain and erasing the rest without evidence. Inode
   * comparison catches the swap; a missing/unreadable path throws and counts as
   * stale. (Filesystems reporting ino 0 degrade to the presence check, no worse.)
   */
  private stale(fd: number, path: string): boolean {
    try { return statSync(path, { bigint: true }).ino !== fstatSync(fd, { bigint: true }).ino; }
    catch { return true; }
  }

  /**
   * Re-establish the two self-healing properties a HELD handle gave up. Bounded
   * exposure: at most REVALIDATE_EVERY_RECORDS records, or REVALIDATE_EVERY_MS
   * of wall clock, elapse between one tick and the next.
   *
   * 1. A handle outlives its path (see stale()). It keeps feeding an orphaned
   *    inode while verify() reads whatever is at the path — nothing, or an
   *    attacker's stub — and calls it clean. Dropping the handle makes the next
   *    append reopen BY PATH, and because seq/prevHash keep running in memory
   *    that file's next row carries a mismatched prevHash: the re-root verify()
   *    catches, plus post-tick rows survive on disk for forensics.
   * 2. The era marker is deletable. Delete the audit SEED FILE too and
   *    hasPersistedAuditKey() goes false, leaving the marker as the only signal
   *    standing between a wholesale plain-SHA-256 rewrite and verify() ACCEPTING
   *    it. Re-sealing from the still-cached in-process key keeps that shut; the
   *    old code got this free by writing the marker on every record. Best effort
   *    and never latched — a failed seal must not crash the agent, next tick retries.
   */
  private revalidate(): void {
    this.recordsSinceRevalidate = 0;
    this.lastRevalidateAt = Date.now();
    if (this.mainFd !== null && this.stale(this.mainFd, this.filePath)) this.closeHandle("mainFd");
    if (this.anchorFd !== null && this.stale(this.anchorFd, this.anchorPath)) this.closeHandle("anchorFd");
    try { writeEraMarker(this.markerPath); } catch { /* marker write failure shouldn't crash the agent */ }
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

    // Self-healing tick, BEFORE the appends so this record lands in a live file
    // under a sealed marker: re-point held handles whose files were swapped or
    // unlinked, and re-seal the "hmac-v1 era" marker that tells verify() to
    // refuse the unkeyed legacy fallback. Both were free side effects of the old
    // open-per-record path. Never latched once-per-file — an attacker acts AFTER
    // the first record, by which time a latch has already fired.
    if (this.recordsSinceRevalidate >= REVALIDATE_EVERY_RECORDS
      || Date.now() - this.lastRevalidateAt >= REVALIDATE_EVERY_MS) {
      this.revalidate();
    }
    this.recordsSinceRevalidate++;

    // Append to daily file (JSONL format)
    this.appendLine("mainFd", this.filePath, JSON.stringify(full) + "\n");

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
    this.appendLine("anchorFd", this.anchorPath, JSON.stringify(anchor) + "\n");
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
   * Key-presence is the strongest signal but NOT a sole backstop. A keyed install
   * signs 100% hmac-v1, so an attacker who DELETES the marker AND the anchor and
   * rewrites every row as a self-consistent plain-SHA-256 chain (no key needed)
   * still meets an active era — while the seed resolves. Delete the seed FILE too
   * and it does not: hasPersistedAuditKey() reads the disk while the writer keeps
   * signing from its cached key, so all three signals fall together. Hence
   * record() re-seals the marker on a bounded cadence (revalidate()).
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
    // OR the sealed marker exists, OR any row is still tagged hmac-v1. THREE
    // independent signals, none of them individually sufficient — see the
    // docstring above for which attacker action takes which one down.
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
