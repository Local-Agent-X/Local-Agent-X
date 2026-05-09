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
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../types.js";
import { atomicWriteFileSync } from "./utils.js";
import {
  readSessionLog,
  writeSessionLog,
  deleteSessionLog,
  listSessionIds,
  migrateAllLegacy,
} from "./session-message-log.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.session-store");

export class SessionStore {
  private dir: string;
  private metadataCache = new Map<
    string,
    { id: string; title: string; updatedAt: number; messageCount: number }
  >();

  constructor(dataDir: string) {
    this.dir = join(dataDir, "sessions");
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
    });
    this.saveMetadataCache();
  }

  load(id: string): Session | null {
    return readSessionLog(this.dir, id);
  }

  list(): Array<{ id: string; title: string; updatedAt: number; messageCount: number }> {
    return [...this.metadataCache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    deleteSessionLog(this.dir, id);
    this.metadataCache.delete(id);
    this.saveMetadataCache();
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
