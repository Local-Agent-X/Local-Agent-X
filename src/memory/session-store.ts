/**
 * SessionStore — persists chat sessions to one append-friendly jsonl file
 * per session.
 *
 * On disk: `~/.lax/sessions/{id}.jsonl` is the single source of truth for
 * the session. The actual format helpers live in `session-message-log.ts`;
 * this class wraps them with the sessions-list cache
 * (`session-metadata-cache.ts`), which the list endpoint reads instead of
 * re-reading every file.
 *
 * Migration: on construction, any legacy `{id}.json` files in the sessions
 * dir are converted to `{id}.jsonl` and the originals renamed to
 * `{id}.json.pre-migration`. Idempotent — re-running on an already-migrated
 * dir is a no-op.
 */
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../types.js";
import {
  readSessionLog,
  readSessionLogForUI,
  writeSessionLog,
  deleteSessionLog,
  listSessionIds,
  migrateAllLegacy,
} from "./session-message-log.js";
import { SessionMetadataCache, metadataOf, type SessionMetadata } from "./session-metadata-cache.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.session-store");

export type { SessionMetadata };

export class SessionStore {
  private dir: string;
  private archiveDir: string;
  private metadata: SessionMetadataCache;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "sessions");
    this.archiveDir = join(dataDir, "sessions-archive");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const result = migrateAllLegacy(this.dir);
    if (result.migrated > 0) {
      logger.info(`migrated ${result.migrated} legacy .json sessions to .jsonl (skipped ${result.skipped})`);
    }
    this.metadata = new SessionMetadataCache(this.dir);
  }

  save(session: Session): void {
    writeSessionLog(this.dir, session);
    this.metadata.set(metadataOf(session));
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
    return this.metadata.values().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Bring session logs another writer put on disk (sync pulls) into the list
   * cache, so they are listed and summarised like this machine's own. The
   * cache is otherwise rebuilt only when its snapshot is missing.
   */
  adopt(ids: readonly string[]): void {
    for (const id of ids) {
      const session = readSessionLog(this.dir, id);
      if (session) this.metadata.set(metadataOf(session));
    }
  }

  delete(id: string): void {
    deleteSessionLog(this.dir, id);
    this.metadata.delete(id);
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
        this.metadata.forget(id);
        archived++;
      } catch (e) {
        failed++;
        logger.warn(`archive failed for session ${id}: ${(e as Error).message}`);
      }
    }
    if (archived > 0) this.metadata.compact();
    return { archived, skipped, failed };
  }
}
