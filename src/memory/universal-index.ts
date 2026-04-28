/**
 * Universal Memory Indexing
 *
 * Write-through indexer + backfill orchestrator for every text store the
 * memory system touches. Replaces the lazy "wait for sync()" path so that
 * every entity page, daily log, MIND.md update, session summary and raw
 * session transcript becomes searchable the moment it lands on disk.
 *
 * Idempotent via content_hash dedup (see MemoryIndex.indexChunksIdempotent).
 * Repeated backfill passes only embed genuinely new chunks.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import type { MemoryIndex } from "../memory.js";
import type { CanonicalSource, ChunkMetadata, Chunk } from "./types.js";
import { chunkText, chunkConversationPairs, extractSessionPairs } from "../memory-chunking.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.universal-index");

const SECTION_CHUNK_CHARS = 3200;
const SECTION_OVERLAP_CHARS = 0;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeRead(path: string): string | null {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

function slugifyEntity(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface IndexResult {
  added: number;
  removed: number;
  unchanged: number;
}

export interface BackfillReport {
  bySource: Partial<Record<CanonicalSource, { filesScanned: number; chunksAdded: number; chunksUnchanged: number }>>;
  totalFilesScanned: number;
  totalChunksAdded: number;
  totalChunksUnchanged: number;
  durationMs: number;
}

// ── Heading-aware section chunker ────────────────────────────────────────
//
// Markdown files in the memory dir have meaningful sections (## Facts,
// ## Opinions, ## Consolidated YYYY-MM-DD). Splitting at heading boundaries
// keeps each chunk semantically self-contained — search hits land on a
// coherent slice of context, not mid-paragraph.
//
// Falls back to simple char-cap chunking when sections are too long.

function chunkBySections(
  content: string,
  path: string,
  source: string,
  metadata: ChunkMetadata,
  maxChunkChars = SECTION_CHUNK_CHARS,
): Chunk[] {
  const lines = content.split("\n");
  const sections: { startLine: number; endLine: number; text: string }[] = [];
  let buf: string[] = [];
  let bufStart = 1;

  const flush = (endLine: number) => {
    if (buf.length === 0) return;
    const text = buf.join("\n").trim();
    if (text.length > 0) sections.push({ startLine: bufStart, endLine, text });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^#{1,6}\s/.test(line);
    if (isHeading && buf.length > 0) {
      flush(i);
      bufStart = i + 1;
    }
    if (buf.length === 0) bufStart = i + 1;
    buf.push(line);
  }
  flush(lines.length);

  // Split oversize sections at the char cap
  const chunks: Chunk[] = [];
  for (const sec of sections) {
    if (sec.text.length <= maxChunkChars) {
      chunks.push({
        path, source, startLine: sec.startLine, endLine: sec.endLine,
        text: sec.text, hash: sha256(sec.text), metadata,
      });
    } else {
      const subs = chunkText(sec.text, path, source, maxChunkChars, SECTION_OVERLAP_CHARS, metadata);
      for (const s of subs) {
        chunks.push({
          path, source,
          startLine: sec.startLine + (s.startLine - 1),
          endLine: sec.startLine + (s.endLine - 1),
          text: s.text, hash: s.hash, metadata,
        });
      }
    }
  }

  return chunks;
}

// ── UniversalIndex ───────────────────────────────────────────────────────

export class UniversalIndex {
  private memoryDir: string;
  private sessionsDir: string;
  private summariesDir: string;
  private entitiesDir: string;

  constructor(private memory: MemoryIndex) {
    this.memoryDir = memory.getMemoryDir();
    this.sessionsDir = join(memory.getDataDir(), "sessions");
    this.summariesDir = join(this.memoryDir, "session-summaries");
    this.entitiesDir = join(this.memoryDir, "bank", "entities");
  }

  // ── Per-store indexers ─────────────────────────────────────────────────

  async indexEntityPage(slug: string): Promise<IndexResult> {
    const path = join(this.entitiesDir, `${slug}.md`);
    const raw = safeRead(path);
    if (!raw || !raw.trim()) return { added: 0, removed: 0, unchanged: 0 };
    const metadata: ChunkMetadata = { source_type: "entity-page" };
    const chunks = chunkBySections(raw, path, "entity", metadata);
    return this.memory.indexChunksIdempotent(chunks, path, "entity");
  }

  async indexDailyLog(date?: Date): Promise<IndexResult> {
    const d = date || new Date();
    const dateStr = d.toISOString().split("T")[0];
    const path = join(this.memoryDir, `${dateStr}.md`);
    const raw = safeRead(path);
    if (!raw || !raw.trim()) return { added: 0, removed: 0, unchanged: 0 };
    const metadata: ChunkMetadata = { source_type: "memory-file", date: dateStr };
    const chunks = chunkBySections(raw, path, "daily-log", metadata);
    return this.memory.indexChunksIdempotent(chunks, path, "daily-log");
  }

  async indexMindFile(): Promise<IndexResult> {
    const path = join(this.memoryDir, "MIND.md");
    const raw = safeRead(path);
    if (!raw || !raw.trim()) return { added: 0, removed: 0, unchanged: 0 };
    const metadata: ChunkMetadata = { source_type: "memory-file" };
    const chunks = chunkBySections(raw, path, "mind", metadata);
    return this.memory.indexChunksIdempotent(chunks, path, "mind");
  }

  async indexSessionSummary(sessionId: string): Promise<IndexResult> {
    const path = join(this.summariesDir, `${sessionId}.md`);
    const raw = safeRead(path);
    if (!raw || !raw.trim()) return { added: 0, removed: 0, unchanged: 0 };
    const metadata: ChunkMetadata = { source_type: "memory-file", session_id: sessionId };
    const chunks = chunkBySections(raw, path, "session-summary", metadata);
    return this.memory.indexChunksIdempotent(chunks, path, "session-summary");
  }

  async indexSessionTranscript(sessionId: string): Promise<IndexResult> {
    const path = join(this.sessionsDir, `${sessionId}.json`);
    if (!existsSync(path)) return { added: 0, removed: 0, unchanged: 0 };
    const messages = extractSessionPairs(path);
    if (messages.length < 2) return { added: 0, removed: 0, unchanged: 0 };

    let sessionDate: string | undefined;
    try {
      const sess = JSON.parse(readFileSync(path, "utf-8"));
      if (sess.createdAt) sessionDate = new Date(sess.createdAt).toISOString().split("T")[0];
    } catch {}

    const metadata: ChunkMetadata = {
      source_type: "agent-x-session",
      session_id: sessionId,
      date: sessionDate,
    };
    const chunks = chunkConversationPairs(messages, path, "session", metadata) as Chunk[];
    return this.memory.indexChunksIdempotent(chunks, path, "session");
  }

  async indexPersonalityFile(filename: string): Promise<IndexResult> {
    const path = join(this.memoryDir, filename);
    const raw = safeRead(path);
    if (!raw || !raw.trim()) return { added: 0, removed: 0, unchanged: 0 };
    const metadata: ChunkMetadata = { source_type: "memory-file" };
    const chunks = chunkBySections(raw, path, "personality", metadata);
    return this.memory.indexChunksIdempotent(chunks, path, "personality");
  }

  // ── Backfill ───────────────────────────────────────────────────────────

  async backfillAll(opts?: { force?: boolean }): Promise<BackfillReport> {
    const t0 = Date.now();
    const report: BackfillReport = {
      bySource: {},
      totalFilesScanned: 0,
      totalChunksAdded: 0,
      totalChunksUnchanged: 0,
      durationMs: 0,
    };

    const accum = (src: CanonicalSource, res: IndexResult) => {
      const slot = report.bySource[src] || { filesScanned: 0, chunksAdded: 0, chunksUnchanged: 0 };
      slot.filesScanned += 1;
      slot.chunksAdded += res.added;
      slot.chunksUnchanged += res.unchanged;
      report.bySource[src] = slot;
      report.totalFilesScanned += 1;
      report.totalChunksAdded += res.added;
      report.totalChunksUnchanged += res.unchanged;
    };

    const force = !!opts?.force;
    if (force) {
      // Force mode: clear path-level idempotency by wiping each file's chunks.
      // The per-file indexers below will then re-insert from scratch.
      // (Cheap on the embedding side because embedding_cache hits by content_hash.)
      try {
        this.memory["db"].exec(`DELETE FROM chunks WHERE source IN ('entity','daily-log','mind','session-summary','session','personality')`);
      } catch (e) { logger.warn("[universal-index] force-clear failed:", (e as Error).message); }
    }

    // Entity pages
    if (existsSync(this.entitiesDir)) {
      const files = readdirSync(this.entitiesDir).filter(f => f.endsWith(".md"));
      for (const f of files) {
        const slug = basename(f, ".md");
        try { accum("entity", await this.indexEntityPage(slug)); }
        catch (e) { logger.warn(`[universal-index] entity ${slug}:`, (e as Error).message); }
      }
    }

    // Memory root files: MIND.md, daily logs, personality files
    if (existsSync(this.memoryDir)) {
      const files = readdirSync(this.memoryDir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith(".md"))
        .map(e => e.name);

      for (const name of files) {
        try {
          if (name === "MIND.md") {
            accum("mind", await this.indexMindFile());
          } else if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
            const dateStr = name.replace(".md", "");
            accum("daily-log", await this.indexDailyLog(new Date(dateStr)));
          } else {
            accum("personality", await this.indexPersonalityFile(name));
          }
        } catch (e) {
          logger.warn(`[universal-index] ${name}:`, (e as Error).message);
        }
      }
    }

    // Session summaries
    if (existsSync(this.summariesDir)) {
      const files = readdirSync(this.summariesDir).filter(f => f.endsWith(".md"));
      for (const f of files) {
        const sessionId = basename(f, ".md");
        try { accum("session-summary", await this.indexSessionSummary(sessionId)); }
        catch (e) { logger.warn(`[universal-index] summary ${sessionId}:`, (e as Error).message); }
      }
    }

    // Raw session transcripts — the retroactive fix for pre-pipeline sessions.
    // Walks ~/.lax/sessions/*.json and reindexes every transcript via the
    // idempotent path. Hash-deduped, so already-indexed sessions cost ~nothing.
    if (existsSync(this.sessionsDir)) {
      const files = readdirSync(this.sessionsDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const sessionId = basename(f, ".json");
        try { accum("session", await this.indexSessionTranscript(sessionId)); }
        catch (e) { logger.warn(`[universal-index] session ${sessionId}:`, (e as Error).message); }
      }
    }

    report.durationMs = Date.now() - t0;
    return report;
  }

  async reindexStore(source: CanonicalSource): Promise<number> {
    let added = 0;
    switch (source) {
      case "entity": {
        if (!existsSync(this.entitiesDir)) return 0;
        for (const f of readdirSync(this.entitiesDir).filter(f => f.endsWith(".md"))) {
          const r = await this.indexEntityPage(basename(f, ".md"));
          added += r.added;
        }
        return added;
      }
      case "daily-log": {
        if (!existsSync(this.memoryDir)) return 0;
        for (const f of readdirSync(this.memoryDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))) {
          const r = await this.indexDailyLog(new Date(f.replace(".md", "")));
          added += r.added;
        }
        return added;
      }
      case "mind":
        return (await this.indexMindFile()).added;
      case "session-summary": {
        if (!existsSync(this.summariesDir)) return 0;
        for (const f of readdirSync(this.summariesDir).filter(f => f.endsWith(".md"))) {
          const r = await this.indexSessionSummary(basename(f, ".md"));
          added += r.added;
        }
        return added;
      }
      case "session": {
        if (!existsSync(this.sessionsDir)) return 0;
        for (const f of readdirSync(this.sessionsDir).filter(f => f.endsWith(".json"))) {
          const r = await this.indexSessionTranscript(basename(f, ".json"));
          added += r.added;
        }
        return added;
      }
      case "personality": {
        if (!existsSync(this.memoryDir)) return 0;
        for (const f of readdirSync(this.memoryDir).filter(f => f.endsWith(".md") && f !== "MIND.md" && !/^\d{4}-\d{2}-\d{2}\.md$/.test(f))) {
          const r = await this.indexPersonalityFile(f);
          added += r.added;
        }
        return added;
      }
      case "import":
        // Imports are one-shot per conversation ID (gated by isConversationIngested).
        // Re-indexing them would mean re-running the import flow, which is out of
        // scope for this module — see conversation-ingest.ts.
        return 0;
    }
  }
}

// ── Singleton accessor ───────────────────────────────────────────────────
//
// MemoryIndex calls back into this module from its write paths. To keep
// the dependency one-way, we expose a singleton bound to the active
// MemoryIndex instance. attach() is called once during MemoryIndex
// construction; getInstance() is what write paths use.

let _instance: UniversalIndex | null = null;

export function attachUniversalIndex(memory: MemoryIndex): UniversalIndex {
  _instance = new UniversalIndex(memory);
  return _instance;
}

export function getUniversalIndex(): UniversalIndex | null {
  return _instance;
}

// Test helper — used by universal-index.test.ts to bind a freshly-constructed
// MemoryIndex without polluting the module-level singleton between cases.
export function _createUniversalIndexForTest(memory: MemoryIndex): UniversalIndex {
  return new UniversalIndex(memory);
}

// Re-export for test inspection
export { slugifyEntity as _slugifyEntity, chunkBySections as _chunkBySections };
