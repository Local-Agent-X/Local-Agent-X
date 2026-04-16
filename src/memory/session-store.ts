/**
 * SessionStore — persists chat sessions as JSON files.
 *
 * Maintains an in-memory metadata cache for fast listings. The cache is
 * persisted alongside the sessions so we don't re-read every file on boot.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../types.js";
import { atomicWriteFileSync } from "./utils.js";

export class SessionStore {
  private dir: string;
  private metadataCache = new Map<
    string,
    { id: string; title: string; updatedAt: number; messageCount: number }
  >();

  constructor(dataDir: string) {
    this.dir = join(dataDir, "sessions");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.loadMetadataCache();
  }

  save(session: Session): void {
    const filePath = join(this.dir, `${session.id}.json`);
    atomicWriteFileSync(filePath, JSON.stringify(session, null, 2));

    this.metadataCache.set(session.id, {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    });
    this.saveMetadataCache();
  }

  load(id: string): Session | null {
    const filePath = join(this.dir, `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  list(): Array<{ id: string; title: string; updatedAt: number; messageCount: number }> {
    return [...this.metadataCache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    const filePath = join(this.dir, `${id}.json`);
    try { unlinkSync(filePath); } catch {}
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
    const files = readdirSync(this.dir).filter(
      (f) => f.endsWith(".json") && !f.startsWith(".")
    );

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(this.dir, file), "utf-8")) as Session;
        this.metadataCache.set(data.id, {
          id: data.id,
          title: data.title,
          updatedAt: data.updatedAt,
          messageCount: data.messages.length,
        });
      } catch {
        // skip corrupted files
      }
    }

    this.saveMetadataCache();
  }

  private saveMetadataCache(): void {
    try {
      atomicWriteFileSync(
        this.metadataPath,
        JSON.stringify([...this.metadataCache.values()])
      );
    } catch {
      // non-fatal
    }
  }
}
