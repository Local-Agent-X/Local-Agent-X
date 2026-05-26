import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type {
  Chunk, EmbeddingProvider, FactKind, MemoryConfig, MemorySearchResult, RetainedFact,
} from "./types.js";
import { DEFAULT_MEMORY_CONFIG } from "./types.js";
import { openDatabaseSafe } from "./index-db.js";
import * as Schema from "./index-schema.js";
import * as Files from "./index-files.js";
import * as Embedding from "./index-embedding.js";
import * as Sync from "./index-sync.js";
import * as Ingest from "./index-ingest.js";
import * as Forget from "./index-forget.js";
import * as Search from "./index-search.js";
import type { SearchOptions } from "./index-search.js";
import * as Facts from "./index-facts.js";
import * as FactsMutate from "./index-facts-mutate.js";
import * as Relations from "./index-relations.js";
import * as Reflectx from "./index-reflect.js";
import { startWatcher, type WatcherHandle } from "./index-watcher.js";
import { getStats } from "./index-stats.js";

export class MemoryIndex {
  private db: InstanceType<typeof Database>;
  private dataDir: string;
  private memoryDir: string;
  private bankDir: string;
  private entitiesDir: string;
  private config: MemoryConfig;
  private embeddingProvider: EmbeddingProvider | null = null;
  private dirty = true;
  private hasFts = false;
  private hasVec = false;
  private watcherHandle: WatcherHandle = { watcher: null, debounceTimer: null };
  private syncInProgress = false;
  private sessionDeltas = new Map<
    string,
    { lastSize: number; lastMessageCount: number }
  >();

