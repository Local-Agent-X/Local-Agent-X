/**
 * SessionStore — persists chat sessions to one append-friendly jsonl file
 * per session.
 *
 * On disk: `~/.lax/sessions/{id}.jsonl` is the single source of truth for
 * the session. The actual format helpers live in `session-message-log.ts`;
 * this class wraps them with an in-memory metadata cache (used by the
 * sessions-list endpoint to avoid re-reading every file).
 *
 * Migration: on construction, any legacy `{id}.json` files in the sessions
 * dir are converted to `{id}.jsonl` and the originals renamed to
 * `{id}.json.pre-migration`. Idempotent — re-running on an already-migrated
 * dir is a no-op.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../types.js";
import { atomicWriteFileSync } from "./utils.js";
import {
  readSessionLog,
  readSessionLogForUI,
  writeSessionLog,
  deleteSessionLog,
  listSessionIds,
  migrateAllLegacy,
} from "./session-message-log.js";

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

export class SessionStore {
  private dir: string;
  private archiveDir: string;
  private metadataCache = new Map<string, SessionMetadata>();
  /** Journal rows appended under the CURRENT generation. */
  private journalRows = 0;
  /** Generation of the snapshot on disk; stamped on every journal line. */
  private metadataGen = 0;
  /** Set when a metadata write failed: disk no longer describes the cache. */
  private metadataDirty = false;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "sessions");
    this.archiveDir = join(dataDir, "sessions-archive");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const result = migrateAllLegacy(this.dir);
    if (result.migrated > 0) {
      logger.info(`migrated ${result.migrated} legacy .json sessions to .jsonl (skipped ${result.skipped})`);
    }
    this.loadMetadataCache();
  }

  save(session: Session): void {
    writeSessionLog(this.dir, session);
    const meta: SessionMetadata = {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      projectId: session.projectId,
    };
    this.metadataCache.set(session.id, meta);
    this.appendMetadata(meta);
  }

  load(id: string): Session | null {
    return readSessionLog(this.dir, id);
  }

  /**
   * Load the UI projection — text-only user/assistant timeline plus
   * compaction summary. Drops `tool` rows and `tool_calls` on assistants
   * so chat.js can render without per-row special-casing. Frontend
   * routes use this; model-side code uses {@link load} for the rich
   * form. See `readSessionLogForUI` for rationale.
   */
  loadForUI(id: string): Session | null {
    return readSessionLogForUI(this.dir, id);
  }

  list(): SessionMetadata[] {
    return [...this.metadataCache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    deleteSessionLog(this.dir, id);
    this.metadataCache.delete(id);
    this.appendMetadata({ id, deleted: true });
  }

  /**
   * Move sessions whose .jsonl mtime is older than `maxAgeDays` into
   * `<dataDir>/sessions-archive/`. NEVER deletes: files are renamed, and a
   * name collision in the archive counts as a failure and leaves both copies
   * untouched. Sessions written within the last 24h are always skipped as an
   * activity guard (the store has no "currently loaded" concept — a live
   * session's file was written this turn, so recency is the sound proxy).
   * Per-session errors are isolated so one bad file can't abort the sweep.
   *
   * `onArchived(oldPath, newPath)` fires after each successful move so the
   * caller can keep dependent state consistent (the memory index re-points
   * the session's files row — its embedded chunks are keyed by absolute
   * path, and losing that link would let the sync sweep delete them). If it
   * throws, the move is ROLLED BACK (file renamed home, session counted
   * failed) — a moved transcript whose index still points at the old path
   * would be swept as removed on the next sync.
   */
  archiveOldSessions(
    maxAgeDays: number,
    onArchived?: (oldPath: string, newPath: string) => void,
  ): { archived: number; skipped: number; failed: number } {
    const now = Date.now();
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    const activityGuard = now - 24 * 60 * 60 * 1000;
    let archived = 0;
    let skipped = 0;
    let failed = 0;
    for (const id of listSessionIds(this.dir)) {
      try {
        const src = join(this.dir, `${id}.jsonl`);
        const st = statSync(src);
        if (!st.isFile()) { skipped++; continue; } // dir masquerading as a session — not ours to move
        if (st.mtimeMs > cutoff || st.mtimeMs > activityGuard) continue; // recent — untouched
        mkdirSync(this.archiveDir, { recursive: true });
        const dest = join(this.archiveDir, `${id}.jsonl`);
        if (existsSync(dest)) {
          // Same id already archived — never overwrite (that would destroy
          // whichever copy loses). Leave both in place and flag it.
          logger.warn(`archive collision for session ${id} — leaving both copies untouched`);
          failed++;
          continue;
        }
        renameSync(src, dest);
        if (onArchived) {
          try {
            onArchived(src, dest);
          } catch (e) {
            renameSync(dest, src); // roll the move back — see doc comment
            logger.warn(`archive rolled back for session ${id}: ${(e as Error).message}`);
            failed++;
            continue;
          }
        }
        // Per-session sidecar from the legacy migration rides along.
        const sidecar = join(this.dir, `${id}.json.pre-migration`);
        if (existsSync(sidecar)) {
          const sidecarDest = join(this.archiveDir, `${id}.json.pre-migration`);
          if (!existsSync(sidecarDest)) {
            try { renameSync(sidecar, sidecarDest); } catch { /* jsonl moved — sidecar is best-effort */ }
          }
        }
        this.metadataCache.delete(id);
        archived++;
      } catch (e) {
        failed++;
        logger.warn(`archive failed for session ${id}: ${(e as Error).message}`);
      }
    }
    if (archived > 0) this.compactMetadataCache();
    return { archived, skipped, failed };
  }

  // ── Metadata cache ──
  //
  // Two files, both dot-prefixed so listSessionIds/migrateAllLegacy ignore
  // them: `.metadata.json` snapshots every session's list row and
  // `.metadata.jsonl` journals the changes since that snapshot. A save appends
  // ONE line instead of re-serializing every session in the store plus a
  // tmp+rename, which made the metadata write cost O(all sessions) on every
  // single turn. Load = snapshot then journal replay; rows are last-write-wins
  // per id, so replay is idempotent, and durability is at append time — there
  // is no deferred flush for an unclean exit to skip.
  //
  // A compaction is TWO writes and the second can fail alone (the journal drop
  // is an unlink; a held handle makes it EBUSY with no retry), leaving a
  // journal OLDER than the snapshot beside it — replaying that would roll rows
  // backwards and resurrect deleted sessions. So the two are tied by a
  // GENERATION: the snapshot carries one, every journal line is stamped with
  // it, and replay skips lines from any other. A journal we failed to drop is
  // then inert, and appends keep going into it.

  private get metadataPath(): string {
    return join(this.dir, ".metadata.json");
  }

  private get journalPath(): string {
    return join(this.dir, ".metadata.jsonl");
  }

  private loadMetadataCache(): void {
    try {
      if (!existsSync(this.metadataPath)) {
        // No snapshot — the journal alone can't be trusted to cover every
        // session, so re-derive from the session files.
        this.rebuildMetadataCache();
        return;
      }
      const parsed = JSON.parse(readFileSync(this.metadataPath, "utf-8")) as
        | MetadataSnapshot
        | SessionMetadata[];
      // Pre-generation files are a bare row array.
      const snapshot: MetadataSnapshot = Array.isArray(parsed) ? { gen: 0, rows: parsed } : parsed;
      if (!Array.isArray(snapshot?.rows)) throw new Error("metadata snapshot is not a row array");
      this.metadataGen = typeof snapshot.gen === "number" ? snapshot.gen : 0;
      for (const entry of snapshot.rows) this.metadataCache.set(entry.id, entry);
    } catch {
      this.rebuildMetadataCache();
      return;
    }
    this.journalRows = this.replayMetadataJournal();
  }

  /**
   * Apply the journal over the loaded snapshot; returns the rows applied.
   * Lines stamped with a generation other than the snapshot's are skipped —
   * the snapshot already contains everything written before it, so replaying
   * them would undo it.
   *
   * A torn trailing line (crash part-way through an append) is dropped, and
   * the file is CUT BACK to its last complete line before anything can append
   * to it: a torn line has no trailing "\n", so the next append would
   * concatenate onto it and the two would merge into one unparseable line,
   * taking the newly saved session down with the torn row.
   */
  private replayMetadataJournal(): number {
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
        this.metadataDirty = true;
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
      if (gen !== this.metadataGen) continue; // superseded by a later snapshot
      if ("deleted" in row) this.metadataCache.delete(row.id);
      else this.metadataCache.set(row.id, row);
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
  private appendMetadata(row: MetadataJournalRow): void {
    const line: MetadataJournalLine = { g: this.metadataGen, r: row };
    try {
      appendFileSync(this.journalPath, JSON.stringify(line) + "\n", "utf-8");
      this.journalRows++;
    } catch (e) {
      if (!this.metadataDirty) {
        this.metadataDirty = true;
        logger.warn(`metadata journal append failed (${(e as Error).message}) — falling back to a snapshot`);
      }
    }
    // Dirty means an EARLIER row never reached disk, and only the whole-cache
    // snapshot still carries it; retry that every save until one lands.
    if (this.metadataDirty || this.journalRows >= Math.max(METADATA_JOURNAL_FLOOR, this.metadataCache.size)) {
      this.compactMetadataCache();
    }
  }

  private rebuildMetadataCache(): void {
    this.metadataCache.clear();
    if (!existsSync(this.dir)) return;
    for (const id of listSessionIds(this.dir)) {
      const session = readSessionLog(this.dir, id);
      if (!session) continue;
      this.metadataCache.set(session.id, {
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        projectId: session.projectId,
      });
    }
    this.compactMetadataCache();
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
  private compactMetadataCache(): void {
    const nextGen = this.metadataGen + 1;
    const snapshot: MetadataSnapshot = { gen: nextGen, rows: [...this.metadataCache.values()] };
    try {
      atomicWriteFileSync(this.metadataPath, JSON.stringify(snapshot));
    } catch (e) {
      // Disk and cache disagree; stay dirty so the next save writes the whole
      // cache again. Logged once per outage, not once per save.
      if (!this.metadataDirty) {
        logger.warn(`metadata snapshot write failed: ${(e as Error).message}`);
        this.metadataDirty = true;
      }
      return;
    }
    this.metadataGen = nextGen;
    this.journalRows = 0;
    if (this.metadataDirty) {
      this.metadataDirty = false;
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
