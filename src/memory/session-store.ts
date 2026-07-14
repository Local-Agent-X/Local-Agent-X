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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
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

export class SessionStore {
  private dir: string;
  private archiveDir: string;
  private metadataCache = new Map<
    string,
    { id: string; title: string; updatedAt: number; messageCount: number; projectId?: string }
  >();

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
    this.metadataCache.set(session.id, {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      projectId: session.projectId,
    });
    this.saveMetadataCache();
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

  list(): Array<{ id: string; title: string; updatedAt: number; messageCount: number; projectId?: string }> {
    return [...this.metadataCache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    deleteSessionLog(this.dir, id);
    this.metadataCache.delete(id);
    this.saveMetadataCache();
  }

  /**
   * Move sessions whose .jsonl mtime is older than `maxAgeDays` into
   * `<dataDir>/sessions-archive/`. NEVER deletes: files are renamed, and a
   * name collision in the archive counts as a failure and leaves both copies
   * untouched. Sessions written within the last 24h are always skipped as an
   * activity guard (the store has no "currently loaded" concept — a live
   * session's file was written this turn, so recency is the sound proxy).
   * Per-session errors are isolated so one bad file can't abort the sweep.
   */
  archiveOldSessions(maxAgeDays: number): { archived: number; skipped: number; failed: number } {
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
    if (archived > 0) this.saveMetadataCache();
    return { archived, skipped, failed };
  }

  // ── Metadata cache ──

  private get metadataPath(): string {
    return join(this.dir, ".metadata.json");
  }

  private loadMetadataCache(): void {
    try {
      if (existsSync(this.metadataPath)) {
        const entries = JSON.parse(readFileSync(this.metadataPath, "utf-8")) as Array<{
          id: string;
          title: string;
          updatedAt: number;
          messageCount: number;
          projectId?: string;
        }>;
        for (const entry of entries) {
          this.metadataCache.set(entry.id, entry);
        }
      } else {
        this.rebuildMetadataCache();
      }
    } catch {
      this.rebuildMetadataCache();
    }
  }

  private rebuildMetadataCache(): void {
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
    this.saveMetadataCache();
  }

  private saveMetadataCache(): void {
    try {
      atomicWriteFileSync(
        this.metadataPath,
        JSON.stringify([...this.metadataCache.values()]),
      );
    } catch {
      // non-fatal
    }
  }
}
