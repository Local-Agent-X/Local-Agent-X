/**
 * The sessions-list projection: an in-memory map of one row per session,
 * backed on disk by a `.metadata.json` snapshot plus an append-only
 * `.metadata.jsonl` journal in the sessions directory.
 *
 * Durability contract: a save appends one O(1) journal row; the O(sessions)
 * snapshot happens only on an amortized compaction, a rebuild, an archive
 * sweep, or while an earlier write is unaccounted for. A process that dies
 * without any shutdown path must still leave every saved row on disk.
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../types.js";
import { atomicWriteFileSync } from "./utils.js";
import { readSessionLog, listSessionIds } from "./session-message-log.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.session-store");

/** One session's row in the sessions-list projection. */
export interface SessionMetadata {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  projectId?: string;
}

/** A journal row: a metadata upsert, or a tombstone for a removed session. */
type MetadataJournalRow = SessionMetadata | { id: string; deleted: true };

/**
 * A journal line: one row plus `g`, the snapshot generation it was written
 * under — a snapshot supersedes every row appended before it, and `g` is what
 * says so on disk. Lines from before generations existed have no `g` and
 * belong to generation 0, which is what a bare-array snapshot also reports.
 */
type MetadataJournalLine = { g: number; r: MetadataJournalRow };

/** The `.metadata.json` snapshot; pre-generation files are a bare row array. */
type MetadataSnapshot = { gen: number; rows: SessionMetadata[] };

// Compaction threshold for the metadata journal. Rewriting the snapshot costs
// O(sessions); appending one journal row costs O(1). Compacting only once the
// journal is as long as the store is wide keeps the amortized per-save cost at
// roughly one row no matter how many sessions exist. The floor stops a small
// store from compacting every few turns.
const METADATA_JOURNAL_FLOOR = 200;

export function metadataOf(session: Session): SessionMetadata {
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    projectId: session.projectId,
  };
}

export class SessionMetadataCache {
  private readonly rows = new Map<string, SessionMetadata>();
  /** Journal rows appended under the CURRENT generation. */
  private journalRows = 0;
  /** Generation of the snapshot on disk; stamped on every journal line. */
  private generation = 0;
  /** Set when a metadata write failed: disk no longer describes the cache. */
  private dirty = false;

  /** `dir` is the sessions directory the snapshot and journal live in. */
  constructor(private readonly dir: string) {
    this.load();
  }

  private get snapshotPath(): string { return join(this.dir, ".metadata.json"); }
  private get journalPath(): string { return join(this.dir, ".metadata.jsonl"); }

  values(): SessionMetadata[] { return [...this.rows.values()]; }

  /** Upsert one row and journal it. */
  set(meta: SessionMetadata): void {
    this.rows.set(meta.id, meta);
    this.append(meta);
  }

  /** Forget one row and journal the tombstone. */
  delete(id: string): void {
    this.rows.delete(id);
    this.append({ id, deleted: true });
  }

  /** Forget a row without journaling; the caller compacts once at the end. */
  forget(id: string): void {
    this.rows.delete(id);
  }

  private load(): void {
    try {
      if (!existsSync(this.snapshotPath)) {
        // No snapshot — the journal alone can't be trusted to cover every
        // session, so re-derive from the session files.
        this.rebuild();
        return;
      }
      const parsed = JSON.parse(readFileSync(this.snapshotPath, "utf-8")) as MetadataSnapshot | SessionMetadata[];
      // Pre-generation files are a bare row array.
      const snapshot: MetadataSnapshot = Array.isArray(parsed) ? { gen: 0, rows: parsed } : parsed;
      if (!Array.isArray(snapshot?.rows)) throw new Error("metadata snapshot is not a row array");
      this.generation = typeof snapshot.gen === "number" ? snapshot.gen : 0;
      for (const entry of snapshot.rows) this.rows.set(entry.id, entry);
    } catch {
      this.rebuild();
      return;
    }
    this.journalRows = this.replayJournal();
  }

