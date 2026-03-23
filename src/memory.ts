/**
 * Secret Agent X — Memory System
 *
 * Level 1: Session persistence (JSON on disk)
 * Level 2: Full-text search (SQLite FTS5)
 * Level 3: Knowledge memory (MEMORY.md + daily logs)
 * Level 4: Vector embeddings (sqlite-vec)
 * Level 5: Hybrid search (BM25 + vector + RRF)
 * Level 6: Temporal decay + MMR diversity
 * Level 7: Auto-indexing with chunking + embedding cache
 * Level 8: Agent tools (memory_search, memory_get)
 * Level 9: Session transcript indexing
 * Level 10: Memory flush before compaction
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  watch,
} from "node:fs";
import { join, basename, relative } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Session } from "./types.js";

// ── Constants (matching OpenClaw's proven defaults) ──

const CHUNK_TOKENS = 400;
const CHUNK_OVERLAP = 80;
const CHARS_PER_TOKEN = 4;
const MAX_CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = CHUNK_OVERLAP * CHARS_PER_TOKEN;

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.35;
const CANDIDATE_MULTIPLIER = 4;
const SNIPPET_MAX_CHARS = 700;

const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;

const MMR_LAMBDA = 0.7;
const TEMPORAL_HALF_LIFE_DAYS = 30;

// ── Types ──

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
}

interface Chunk {
  id?: number;
  path: string;
  source: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embedding?: number[];
}

interface FileRecord {
  path: string;
  source: string;
  hash: string;
  mtime: number;
  size: number;
}

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

// ── Level 1: Session Persistence ──

export class SessionStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "sessions");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  save(session: Session): void {
    const filePath = join(this.dir, `${session.id}.json`);
    writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
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
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const sessions: Array<{ id: string; title: string; updatedAt: number; messageCount: number }> =
      [];

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(this.dir, file), "utf-8")) as Session;
        sessions.push({
          id: data.id,
          title: data.title,
          updatedAt: data.updatedAt,
          messageCount: data.messages.length,
        });
      } catch {
        // skip corrupted files
      }
    }

    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    const filePath = join(this.dir, `${id}.json`);
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(filePath);
    } catch {
      // already gone
    }
  }
}

// ── Level 2 & 3: SQLite-backed Memory Index ──

export class MemoryIndex {
  private db: InstanceType<typeof Database>;
  private dataDir: string;
  private memoryDir: string;
  private embeddingProvider: EmbeddingProvider | null = null;
  private dirty = true;
  private hasFts = false;
  private hasVec = false;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.memoryDir = join(dataDir, "memory");
    if (!existsSync(this.memoryDir)) mkdirSync(this.memoryDir, { recursive: true });

    const dbPath = join(dataDir, "memory.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.initSchema();
    this.startWatcher();
  }

  private initSchema(): void {
    // Core tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        source TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

      CREATE TABLE IF NOT EXISTS embedding_cache (
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (hash, model)
      );
    `);

    // Try FTS5
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text, id, path, source, start_line, end_line,
          content=chunks,
          content_rowid=id
        );
      `);
      this.hasFts = true;
    } catch {
      console.log("[memory] FTS5 not available — keyword search disabled");
    }

    // sqlite-vec loaded later when embedding provider is set
  }

  // ── Level 3: Knowledge Memory Files ──

  getMemoryFilePath(): string {
    return join(this.memoryDir, "MEMORY.md");
  }

  getDailyLogPath(date?: Date): string {
    const d = date || new Date();
    const dateStr = d.toISOString().split("T")[0];
    return join(this.memoryDir, `${dateStr}.md`);
  }

  appendDailyLog(text: string): void {
    const logPath = this.getDailyLogPath();
    const existing = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    const timestamp = new Date().toLocaleTimeString();
    writeFileSync(logPath, existing + `\n[${timestamp}] ${text}\n`, "utf-8");
    this.dirty = true;
  }

  readMemoryFile(): string {
    const p = this.getMemoryFilePath();
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  writeMemoryFile(content: string): void {
    writeFileSync(this.getMemoryFilePath(), content, "utf-8");
    this.dirty = true;
  }

  // ── Level 4: Embedding Provider ──

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    this.initVectorTable(provider.dimensions);
  }

  private initVectorTable(dims: number): void {
    try {
      // Load sqlite-vec extension if available
      // this.db.loadExtension('vec0');
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding FLOAT[${dims}]
        );
      `);
      this.hasVec = true;
    } catch {
      console.log("[memory] sqlite-vec not available — vector search will use in-memory cosine");
    }
  }

  // ── Level 7: Auto-indexing with Chunking ──

  async sync(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    const memoryFiles = this.listMemoryFiles();
    const sessionFiles = this.listSessionFiles();
    const allFiles = [...memoryFiles, ...sessionFiles];

    for (const file of allFiles) {
      const existing = this.db
        .prepare("SELECT hash FROM files WHERE path = ?")
        .get(file.path) as { hash: string } | undefined;

      if (existing && existing.hash === file.hash) continue;

      // File changed — re-chunk and re-index
      await this.indexFile(file);
    }

    // Remove chunks for deleted files
    const allPaths = new Set(allFiles.map((f) => f.path));
    const dbFiles = this.db.prepare("SELECT path FROM files").all() as { path: string }[];
    for (const { path } of dbFiles) {
      if (!allPaths.has(path)) {
        this.removeFile(path);
      }
    }
  }

  private listMemoryFiles(): FileRecord[] {
    if (!existsSync(this.memoryDir)) return [];
    const records: FileRecord[] = [];

    const files = readdirSync(this.memoryDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const fullPath = join(this.memoryDir, file);
      const stat = statSync(fullPath);
      const content = readFileSync(fullPath, "utf-8");
      records.push({
        path: fullPath,
        source: "memory",
        hash: sha256(content),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    }

    return records;
  }

  private listSessionFiles(): FileRecord[] {
    const sessDir = join(this.dataDir, "sessions");
    if (!existsSync(sessDir)) return [];
    const records: FileRecord[] = [];

    const files = readdirSync(sessDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const fullPath = join(sessDir, file);
      const stat = statSync(fullPath);
      const content = readFileSync(fullPath, "utf-8");
      records.push({
        path: fullPath,
        source: "sessions",
        hash: sha256(content),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    }

    return records;
  }

  private async indexFile(file: FileRecord): Promise<void> {
    // Remove old chunks
    this.removeFile(file.path);

    // Read content
    let content: string;
    if (file.source === "sessions") {
      content = this.flattenSession(file.path);
    } else {
      content = readFileSync(file.path, "utf-8");
    }

    if (!content.trim()) return;

    // Chunk the content
    const chunks = chunkText(content, file.path, file.source);

    // Embed if provider available
    if (this.embeddingProvider) {
      const textsToEmbed: string[] = [];
      const cachedEmbeddings = new Map<number, number[]>();

      for (let i = 0; i < chunks.length; i++) {
        const cached = this.getCachedEmbedding(chunks[i].hash);
        if (cached) {
          cachedEmbeddings.set(i, cached);
        } else {
          textsToEmbed.push(chunks[i].text);
        }
      }

      // Batch embed uncached chunks
      let newEmbeddings: number[][] = [];
      if (textsToEmbed.length > 0) {
        try {
          newEmbeddings = await this.embeddingProvider.embedBatch(textsToEmbed);
        } catch (e) {
          console.warn("[memory] Embedding failed:", (e as Error).message);
        }
      }

      // Merge cached + new
      let newIdx = 0;
      for (let i = 0; i < chunks.length; i++) {
        if (cachedEmbeddings.has(i)) {
          chunks[i].embedding = cachedEmbeddings.get(i);
        } else if (newIdx < newEmbeddings.length) {
          chunks[i].embedding = newEmbeddings[newIdx];
          this.cacheEmbedding(chunks[i].hash, chunks[i].embedding!);
          newIdx++;
        }
      }
    }

    // Insert chunks
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (path, source, start_line, end_line, text, hash, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = this.hasFts
      ? this.db.prepare(`
          INSERT INTO chunks_fts (rowid, text, id, path, source, start_line, end_line)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
      : null;

    const now = Date.now();

    const insertMany = this.db.transaction(() => {
      for (const chunk of chunks) {
        const result = insertChunk.run(
          chunk.path,
          chunk.source,
          chunk.startLine,
          chunk.endLine,
          chunk.text,
          chunk.hash,
          chunk.embedding ? JSON.stringify(chunk.embedding) : null,
          now
        );

        const chunkId = result.lastInsertRowid;

        if (insertFts) {
          insertFts.run(chunkId, chunk.text, chunkId, chunk.path, chunk.source, chunk.startLine, chunk.endLine);
        }

        // Insert vector if available
        if (this.hasVec && chunk.embedding) {
          try {
            this.db
              .prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)")
              .run(chunkId, new Float32Array(chunk.embedding));
          } catch {
            // vec insert failed
          }
        }
      }

      // Update file record
      this.db
        .prepare(
          "INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)"
        )
        .run(file.path, file.source, file.hash, file.mtime, file.size);
    });

    insertMany();
  }

  private removeFile(path: string): void {
    const chunks = this.db.prepare("SELECT id FROM chunks WHERE path = ?").all(path) as {
      id: number;
    }[];

    if (chunks.length > 0) {
      const ids = chunks.map((c) => c.id);
      this.db.prepare(`DELETE FROM chunks WHERE path = ?`).run(path);

      if (this.hasFts) {
        for (const id of ids) {
          try {
            this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(id);
          } catch {}
        }
      }

      if (this.hasVec) {
        for (const id of ids) {
          try {
            this.db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?").run(id);
          } catch {}
        }
      }
    }

    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  private flattenSession(path: string): string {
    try {
      const session = JSON.parse(readFileSync(path, "utf-8")) as Session;
      const lines: string[] = [`Session: ${session.title}`, `Date: ${new Date(session.createdAt).toISOString()}`, ""];

      for (const msg of session.messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          const content = typeof msg.content === "string" ? msg.content : "";
          if (content) {
            lines.push(`[${msg.role}] ${content}`);
            lines.push("");
          }
        }
      }

      return lines.join("\n");
    } catch {
      return "";
    }
  }

  // ── Embedding Cache ──

  private getCachedEmbedding(hash: string): number[] | null {
    const model = this.embeddingProvider ? "default" : "";
    const row = this.db
      .prepare("SELECT embedding FROM embedding_cache WHERE hash = ? AND model = ?")
      .get(hash, model) as { embedding: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.embedding);
    } catch {
      return null;
    }
  }

  private cacheEmbedding(hash: string, embedding: number[]): void {
    const model = this.embeddingProvider ? "default" : "";
    this.db
      .prepare(
        "INSERT OR REPLACE INTO embedding_cache (hash, model, embedding, updated_at) VALUES (?, ?, ?, ?)"
      )
      .run(hash, model, JSON.stringify(embedding), Date.now());
  }

  // ── File Watcher ──

  private startWatcher(): void {
    try {
      this.watcher = watch(this.memoryDir, { recursive: true }, () => {
        this.dirty = true;
      });
    } catch {
      // watcher not available
    }
  }

  // ── Level 5: Hybrid Search ──

  async search(
    query: string,
    options?: { maxResults?: number; minScore?: number; sources?: string[] }
  ): Promise<MemorySearchResult[]> {
    // Auto-sync before search
    await this.sync();

    const maxResults = options?.maxResults || DEFAULT_MAX_RESULTS;
    const minScore = options?.minScore || DEFAULT_MIN_SCORE;
    const candidateLimit = Math.min(200, Math.max(1, maxResults * CANDIDATE_MULTIPLIER));

    let keywordResults: Array<Chunk & { score: number }> = [];
    let vectorResults: Array<Chunk & { score: number }> = [];

    // Keyword search (BM25)
    if (this.hasFts) {
      keywordResults = this.searchKeyword(query, candidateLimit, options?.sources);
    }

    // Vector search
    if (this.embeddingProvider) {
      try {
        const queryVec = await this.embeddingProvider.embed(query);
        vectorResults = this.searchVector(queryVec, candidateLimit, options?.sources);
      } catch (e) {
        console.warn("[memory] Vector search failed:", (e as Error).message);
      }
    }

    // Merge results
    let merged: MemorySearchResult[];
    if (keywordResults.length > 0 && vectorResults.length > 0) {
      merged = mergeHybridResults(keywordResults, vectorResults);
    } else if (vectorResults.length > 0) {
      merged = vectorResults.map(toSearchResult);
    } else {
      merged = keywordResults.map(toSearchResult);
    }

    // Apply temporal decay
    merged = applyTemporalDecay(merged);

    // Apply MMR diversity re-ranking
    merged = mmrRerank(merged, maxResults);

    // Filter by min score and limit
    return merged.filter((r) => r.score >= minScore).slice(0, maxResults);
  }

  private searchKeyword(
    query: string,
    limit: number,
    sources?: string[]
  ): Array<Chunk & { score: number }> {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT id, path, source, start_line, end_line, text, bm25(chunks_fts) as rank
           FROM chunks_fts
           WHERE chunks_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, limit) as Array<{
        id: number;
        path: string;
        source: string;
        start_line: number;
        end_line: number;
        text: string;
        rank: number;
      }>;

      return rows
        .filter((r) => !sources || sources.includes(r.source))
        .map((r) => ({
          id: r.id,
          path: r.path,
          source: r.source,
          startLine: r.start_line,
          endLine: r.end_line,
          text: r.text,
          hash: "",
          score: bm25RankToScore(r.rank),
        }));
    } catch {
      return [];
    }
  }

  private searchVector(
    queryVec: number[],
    limit: number,
    sources?: string[]
  ): Array<Chunk & { score: number }> {
    // In-memory cosine fallback (works without sqlite-vec)
    const allChunks = this.db
      .prepare("SELECT id, path, source, start_line, end_line, text, embedding FROM chunks WHERE embedding IS NOT NULL")
      .all() as Array<{
      id: number;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: string;
    }>;

    const results: Array<Chunk & { score: number }> = [];

    for (const row of allChunks) {
      if (sources && !sources.includes(row.source)) continue;

      let embedding: number[];
      try {
        embedding = JSON.parse(row.embedding);
      } catch {
        continue;
      }

      const similarity = cosineSimilarity(queryVec, embedding);
      if (!Number.isFinite(similarity)) continue;

      results.push({
        id: row.id,
        path: row.path,
        source: row.source,
        startLine: row.start_line,
        endLine: row.end_line,
        text: row.text,
        hash: "",
        score: similarity,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ── Utility ──

  getStats(): { totalChunks: number; totalFiles: number; hasFts: boolean; hasVec: boolean } {
    const chunks = this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
      count: number;
    };
    const files = this.db.prepare("SELECT COUNT(*) as count FROM files").get() as {
      count: number;
    };
    return {
      totalChunks: chunks.count,
      totalFiles: files.count,
      hasFts: this.hasFts,
      hasVec: this.hasVec,
    };
  }

  markDirty(): void {
    this.dirty = true;
  }

  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.db.close();
  }
}

// ── Chunking ──

function chunkText(content: string, path: string, source: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let currentText = "";
  let currentStart = 1;
  let currentChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentText += (currentText ? "\n" : "") + line;
    currentChars += line.length + 1;

    if (currentChars >= MAX_CHUNK_CHARS || i === lines.length - 1) {
      if (currentText.trim()) {
        chunks.push({
          path,
          source,
          startLine: currentStart,
          endLine: i + 1,
          text: currentText,
          hash: sha256(currentText),
        });
      }

      // Overlap: keep the last OVERLAP_CHARS
      if (i < lines.length - 1) {
        const overlapText = currentText.slice(-OVERLAP_CHARS);
        const overlapLines = overlapText.split("\n").length;
        currentStart = i + 2 - overlapLines;
        currentText = overlapText;
        currentChars = overlapText.length;
      } else {
        currentText = "";
        currentChars = 0;
        currentStart = i + 2;
      }
    }
  }

  return chunks;
}

// ── FTS Query Builder ──

function buildFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return "";
  return tokens.join(" AND ");
}

// ── Score Normalization ──

function bm25RankToScore(rank: number): number {
  const relevance = -rank;
  return relevance / (1 + relevance);
}

// ── Level 5: Hybrid Merge ──

function mergeHybridResults(
  keywordResults: Array<Chunk & { score: number }>,
  vectorResults: Array<Chunk & { score: number }>
): MemorySearchResult[] {
  const merged = new Map<
    string,
    { chunk: Chunk; vectorScore: number; textScore: number }
  >();

  for (const r of vectorResults) {
    const key = `${r.path}:${r.startLine}`;
    merged.set(key, { chunk: r, vectorScore: r.score, textScore: 0 });
  }

  for (const r of keywordResults) {
    const key = `${r.path}:${r.startLine}`;
    const existing = merged.get(key);
    if (existing) {
      existing.textScore = r.score;
    } else {
      merged.set(key, { chunk: r, vectorScore: 0, textScore: r.score });
    }
  }

  const results: MemorySearchResult[] = [];
  for (const [, entry] of merged) {
    const score = VECTOR_WEIGHT * entry.vectorScore + TEXT_WEIGHT * entry.textScore;
    results.push(toSearchResult({ ...entry.chunk, score }));
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Level 6: Temporal Decay ──

function applyTemporalDecay(results: MemorySearchResult[]): MemorySearchResult[] {
  const now = Date.now();
  const lambda = Math.LN2 / TEMPORAL_HALF_LIFE_DAYS;

  return results.map((r) => {
    // Extract date from path: memory/YYYY-MM-DD.md
    const dateMatch = basename(r.path).match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return r; // Evergreen file — no decay

    const fileDate = new Date(dateMatch[1]).getTime();
    const ageDays = (now - fileDate) / (1000 * 60 * 60 * 24);
    const multiplier = Math.exp(-lambda * ageDays);

    return { ...r, score: r.score * multiplier };
  });
}

// ── Level 6: MMR Diversity Re-ranking ──

function mmrRerank(results: MemorySearchResult[], limit: number): MemorySearchResult[] {
  if (results.length <= 1) return results;

  // Tokenize all results
  const tokenSets = results.map((r) => tokenize(r.snippet));

  const selected: number[] = [];
  const remaining = new Set(results.map((_, i) => i));

  while (selected.length < limit && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const idx of remaining) {
      const relevance = results[idx].score;

      // Max similarity to any already-selected item
      let maxSim = 0;
      for (const selIdx of selected) {
        const sim = jaccardSimilarity(tokenSets[idx], tokenSets[selIdx]);
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(bestIdx);
      remaining.delete(bestIdx);
    } else {
      break;
    }
  }

  return selected.map((i) => results[i]);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Math Utils ──

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function toSearchResult(chunk: Chunk & { score: number }): MemorySearchResult {
  return {
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    score: chunk.score,
    snippet: chunk.text.slice(0, SNIPPET_MAX_CHARS),
    source: chunk.source as "memory" | "sessions",
  };
}

// ── Level 8: Memory Tools for Agent ──

export function createMemoryTools(memory: MemoryIndex) {
  return [
    {
      name: "memory_search",
      description:
        "Search long-term memory for relevant information from past conversations, notes, and knowledge files. Use this when the user references something from a previous session or when you need context about past decisions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Max results (default 6)" },
        },
        required: ["query"],
      },
      async execute(args: Record<string, unknown>) {
        const query = String(args.query || "");
        const maxResults = (args.max_results as number) || 6;

        const results = await memory.search(query, { maxResults });

        if (results.length === 0) {
          return { content: "No relevant memories found." };
        }

        const formatted = results
          .map(
            (r, i) =>
              `[${i + 1}] (score: ${r.score.toFixed(2)}, ${r.source}) ${r.path}:${r.startLine}-${r.endLine}\n${r.snippet}`
          )
          .join("\n\n");

        return { content: formatted };
      },
    },
    {
      name: "memory_get",
      description:
        "Read a specific memory file by path. Use to retrieve the full content of MEMORY.md or a specific daily log.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path within the memory directory (e.g. MEMORY.md or 2026-03-22.md)" },
        },
        required: ["path"],
      },
      async execute(args: Record<string, unknown>) {
        const requestedPath = String(args.path || "");
        const fullPath = join(memory["memoryDir"], requestedPath);

        if (!existsSync(fullPath)) {
          return { content: `Memory file not found: ${requestedPath}` };
        }

        try {
          const content = readFileSync(fullPath, "utf-8");
          return { content: content || "(empty file)" };
        } catch (e) {
          return {
            content: `Error reading memory file: ${(e as Error).message}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "memory_save",
      description:
        "Save important information to long-term memory. Use this to remember user preferences, decisions, project context, or anything that should persist across conversations. Saves to the daily log by default, or to MEMORY.md for curated long-term facts.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information to remember" },
          target: {
            type: "string",
            description: "'daily' for daily log (default), 'memory' for MEMORY.md",
          },
        },
        required: ["content"],
      },
      async execute(args: Record<string, unknown>) {
        const content = String(args.content || "");
        const target = String(args.target || "daily");

        if (!content.trim()) {
          return { content: "Nothing to save.", isError: true };
        }

        if (target === "memory") {
          const existing = memory.readMemoryFile();
          memory.writeMemoryFile(existing + (existing ? "\n\n" : "") + content);
          return { content: "Saved to MEMORY.md" };
        } else {
          memory.appendDailyLog(content);
          return { content: `Saved to daily log (${new Date().toISOString().split("T")[0]})` };
        }
      },
    },
  ];
}
