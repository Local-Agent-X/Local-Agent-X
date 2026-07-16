import { readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type Database from "better-sqlite3";
import type { Session } from "../types.js";
import type { CanonicalSource, Chunk, ChunkMetadata, EmbeddingProvider, FileRecord, MemoryConfig } from "./types.js";
import { chunkConversationPairs, extractSessionPairs } from "./chunking.js";
import { chunkText, withChunkProvenance } from "./search-helpers.js";
import { redactCredentials, safeReadTextFile } from "./utils.js";
import { encodeEmbedding } from "./embedding-codec.js";
import { embedChunksWithRetry, pruneEmbeddingCache } from "./index-embedding.js";
import { archiveOldFacts } from "./index-watcher.js";
import { listMemoryFiles, listSessionFiles, extractDateFromPath } from "./index-files.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-sync");

export function countSessionMessages(path: string): number {
  try {
    const session = JSON.parse(readFileSync(path, "utf-8")) as Session;
    return session.messages.length;
  } catch {
    return 0;
  }
}

export function flattenSession(path: string): string {
  try {
    const session = JSON.parse(readFileSync(path, "utf-8")) as Session;
    const lines: string[] = [
      `Session: ${session.title}`,
      `Date: ${new Date(session.createdAt).toISOString()}`,
      "",
    ];

    for (const msg of session.messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        let content = "";
        if (typeof msg.content === "string") {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          content = (msg.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
        }
        if (content) {
          const safe = redactCredentials(content);
          lines.push(`[${msg.role}] ${safe}`);
          lines.push("");
        }
      }
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

export function removeFile(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  hasVec: boolean,
  path: string
): void {
  const doRemove = db.transaction(() => {
    const chunks = db
      .prepare("SELECT id FROM chunks WHERE path = ?")
      .all(path) as { id: number }[];

    if (chunks.length > 0) {
      if (hasFts) {
        for (const { id } of chunks) {
          try {
            db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(id);
          } catch {}
        }
      }
      if (hasVec) {
        for (const { id } of chunks) {
          try {
            db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?").run(id);
          } catch {}
        }
      }
      db.prepare("DELETE FROM chunks WHERE path = ?").run(path);
    }

    db.prepare("DELETE FROM files WHERE path = ?").run(path);
  });

  doRemove();
}

/**
 * Re-point an indexed file to a new on-disk location, keeping every chunk
 * (fts/vec rows are keyed by chunk id, so they follow automatically).
 *
 * Used by session archival: archiveOldSessions moves the transcript to
 * sessions-archive/, and without this the next sync's removed-path sweep
 * would see the old path gone and permanently delete the session's embedded
 * memory — violating archive-never-delete in substance. Returns true when a
 * files row existed (false = the session was never indexed; nothing to do).
 */
export function repointFile(
  db: InstanceType<typeof Database>,
  oldPath: string,
  newPath: string
): boolean {
  const doRepoint = db.transaction((): boolean => {
    const r = db.prepare("UPDATE files SET path = ? WHERE path = ?").run(newPath, oldPath);
    if (r.changes === 0) return false;
    db.prepare("UPDATE chunks SET path = ? WHERE path = ?").run(newPath, oldPath);
    return true;
  });
  return doRepoint();
}

async function indexFile(
  db: InstanceType<typeof Database>,
  embeddingProvider: EmbeddingProvider | null,
  config: MemoryConfig,
  hasFts: boolean,
  hasVec: boolean,
  file: FileRecord
): Promise<void> {
  // Clock preservation. This lane drops and reinserts EVERY chunk of a
  // changed file, so without this snapshot any file touch (consolidation's
  // nightly appendFileSync on entity pages, most commonly) would re-stamp
  // 90-day-old facts with updated_at = now — and updated_at is the staleness
  // clock the recall formatter renders as relative age. Snapshot the prior
  // chunks before the wipe; on reinsert a chunk keeps its original clock when
  //   (a) its content_hash matches a prior chunk exactly (unchanged content), or
  //   (b) its text CONTAINS a prior chunk's text — the append case. A small
  //       entity page is a single chunk (well under chunkTokens), so a nightly
  //       append merges old+new into one chunk with a NEW hash; without the
  //       containment rule the 90-day-old fact inside would read "just now".
  // Ties/multiple matches keep the OLDEST clock — never freshen by accident;
  // a mixed old+new chunk is aged by its oldest content so the stale caveat
  // stays honest. Genuinely new or edited content gets Date.now().
  const priorChunks: Array<{ hash: string | null; text: string; updated_at: number }> = [];
  try {
    const rows = db
      .prepare("SELECT content_hash, text, updated_at FROM chunks WHERE path = ?")
      .all(file.path) as Array<{ content_hash: string | null; text: string | null; updated_at: number }>;
    for (const r of rows) {
      priorChunks.push({ hash: r.content_hash, text: (r.text ?? "").trim(), updated_at: r.updated_at });
    }
  } catch {}
  const preservedClock = (newHash: string, newText: string): number | undefined => {
    let clock: number | undefined;
    for (const p of priorChunks) {
      const match = p.hash === newHash || (p.text.length > 0 && newText.includes(p.text));
      if (match && (clock === undefined || p.updated_at < clock)) clock = p.updated_at;
    }
    return clock;
  };

  removeFile(db, hasFts, hasVec, file.path);

  let chunks: Chunk[];

  if (file.source === "session") {
    const messages = extractSessionPairs(file.path);
    if (messages.length < 2) return;
    // Strip whichever extension is on the file path (.jsonl post migration,
    // .json on legacy callers) to recover the bare session id.
    const sessionId = basename(file.path, file.path.endsWith(".jsonl") ? ".jsonl" : ".json");
    let sessionDate: string | undefined;
    try {
      if (file.path.endsWith(".jsonl")) {
        for (const line of readFileSync(file.path, "utf-8").split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const row = JSON.parse(trimmed);
          if (row.kind === "meta" && typeof row.createdAt === "number") {
            sessionDate = new Date(row.createdAt).toISOString().split("T")[0];
            break;
          }
        }
      } else {
        const sess = JSON.parse(readFileSync(file.path, "utf-8"));
        if (sess.createdAt) sessionDate = new Date(sess.createdAt).toISOString().split("T")[0];
      }
    } catch {}
    const metadata: ChunkMetadata = withChunkProvenance("session", {
      source_type: "agent-x-session", session_id: sessionId, date: sessionDate,
    });
    chunks = chunkConversationPairs(messages, file.path, file.source, metadata) as Chunk[];
  } else {
    const raw = safeReadTextFile(file.path);
    if (!raw) return;
    if (!raw.trim()) return;
    const maxChunkChars = config.chunkTokens * config.charsPerToken;
    const overlapChars = config.chunkOverlap * config.charsPerToken;
    const metadata: ChunkMetadata = withChunkProvenance(file.source as CanonicalSource, {
      source_type: file.source === "entity" ? "entity-page" : "memory-file",
      date: extractDateFromPath(file.path),
    });
    chunks = chunkText(raw, file.path, file.source, maxChunkChars, overlapChars) as Chunk[];
    for (const c of chunks) c.metadata = metadata;
  }

  if (chunks.length === 0) return;

  if (embeddingProvider) {
    await embedChunksWithRetry(db, embeddingProvider, config, chunks);
  }

  const insertChunk = db.prepare(`
    INSERT INTO chunks (path, source, start_line, end_line, text, hash, content_hash, embedding, updated_at, metadata, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFts = hasFts
    ? db.prepare(
        `INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)`
      )
    : null;

  const now = Date.now();

  const insertMany = db.transaction(() => {
    for (const chunk of chunks) {
      const result = insertChunk.run(
        chunk.path,
        chunk.source,
        chunk.startLine,
        chunk.endLine,
        chunk.text,
        chunk.hash,
        chunk.hash,
        chunk.embedding ? encodeEmbedding(chunk.embedding) : null,
        preservedClock(chunk.hash, chunk.text) ?? now,
        chunk.metadata ? JSON.stringify(chunk.metadata) : null,
        chunk.metadata?.session_id ?? null
      );

      const chunkId = result.lastInsertRowid;

      if (insertFts) {
        insertFts.run(chunkId, chunk.text);
      }

      if (hasVec && chunk.embedding) {
        try {
          db
            .prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)")
            .run(chunkId, new Float32Array(chunk.embedding));
        } catch {
        }
      }
    }

    db
      .prepare(
        "INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)"
      )
      .run(file.path, file.source, file.hash, file.mtime, file.size);
  });

  insertMany();
}

export interface SyncDeps {
  db: InstanceType<typeof Database>;
  embeddingProvider: EmbeddingProvider | null;
  config: MemoryConfig;
  hasFts: boolean;
  hasVec: boolean;
  memoryDir: string;
  dataDir: string;
  sessionDeltas: Map<string, { lastSize: number; lastMessageCount: number }>;
  dirtyRef: { value: boolean };
  syncInProgressRef: { value: boolean };
}

export async function syncIndex(deps: SyncDeps): Promise<void> {
  if (!deps.dirtyRef.value) return;
  if (deps.syncInProgressRef.value) return;
  deps.syncInProgressRef.value = true;
  deps.dirtyRef.value = false;

  try {
    const memoryFiles = listMemoryFiles(deps.memoryDir);
    const sessionFiles = listSessionFiles(deps.dataDir);
    const allFiles = [...memoryFiles, ...sessionFiles];

    for (const file of allFiles) {
      const existing = deps.db
        .prepare("SELECT hash FROM files WHERE path = ?")
        .get(file.path) as { hash: string } | undefined;

      if (existing && existing.hash === file.hash) continue;

      if (file.source === "session" && existing) {
        const delta = deps.sessionDeltas.get(file.path);
        if (delta) {
          const sizeDiff = file.size - delta.lastSize;
          const msgCount = countSessionMessages(file.path);

          if (
            sizeDiff > 0 &&
            sizeDiff < deps.config.sessionDeltaBytes &&
            msgCount >= delta.lastMessageCount
          ) {
            deps.db
              .prepare("UPDATE files SET hash = ?, mtime = ?, size = ? WHERE path = ?")
              .run(file.hash, file.mtime, file.size, file.path);
            deps.sessionDeltas.set(file.path, {
              lastSize: file.size,
              lastMessageCount: msgCount,
            });
            continue;
          }
        }
      }

      await indexFile(deps.db, deps.embeddingProvider, deps.config, deps.hasFts, deps.hasVec, file);

      if (file.source === "session") {
        deps.sessionDeltas.set(file.path, {
          lastSize: file.size,
          lastMessageCount: countSessionMessages(file.path),
        });
      }
    }

    const allPaths = new Set(allFiles.map((f) => f.path));
    // Archived session transcripts are frozen cold storage: never rescanned
    // (listSessionFiles only walks sessions/), so without this exemption the
    // sweep below would delete their repointed chunks on the first sync after
    // archival — permanently, since nothing re-indexes the archive.
    const archivePrefix = join(deps.dataDir, "sessions-archive") + sep;
    const dbFiles = deps.db.prepare("SELECT path FROM files").all() as { path: string }[];
    for (const { path } of dbFiles) {
      if (
        !allPaths.has(path) &&
        !path.startsWith("import/") &&
        !path.startsWith("session-live/") &&
        !path.startsWith(archivePrefix)
      ) {
        removeFile(deps.db, deps.hasFts, deps.hasVec, path);
      }
    }

    pruneEmbeddingCache(deps.db, deps.config);

    archiveOldFacts(deps.db, deps.config, deps.hasFts);
  } catch (e) {
    logger.error("[memory] Sync failed:", (e as Error).message);
    deps.dirtyRef.value = true;
  } finally {
    deps.syncInProgressRef.value = false;
  }
}