  /**
   * Apply the journal over the loaded snapshot; returns the rows applied.
   * Lines stamped with a generation other than the snapshot's are skipped —
   * they were superseded by a later snapshot, or belong to a newer one whose
   * write never completed.
   *
   * A torn trailing line (crash part-way through an append) is dropped, and
   * the file is CUT BACK to its last complete line before anything can append
   * to it: a torn line has no trailing "\n", so the next append would
   * concatenate onto it and the two would merge into one unparseable line,
   * taking the newly saved session down with the torn row.
   */
  private replayJournal(): number {
    if (!existsSync(this.journalPath)) return 0;
    let raw: string;
    try {
      raw = readFileSync(this.journalPath, "utf-8");
    } catch {
      return 0;
    }
    if (raw.length > 0 && !raw.endsWith("\n")) {
      raw = raw.slice(0, raw.lastIndexOf("\n") + 1);
      try {
        writeFileSync(this.journalPath, raw, "utf-8");
      } catch (e) {
        // Can't repair the file — appending to it would corrupt the next row,
        // so make the next save snapshot instead of append.
        this.dirty = true;
        logger.warn(`could not truncate a torn metadata journal: ${(e as Error).message}`);
      }
    }
    let applied = 0;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed: Partial<MetadataJournalLine> & Partial<MetadataJournalRow>;
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      if (!parsed) continue;
      const gen = typeof parsed.g === "number" ? parsed.g : 0;
      const row = (parsed.r ?? parsed) as MetadataJournalRow;
      if (!row || typeof row.id !== "string") continue;
      if (gen !== this.generation) continue; // superseded by a later snapshot
      if ("deleted" in row) this.rows.delete(row.id);
      else this.rows.set(row.id, row);
      applied++;
    }
    return applied;
  }

  /**
   * Persist one metadata change — the ONLY per-save durability path, so a
   * failure here can never be quiet: a dropped row hides a real session from
   * the list forever while its .jsonl sits on disk. Fast path is an O(1)
   * journal append; the whole-cache snapshot is added on top only while an
   * earlier write is unaccounted for, and is retried until one lands.
   *
   * The append is ALWAYS attempted, dirty or not: it is O(1), last-write-wins
   * so re-appending costs nothing, and for a DELETE it is the only carrier
   * there is — a tombstone that never reaches the journal cannot be inferred
   * from anything else on disk, and the row it was meant to un-say is still
   * sitting in the file.
   */
  private append(row: MetadataJournalRow): void {
    const line: MetadataJournalLine = { g: this.generation, r: row };
    try {
      appendFileSync(this.journalPath, JSON.stringify(line) + "\n", "utf-8");
      this.journalRows++;
    } catch (e) {
      if (!this.dirty) {
        this.dirty = true;
        logger.warn(`metadata journal append failed (${(e as Error).message}) — falling back to a snapshot`);
      }
    }
    // Dirty means an EARLIER row never reached disk, and only the whole-cache
    // snapshot still carries it; retry that every save until one lands.
    if (this.dirty || this.journalRows >= Math.max(METADATA_JOURNAL_FLOOR, this.rows.size)) {
      this.compact();
    }
  }

  /** Re-derive every row from the session files, then snapshot. */
  rebuild(): void {
    this.rows.clear();
    if (!existsSync(this.dir)) return;
    for (const id of listSessionIds(this.dir)) {
      const session = readSessionLog(this.dir, id);
      if (session) this.rows.set(session.id, metadataOf(session));
    }
    this.compact();
  }

  /**
   * Snapshot the whole cache under a NEW generation, then drop the journal it
   * supersedes. O(sessions) — only ever reached on an amortized compaction, a
   * rebuild, an archive sweep, or the failed-write fallback, never on the
   * healthy per-save path.
   *
   * The snapshot write ALONE is the point where disk and cache are known to
   * agree: it is atomic (tmp+rename, so a failure leaves the previous
   * generation intact) and its generation invalidates every journal line
   * before it. So that write — not the journal drop after it — is what clears
   * the dirty flag and what the next save retries.
   */
  compact(): void {
    const nextGen = this.generation + 1;
    const snapshot: MetadataSnapshot = { gen: nextGen, rows: [...this.rows.values()] };
    try {
      atomicWriteFileSync(this.snapshotPath, JSON.stringify(snapshot));
    } catch (e) {
      // Disk and cache disagree; stay dirty so the next save writes the whole
      // cache again. Logged once per outage, not once per save.
      if (!this.dirty) {
        logger.warn(`metadata snapshot write failed: ${(e as Error).message}`);
        this.dirty = true;
      }
      return;
    }
    this.generation = nextGen;
    this.journalRows = 0;
    if (this.dirty) {
      this.dirty = false;
      logger.info("metadata snapshot recovered — every row dropped by the failed writes is back on disk");
    }
    this.dropSupersededJournal();
  }

  /**
   * Remove the journal the snapshot just superseded. Best-effort by design:
   * its rows carry an older generation and are skipped on replay, so failing
   * costs disk space, never correctness, and the append path stays open.
   * Truncating is the fallback — a handle held without DELETE share access
   * (AV scanner, search indexer) blocks the unlink but not the open-for-write.
   */
  private dropSupersededJournal(): void {
    try {
      rmSync(this.journalPath, { force: true });
      return;
    } catch { /* locked against delete — try emptying it in place */ }
    try {
      writeFileSync(this.journalPath, "", "utf-8");
    } catch (e) {
      logger.warn(`superseded metadata journal left on disk: ${(e as Error).message}`);
    }
  }
}