  constructor(dataDir: string, config?: Partial<MemoryConfig>) {
    this.dataDir = dataDir;
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
    this.memoryDir = join(dataDir, "memory");
    this.bankDir = join(dataDir, "memory", "bank");
    this.entitiesDir = join(dataDir, "memory", "bank", "entities");

    for (const dir of [this.memoryDir, this.bankDir, this.entitiesDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    const dbPath = join(dataDir, "memory.db");
    this.db = openDatabaseSafe(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.hasFts = Schema.initSchema(this.db).hasFts;

    startWatcher(this.memoryDir, () => { this.dirty = true; }, this.watcherHandle);

    import("./universal-index.js")
      .then(({ attachUniversalIndex }) => attachUniversalIndex(this))
      .catch(() => { /* universal-index not available — write-through becomes a no-op */ });
  }

  // ── FTS rebuild ──

  rebuildFtsIndex(): void {
    Schema.rebuildFtsIndex(this.db, this.hasFts);
  }

  // ── Knowledge Memory Files ──

  getDailyLogPath(date?: Date): string {
    return Files.getDailyLogPath(this.memoryDir, date);
  }

  /**
   * Append a line to today's daily log. The optional sessionId is recorded
   * inline so today_context injection can filter by current session at read
   * time — preventing cross-session bleed where one chat sees another
   * chat's transcript via the date-keyed log. Pass undefined for system /
   * background entries that aren't tied to a chat.
   *
   * Format: `[sessionId] [HH:MM:SS] text` (sessionId omitted if undefined).
   */
  appendDailyLog(text: string, sessionId?: string): void {
    const logPath = this.getDailyLogPath();
    const timestamp = new Date().toLocaleTimeString();
    const sidTag = sessionId ? `[${sessionId}] ` : "";
    appendFileSync(logPath, `\n${sidTag}[${timestamp}] ${text}\n`, "utf-8");
    this.dirty = true;
    this.reindexThroughUniversal("daily-log").catch(() => {});
  }

  private async reindexThroughUniversal(
    target: "daily-log" | "entity",
    slug?: string,
  ): Promise<void> {
    try {
      const { getUniversalIndex } = await import("./universal-index.js");
      const ui = getUniversalIndex();
      if (!ui) return;
      if (target === "daily-log") await ui.indexDailyLog();
      else if (target === "entity" && slug) await ui.indexEntityPage(slug);
    } catch { /* no-op */ }
  }

  // ── Embedding Provider ──

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    if (Embedding.initVectorTable(this.db, provider.dimensions).hasVec) {
      this.hasVec = true;
    }
  }

  // ── Sync ──

  async sync(): Promise<void> {
    const dirtyRef = { value: this.dirty };
    const syncInProgressRef = { value: this.syncInProgress };
    await Sync.syncIndex({
      db: this.db,
      embeddingProvider: this.embeddingProvider,
      config: this.config,
      hasFts: this.hasFts,
      hasVec: this.hasVec,
      memoryDir: this.memoryDir,
      dataDir: this.dataDir,
      sessionDeltas: this.sessionDeltas,
      dirtyRef,
      syncInProgressRef,
    });
    this.dirty = dirtyRef.value;
    this.syncInProgress = syncInProgressRef.value;
  }

  // ── Public ingest ──

  async indexChunks(chunks: Chunk[], virtualPath: string, source: string): Promise<void> {
    return Ingest.indexChunks(
      this.db, this.embeddingProvider, this.config, this.hasFts, this.hasVec,
      (path) => Sync.removeFile(this.db, this.hasFts, this.hasVec, path),
      chunks, virtualPath, source,
    );
  }

  async indexChunksIdempotent(
    chunks: Chunk[],
    virtualPath: string,
    source: string
  ): Promise<{ added: number; removed: number; unchanged: number }> {
    return Ingest.indexChunksIdempotent(
      this.db, this.embeddingProvider, this.config, this.hasFts, this.hasVec,
      chunks, virtualPath, source,
    );
  }

  // ── Public read-only accessors used by universal-index ──

  getMemoryDir(): string { return this.memoryDir; }
  getDataDir(): string { return this.dataDir; }
  getChunkConfig(): { maxChunkChars: number; overlapChars: number } {
    return {
      maxChunkChars: this.config.chunkTokens * this.config.charsPerToken,
      overlapChars: this.config.chunkOverlap * this.config.charsPerToken,
    };
  }

  isConversationIngested(conversationId: string): boolean {
    return Ingest.isConversationIngested(this.db, conversationId);
  }

  markConversationIngested(conversationId: string, title: string, createTime: number, messageCount: number, sourceFormat: string): void {
    Ingest.markConversationIngested(this.db, conversationId, title, createTime, messageCount, sourceFormat);
  }

  getIngestStats(): { total: number; byFormat: Record<string, number> } {
    return Ingest.getIngestStats(this.db);
  }

  getIngestSummary(): Ingest.IngestSourceSummary[] {
    return Ingest.getIngestSummary(this.db);
  }

  listImportConversationsBySource(source: string): string[] {
    return Ingest.listConversationIdsBySource(this.db, source);
  }

  listImportConversationsSince(sinceMs: number): Array<{ conversation_id: string; source_format: string; ingested_at: number; title: string | null }> {
    return Ingest.listConversationIdsSince(this.db, sinceMs);
  }

  // ── Forget ──

  forgetFacts(pattern: string): number {
    return Forget.forgetFacts(
      this.db, this.hasFts, this.entitiesDir,
      () => { this.dirty = true; },
      (slug) => { this.reindexThroughUniversal("entity", slug).catch(() => {}); },
      pattern,
    );
  }

  findFacts(pattern: string): Array<{ id: number; content: string }> {
    return Forget.findFacts(this.db, pattern);
  }

  forgetChunks(pathPattern: string): number {
    return Forget.forgetChunks(this.db, this.hasFts, this.hasVec, pathPattern);
  }

  forgetConversation(conversationId: string): number {
    return Forget.forgetConversation(this.db, this.hasFts, this.hasVec, conversationId);
  }

  countChunks(pathPattern: string): number {
    return Forget.countChunks(this.db, pathPattern);
  }

  // ── Search ──

  async search(query: string, options?: SearchOptions): Promise<MemorySearchResult[]> {
    return Search.searchInIndex(
      {
        db: this.db,
        embeddingProvider: this.embeddingProvider,
        config: this.config,
        hasFts: this.hasFts,
        sync: () => this.sync(),
      },
      query,
      options,
    );
  }

  // ── RETAIN ──

  retain(text: string, sourceFile: string, sourceLine = 0): RetainedFact[] {
    return Facts.retain(this.db, this.hasFts, text, sourceFile, sourceLine);
  }

  async retainSmart(
    text: string,
    sourceFile: string,
    sourceLine = 0,
    opts?: { candidateLimit?: number; resolverOpts?: { provider?: "ollama" | "anthropic" | "openai" | "auto"; model?: string } }
  ): Promise<{ facts: RetainedFact[]; decisions: Array<{ content: string; op: string; targetId?: number; reason: string }> }> {
    return Facts.retainSmart(this.db, this.hasFts, text, sourceFile, sourceLine, opts);
  }

  retainFromDailyLog(date?: Date): RetainedFact[] {
    return Facts.retainFromDailyLog(this.db, this.hasFts, this.memoryDir, date);
  }

  // ── RECALL ──

  recallByEntity(entitySlug: string, limit = 20, opts?: { includeInvalidated?: boolean }): RetainedFact[] {
    return Facts.recallByEntity(this.db, entitySlug, limit, opts);
  }

  recallByKind(kind: FactKind, limit = 20, opts?: { includeInvalidated?: boolean }): RetainedFact[] {
    return Facts.recallByKind(this.db, kind, limit, opts);
  }

  recallByTime(since: Date, until?: Date, limit = 50, opts?: { includeInvalidated?: boolean }): RetainedFact[] {
    return Facts.recallByTime(this.db, since, until, limit, opts);
  }

  recallOpinions(entitySlug?: string, opts?: { includeInvalidated?: boolean }): RetainedFact[] {
    return Facts.recallOpinions(this.db, entitySlug, opts);
  }

  searchFactsByContent(query: string, limit = 8): RetainedFact[] {
    return Facts.searchFactsByContent(this.db, this.hasFts, query, limit);
  }

  recallAsOf(asOf: Date, opts?: { kind?: FactKind; entitySlug?: string; limit?: number }): RetainedFact[] {
    return Facts.recallAsOf(this.db, asOf, opts);
  }

  // ── Validity ──

  invalidateFact(id: number, opts?: { reason?: string; replacedBy?: number; at?: Date }): boolean {
    return Facts.invalidateFact(this.db, id, opts);
  }

  validityStats(): { valid: number; invalidated: number } {
    return Facts.validityStats(this.db);
  }

  // ── Single-fact agent API (used by remember / update_fact / forget tools) ──

  rememberFact(
    content: string,
    opts?: { kind?: FactKind; confidence?: number; sourceFile?: string }
  ): FactsMutate.OneFactResult {
    return FactsMutate.rememberFact(this.db, this.hasFts, content, opts);
  }

  updateFact(
    query: string,
    newContent: string,
    opts?: { kind?: FactKind; confidence?: number; sourceFile?: string }
  ): FactsMutate.OneFactResult {
    return FactsMutate.updateFact(this.db, this.hasFts, query, newContent, opts);
  }

  forgetFact(query: string): FactsMutate.OneFactResult {
    return FactsMutate.forgetFact(this.db, query);
  }

  recallRecentFacts(opts?: { kinds?: FactKind[]; minConfidence?: number; limit?: number; sinceMs?: number; halfLifeDays?: number }): RetainedFact[] {
    return FactsMutate.recallRecentFacts(this.db, opts);
  }

  reinforceFacts(ids: number[]): number {
    return FactsMutate.reinforceFacts(this.db, ids);
  }

  // ── Relations ──

  storeRelation(opts: {
    subject: string;
    predicate: string;
    object: string;
    factId?: number;
    chunkId?: number;
    confidence?: number;
  }): void {
    Relations.storeRelation(this.db, opts);
  }

  getRelationsFor(entity: string, limit = 30): Array<{ subject: string; predicate: string; object: string; factId: number | null; chunkId: number | null }> {
    return Relations.getRelationsFor(this.db, entity, limit);
  }

  traverseFrom(entity: string, maxHops = 2): Set<string> {
    return Relations.traverseFrom(this.db, entity, maxHops);
  }

  extractRelations(text: string, entities: string[], factId?: number, chunkId?: number): number {
    return Relations.extractRelations(this.db, text, entities, factId, chunkId);
  }

  relationCount(): number {
    return Relations.relationCount(this.db);
  }

  // ── Reflect ──

  async reflect(sinceDays = 7): Promise<{
    entitiesUpdated: string[];
    opinionsUpdated: number;
  }> {
    return Reflectx.reflect(
      this.db, this.entitiesDir,
      () => { this.dirty = true; },
      (slug) => { this.reindexThroughUniversal("entity", slug).catch(() => {}); },
      sinceDays,
    );
  }

  // ── Stats / lifecycle ──

  getStats(): {
    totalChunks: number;
    totalFiles: number;
    totalFacts: number;
    totalEntities: number;
    hasFts: boolean;
    hasVec: boolean;
    cacheSize: number;
  } {
    return getStats(this.db, this.hasFts, this.hasVec);
  }

  markDirty(): void {
    this.dirty = true;
  }

  close(): void {
    try {
      if (this.watcherHandle.debounceTimer) {
        clearTimeout(this.watcherHandle.debounceTimer);
        this.watcherHandle.debounceTimer = null;
      }
      if (this.watcherHandle.watcher) {
        this.watcherHandle.watcher.close();
        this.watcherHandle.watcher = null;
      }
    } catch {
    } finally {
      try {
        this.db.close();
      } catch {
      }
    }
  }
}
