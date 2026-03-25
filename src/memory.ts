/**
 * Open Agent X — Memory System v2
 *
 * Phase 1: Parity with upstream
 *   - Query expansion with stop word filtering
 *   - Provider-aware embedding cache
 *   - Retry logic with exponential backoff
 *   - Score normalization in MMR
 *   - LRU cache eviction
 *   - Session delta tracking (incremental re-index)
 *   - Configurable parameters
 *   - Credential redaction in session indexing
 *
 * Phase 2: Research paper vision (Retain/Recall/Reflect)
 *   - Entity bank (bank/entities/*.md) with @mention parsing
 *   - Retain: structured fact extraction from daily logs
 *   - Recall: entity/temporal/opinion queries
 *   - Reflect: scheduled job to update entities + opinion confidence
 *   - Opinion confidence tracking (c ∈ [0,1]) with evidence links
 *   - Memory tools for the full R/R/R loop
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  copyFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
} from "node:fs";
import { join, basename, resolve, relative, isAbsolute } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { Session } from "./types.js";

// ══════════════════════════════════════════════════════════
//  ATOMIC FILE OPERATIONS
// ══════════════════════════════════════════════════════════

/** Write atomically: write to temp file, then rename. Crash-safe. */
function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp." + randomBytes(4).toString("hex");
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (e) {
    // Clean up temp on failure
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

/** Read a text file safely: strips BOM, normalizes CRLF, skips binary. */
function safeReadTextFile(filePath: string): string | null {
  try {
    let content = readFileSync(filePath, "utf-8");

    // Strip UTF-8 BOM
    if (content.charCodeAt(0) === 0xfeff) {
      content = content.slice(1);
    }

    // Detect binary (null bytes)
    if (content.includes("\0")) {
      return null;
    }

    // Normalize line endings
    return content.replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════
//  CONFIGURATION (all tuneable — no more hardcoded magic)
// ══════════════════════════════════════════════════════════

export interface MemoryConfig {
  // Chunking
  chunkTokens: number;
  chunkOverlap: number;
  charsPerToken: number;

  // Search
  maxResults: number;
  minScore: number;
  candidateMultiplier: number;
  snippetMaxChars: number;

  // Hybrid weights
  vectorWeight: number;
  textWeight: number;

  // Temporal decay
  temporalDecayEnabled: boolean;
  temporalHalfLifeDays: number;

  // MMR diversity
  mmrEnabled: boolean;
  mmrLambda: number;

  // Embedding cache
  embeddingCacheMaxEntries: number;

  // Retry
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;

  // Session delta tracking
  sessionDeltaBytes: number;
  sessionDeltaMessages: number;

  // Fact retention
  factRetentionDays: number;
  lowConfidenceThreshold: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  chunkTokens: 400,
  chunkOverlap: 80,
  charsPerToken: 4,

  maxResults: 6,
  minScore: 0.35,
  candidateMultiplier: 4,
  snippetMaxChars: 700,

  vectorWeight: 0.7,
  textWeight: 0.3,

  temporalDecayEnabled: true,
  temporalHalfLifeDays: 30,

  mmrEnabled: true,
  mmrLambda: 0.7,

  embeddingCacheMaxEntries: 50_000,

  retryMaxAttempts: 3,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 8_000,

  sessionDeltaBytes: 100_000,
  sessionDeltaMessages: 50,

  factRetentionDays: 365,
  lowConfidenceThreshold: 0.1,
};

// ══════════════════════════════════════════════════════════
//  STOP WORDS (100+ English — from upstream's query expansion)
// ══════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "for", "from",
  "get", "got", "had", "has", "have", "having", "he", "her", "here", "hers",
  "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "itself", "just", "let", "like", "ll", "may", "me", "might",
  "my", "myself", "no", "nor", "not", "of", "on", "or", "our", "ours",
  "ourselves", "out", "own", "re", "same", "shall", "she", "should", "so",
  "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "up", "us", "ve", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "would", "you", "your", "yours", "yourself", "yourselves",
  // Conversational fillers
  "about", "after", "again", "all", "also", "am", "any", "because",
  "before", "between", "both", "each", "few", "further", "had", "more",
  "most", "must", "need", "now", "off", "once", "only", "other", "over",
  "please", "really", "right", "say", "since", "still", "tell", "thing",
  "think", "um", "uh", "use", "used", "using", "want", "well", "went",
]);

// ══════════════════════════════════════════════════════════
//  CREDENTIAL PATTERNS (redact before indexing)
// ══════════════════════════════════════════════════════════

const CREDENTIAL_PATTERNS = [
  /(?:sk|pk|api[_-]?key|token|secret|password|passwd|auth)[-_]?[a-zA-Z0-9]{20,}/gi,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,           // GitHub tokens
  /xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/g,                      // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END/g,
  /AKIA[0-9A-Z]{16}/g,                                       // AWS keys
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/gi,           // Database URLs with passwords
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,             // Credit card numbers
  /npm_[A-Za-z0-9]{36,}/g,                                   // npm tokens
  /(?:Bearer|Basic)\s+[A-Za-z0-9_\-.~+/]+=*/gi,            // Authorization headers
];

function redactCredentials(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

// ══════════════════════════════════════════════════════════
//  TYPES
// ══════════════════════════════════════════════════════════

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions" | "entities";
  entities?: string[];
  kind?: FactKind;
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

export interface EmbeddingProvider {
  name: string;
  model: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

// ── Phase 2: Retain/Recall/Reflect types ──

export type FactKind = "world" | "experience" | "opinion" | "observation";

export interface RetainedFact {
  id?: number;
  kind: FactKind;
  content: string;
  entities: string[];
  confidence: number;
  evidenceFor: string[];
  evidenceAgainst: string[];
  sourceFile: string;
  sourceLine: number;
  timestamp: number;
  lastUpdated: number;
}

export interface EntityPage {
  slug: string;
  displayName: string;
  summary: string;
  facts: RetainedFact[];
  lastReflected: number;
}

// ══════════════════════════════════════════════════════════
//  LEVEL 1: SESSION PERSISTENCE
// ══════════════════════════════════════════════════════════

export class SessionStore {
  private dir: string;
  private metadataCache = new Map<
    string,
    { id: string; title: string; updatedAt: number; messageCount: number }
  >();
  private metadataDirty = true;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "sessions");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.loadMetadataCache();
  }

  save(session: Session): void {
    const filePath = join(this.dir, `${session.id}.json`);
    atomicWriteFileSync(filePath, JSON.stringify(session, null, 2));

    // Update metadata cache in-memory (avoids full re-read)
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
    try {
      unlinkSync(filePath);
    } catch {
      // already gone
    }
    this.metadataCache.delete(id);
    this.saveMetadataCache();
  }

  // ── Metadata cache (avoids reading all session files on list) ──

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
        // Cold start: build from session files (one-time)
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
      // non-fatal — cache will rebuild on next start
    }
  }
}

// ══════════════════════════════════════════════════════════
//  MEMORY INDEX (core engine)
// ══════════════════════════════════════════════════════════

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
  private watcher: ReturnType<typeof watch> | null = null;
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
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

    // Ensure directories exist
    for (const dir of [this.memoryDir, this.bankDir, this.entitiesDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    const dbPath = join(dataDir, "memory.db");
    this.db = this.openDatabaseSafe(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.initSchema();
    this.startWatcher();
  }

  // ── Database safety ──

  private openDatabaseSafe(dbPath: string): InstanceType<typeof Database> {
    let db: InstanceType<typeof Database>;
    try {
      db = new Database(dbPath);
    } catch (e) {
      // DB locked or corrupted — back up and recreate
      console.warn(`[memory] Cannot open database: ${(e as Error).message}`);
      const backup = dbPath + ".backup-" + Date.now();
      try {
        if (existsSync(dbPath)) copyFileSync(dbPath, backup);
        unlinkSync(dbPath);
      } catch {}
      db = new Database(dbPath);
      console.log(`[memory] Recreated database (old backed up to ${backup})`);
    }

    // Quick integrity check
    try {
      const result = db.pragma("quick_check") as Array<{ quick_check: string }>;
      if (result[0]?.quick_check !== "ok") {
        console.warn("[memory] Database integrity check failed, backing up and recreating");
        const backup = dbPath + ".backup-" + Date.now();
        db.close();
        copyFileSync(dbPath, backup);
        unlinkSync(dbPath);
        db = new Database(dbPath);
      }
    } catch {
      // quick_check failed — continue anyway, schema init will create tables
    }

    return db;
  }

  /** Rebuild FTS index from chunks table (call if index gets out of sync) */
  rebuildFtsIndex(): void {
    if (!this.hasFts) return;
    console.log("[memory] Rebuilding FTS index...");

    this.db.transaction(() => {
      // Rebuild chunks FTS
      try {
        this.db.exec("DELETE FROM chunks_fts");
      } catch {}
      const chunks = this.db
        .prepare("SELECT id, text FROM chunks")
        .all() as Array<{ id: number; text: string }>;
      const insertChunkFts = this.db.prepare(
        "INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)"
      );
      for (const chunk of chunks) {
        try {
          insertChunkFts.run(chunk.id, chunk.text);
        } catch {}
      }

      // Rebuild facts FTS
      try {
        this.db.exec("DELETE FROM facts_fts");
      } catch {}
      const facts = this.db
        .prepare("SELECT id, content FROM facts")
        .all() as Array<{ id: number; content: string }>;
      const insertFactFts = this.db.prepare(
        "INSERT INTO facts_fts (rowid, content) VALUES (?, ?)"
      );
      for (const fact of facts) {
        try {
          insertFactFts.run(fact.id, fact.content);
        } catch {}
      }
    })();

    console.log("[memory] FTS rebuild complete");
  }

  // ── Schema with migration support ──

  private static readonly CURRENT_SCHEMA_VERSION = 3;

  private initSchema(): void {
    // Create meta table first (needed for version check)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const existingVersion = this.getSchemaVersion();

    if (existingVersion < MemoryIndex.CURRENT_SCHEMA_VERSION) {
      this.migrateSchema(existingVersion);
    }
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      return row ? parseInt(row.value, 10) || 0 : 0;
    } catch {
      return 0;
    }
  }

  private migrateSchema(fromVersion: number): void {
    console.log(
      `[memory] Migrating schema from v${fromVersion} to v${MemoryIndex.CURRENT_SCHEMA_VERSION}`
    );

    this.db.transaction(() => {
      // v0 → v1+: Create all core tables
      if (fromVersion < 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            source TEXT NOT NULL DEFAULT 'memory',
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
            provider TEXT NOT NULL DEFAULT 'default',
            model TEXT NOT NULL DEFAULT 'default',
            embedding TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (hash, provider, model)
          );

          CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at
            ON embedding_cache(updated_at);
        `);
      }

      // v1 → v2: Add facts + entity mentions
      if (fromVersion < 2) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL CHECK(kind IN ('world','experience','opinion','observation')),
            content TEXT NOT NULL,
            entities TEXT NOT NULL DEFAULT '[]',
            confidence REAL NOT NULL DEFAULT 1.0,
            evidence_for TEXT NOT NULL DEFAULT '[]',
            evidence_against TEXT NOT NULL DEFAULT '[]',
            source_file TEXT NOT NULL,
            source_line INTEGER NOT NULL DEFAULT 0,
            timestamp INTEGER NOT NULL,
            last_updated INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind);
          CREATE INDEX IF NOT EXISTS idx_facts_timestamp ON facts(timestamp);

          CREATE TABLE IF NOT EXISTS entity_mentions (
            fact_id INTEGER NOT NULL,
            entity_slug TEXT NOT NULL,
            PRIMARY KEY (fact_id, entity_slug),
            FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_entity_mentions_slug ON entity_mentions(entity_slug);
        `);
      }

      // v2 → v3: Add content hash uniqueness index on facts
      if (fromVersion < 3) {
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_dedup
            ON facts(kind, content, entities);
        `);
      }

      // Update version
      this.db
        .prepare(
          `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`
        )
        .run(String(MemoryIndex.CURRENT_SCHEMA_VERSION));
    })();

    // FTS tables (outside transaction — virtual tables can't be in transactions)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text,
          content=chunks,
          content_rowid=id
        );
      `);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
          content,
          content=facts,
          content_rowid=id
        );
      `);
      this.hasFts = true;
    } catch {
      console.log("[memory] FTS5 not available — keyword search disabled");
    }

    console.log(`[memory] Schema migration complete (v${MemoryIndex.CURRENT_SCHEMA_VERSION})`);
  }

  // ── Knowledge Memory Files ──

  getMemoryFilePath(): string {
    return join(this.memoryDir, "MIND.md");
  }

  getDailyLogPath(date?: Date): string {
    const d = date || new Date();
    const dateStr = d.toISOString().split("T")[0];
    return join(this.memoryDir, `${dateStr}.md`);
  }

  appendDailyLog(text: string): void {
    const logPath = this.getDailyLogPath();
    const timestamp = new Date().toLocaleTimeString();
    // appendFileSync is atomic for small writes — no read-modify-write race
    appendFileSync(logPath, `\n[${timestamp}] ${text}\n`, "utf-8");
    this.dirty = true;
  }

  readMemoryFile(): string {
    const p = this.getMemoryFilePath();
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  writeMemoryFile(content: string): void {
    atomicWriteFileSync(this.getMemoryFilePath(), content);
    this.dirty = true;
  }

  // ── Embedding Provider ──

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    this.initVectorTable(provider.dimensions);
  }

  private initVectorTable(dims: number): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding FLOAT[${dims}]
        );
      `);
      this.hasVec = true;
    } catch {
      console.log(
        "[memory] sqlite-vec not available — vector search will use in-memory cosine"
      );
    }
  }

  // ══════════════════════════════════════════════════════════
  //  SYNC & INDEXING (with session delta tracking)
  // ══════════════════════════════════════════════════════════

  async sync(): Promise<void> {
    if (!this.dirty) return;
    if (this.syncInProgress) return; // Prevent concurrent syncs
    this.syncInProgress = true;
    this.dirty = false;

    try {
      const memoryFiles = this.listMemoryFiles();
      const sessionFiles = this.listSessionFiles();
      const allFiles = [...memoryFiles, ...sessionFiles];

      for (const file of allFiles) {
        const existing = this.db
          .prepare("SELECT hash FROM files WHERE path = ?")
          .get(file.path) as { hash: string } | undefined;

        if (existing && existing.hash === file.hash) continue;

        // Session delta check: skip full re-index if change is small and only grew
        if (file.source === "sessions" && existing) {
          const delta = this.sessionDeltas.get(file.path);
          if (delta) {
            const sizeDiff = file.size - delta.lastSize;
            const msgCount = this.countSessionMessages(file.path);

            // Only skip re-index if size grew (not shrank) and below threshold
            if (
              sizeDiff > 0 &&
              sizeDiff < this.config.sessionDeltaBytes &&
              msgCount >= delta.lastMessageCount
            ) {
              this.db
                .prepare("UPDATE files SET hash = ?, mtime = ?, size = ? WHERE path = ?")
                .run(file.hash, file.mtime, file.size, file.path);
              this.sessionDeltas.set(file.path, {
                lastSize: file.size,
                lastMessageCount: msgCount,
              });
              continue;
            }
          }
        }

        await this.indexFile(file);

        if (file.source === "sessions") {
          this.sessionDeltas.set(file.path, {
            lastSize: file.size,
            lastMessageCount: this.countSessionMessages(file.path),
          });
        }
      }

      // Remove chunks for deleted files
      const allPaths = new Set(allFiles.map((f) => f.path));
      const dbFiles = this.db.prepare("SELECT path FROM files").all() as { path: string }[];
      for (const { path } of dbFiles) {
        if (!allPaths.has(path)) {
          this.removeFile(path);
        }
      }

      // Prune embedding cache if needed
      this.pruneEmbeddingCache();

      // Archive old facts periodically
      this.archiveOldFacts();
    } catch (e) {
      console.error("[memory] Sync failed:", (e as Error).message);
      this.dirty = true; // Retry on next search
    } finally {
      this.syncInProgress = false;
    }
  }

  private countSessionMessages(path: string): number {
    try {
      const session = JSON.parse(readFileSync(path, "utf-8")) as Session;
      return session.messages.length;
    } catch {
      return 0;
    }
  }

  private listMemoryFiles(): FileRecord[] {
    if (!existsSync(this.memoryDir)) return [];
    const records: FileRecord[] = [];

    const scanDir = (dir: string, source: string) => {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Recurse into bank/, entities/ etc — but skip .git, node_modules
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
            const childSource =
              entry.name === "entities" ? "entities" : source;
            scanDir(fullPath, childSource);
          }
        } else if (entry.name.endsWith(".md")) {
          try {
            const stat = statSync(fullPath);
            // Use mtime+size as cheap change detector (avoids reading full file)
            records.push({
              path: fullPath,
              source,
              hash: `${stat.mtimeMs}:${stat.size}`,
              mtime: stat.mtimeMs,
              size: stat.size,
            });
          } catch {
            // File disappeared between readdir and stat — skip
          }
        }
      }
    };

    scanDir(this.memoryDir, "memory");
    return records;
  }

  private listSessionFiles(): FileRecord[] {
    const sessDir = join(this.dataDir, "sessions");
    if (!existsSync(sessDir)) return [];
    const records: FileRecord[] = [];

    const files = readdirSync(sessDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const fullPath = join(sessDir, file);
      try {
        const stat = statSync(fullPath);
        records.push({
          path: fullPath,
          source: "sessions",
          hash: `${stat.mtimeMs}:${stat.size}`,
          mtime: stat.mtimeMs,
          size: stat.size,
        });
      } catch {
        // File disappeared — skip
      }
    }

    return records;
  }

  private async indexFile(file: FileRecord): Promise<void> {
    this.removeFile(file.path);

    let content: string;
    if (file.source === "sessions") {
      content = this.flattenSession(file.path);
    } else {
      const raw = safeReadTextFile(file.path);
      if (!raw) return; // Binary file or read error — skip
      content = raw;
    }

    if (!content.trim()) return;

    const maxChunkChars = this.config.chunkTokens * this.config.charsPerToken;
    const overlapChars = this.config.chunkOverlap * this.config.charsPerToken;
    const chunks = chunkText(content, file.path, file.source, maxChunkChars, overlapChars);

    // Embed with retry
    if (this.embeddingProvider) {
      await this.embedChunksWithRetry(chunks);
    }

    // Insert chunks in a transaction
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (path, source, start_line, end_line, text, hash, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = this.hasFts
      ? this.db.prepare(
          `INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)`
        )
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
          insertFts.run(chunkId, chunk.text);
        }

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

      this.db
        .prepare(
          "INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)"
        )
        .run(file.path, file.source, file.hash, file.mtime, file.size);
    });

    insertMany();
  }

  private removeFile(path: string): void {
    // Wrap all deletions in a single transaction to prevent orphaned rows
    const doRemove = this.db.transaction(() => {
      const chunks = this.db
        .prepare("SELECT id FROM chunks WHERE path = ?")
        .all(path) as { id: number }[];

      if (chunks.length > 0) {
        if (this.hasFts) {
          for (const { id } of chunks) {
            try {
              this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(id);
            } catch {}
          }
        }
        if (this.hasVec) {
          for (const { id } of chunks) {
            try {
              this.db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?").run(id);
            } catch {}
          }
        }
        // Delete chunks AFTER cleaning up dependent tables
        this.db.prepare("DELETE FROM chunks WHERE path = ?").run(path);
      }

      this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
    });

    doRemove();
  }

  // ── Session flattening with credential redaction ──

  private flattenSession(path: string): string {
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
            // Handle structured content (text parts)
            content = (msg.content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text" && p.text)
              .map((p) => p.text)
              .join("\n");
          }
          if (content) {
            // Redact credentials before indexing
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

  // ══════════════════════════════════════════════════════════
  //  EMBEDDING with RETRY + PROVIDER-AWARE CACHE
  // ══════════════════════════════════════════════════════════

  private async embedChunksWithRetry(chunks: Chunk[]): Promise<void> {
    if (!this.embeddingProvider) return;

    const provider = this.embeddingProvider;
    const textsToEmbed: string[] = [];
    const cachedEmbeddings = new Map<number, number[]>();

    // Check cache (provider-aware)
    for (let i = 0; i < chunks.length; i++) {
      const cached = this.getCachedEmbedding(chunks[i].hash, provider.name, provider.model);
      if (cached) {
        cachedEmbeddings.set(i, cached);
      } else {
        textsToEmbed.push(chunks[i].text);
      }
    }

    // Batch embed uncached with retry
    let newEmbeddings: number[][] = [];
    if (textsToEmbed.length > 0) {
      newEmbeddings = await this.embedWithRetry(textsToEmbed);
    }

    // Merge cached + new
    let newIdx = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (cachedEmbeddings.has(i)) {
        chunks[i].embedding = cachedEmbeddings.get(i);
      } else if (newIdx < newEmbeddings.length) {
        chunks[i].embedding = newEmbeddings[newIdx];
        this.cacheEmbedding(
          chunks[i].hash,
          provider.name,
          provider.model,
          chunks[i].embedding!
        );
        newIdx++;
      }
    }
  }

  private async embedWithRetry(texts: string[]): Promise<number[][]> {
    const { retryMaxAttempts, retryBaseDelayMs, retryMaxDelayMs } = this.config;
    const startTime = Date.now();
    const TOTAL_TIMEOUT_MS = 30_000;

    for (let attempt = 1; attempt <= retryMaxAttempts; attempt++) {
      // Global timeout check
      if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
        console.warn("[memory] Embedding total timeout exceeded (30s)");
        break;
      }

      try {
        // Race embedding against a timeout
        const result = await Promise.race([
          this.embeddingProvider!.embedBatch(texts),
          sleep(TOTAL_TIMEOUT_MS).then(() => {
            throw new Error("Embedding request timed out");
          }),
        ]);
        return result;
      } catch (e) {
        const msg = (e as Error).message;
        console.warn(
          `[memory] Embedding attempt ${attempt}/${retryMaxAttempts} failed: ${msg}`
        );

        if (attempt < retryMaxAttempts) {
          const delay = Math.min(
            retryBaseDelayMs * Math.pow(2, attempt - 1),
            retryMaxDelayMs
          );
          await sleep(delay);
        }
      }
    }

    console.warn(
      `[memory] All embedding attempts exhausted — ${texts.length} chunks will lack vectors`
    );
    return [];
  }

  // ── Provider-aware embedding cache ──

  private getCachedEmbedding(
    hash: string,
    provider: string,
    model: string
  ): number[] | null {
    const row = this.db
      .prepare(
        "SELECT embedding FROM embedding_cache WHERE hash = ? AND provider = ? AND model = ?"
      )
      .get(hash, provider, model) as { embedding: string } | undefined;
    if (!row) return null;
    try {
      // Touch updated_at for LRU
      this.db
        .prepare(
          "UPDATE embedding_cache SET updated_at = ? WHERE hash = ? AND provider = ? AND model = ?"
        )
        .run(Date.now(), hash, provider, model);
      return JSON.parse(row.embedding);
    } catch {
      return null;
    }
  }

  private cacheEmbedding(
    hash: string,
    provider: string,
    model: string,
    embedding: number[]
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO embedding_cache (hash, provider, model, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(hash, provider, model, JSON.stringify(embedding), Date.now());
  }

  // ── LRU cache eviction ──

  private pruneEmbeddingCache(): void {
    const max = this.config.embeddingCacheMaxEntries;
    const count = (
      this.db.prepare("SELECT COUNT(*) as n FROM embedding_cache").get() as { n: number }
    ).n;

    if (count <= max) return;

    const toDelete = count - max;
    this.db
      .prepare(
        `DELETE FROM embedding_cache WHERE rowid IN (
          SELECT rowid FROM embedding_cache ORDER BY updated_at ASC LIMIT ?
        )`
      )
      .run(toDelete);

    console.log(`[memory] Pruned ${toDelete} stale embedding cache entries`);
  }

  // ── Fact archival ──

  private archiveOldFacts(): void {
    const cutoffMs =
      Date.now() - this.config.factRetentionDays * 24 * 60 * 60 * 1000;
    const threshold = this.config.lowConfidenceThreshold;

    const deleted = this.db.transaction(() => {
      // Delete entity mentions for old/low-confidence facts
      const toDelete = this.db
        .prepare(
          `SELECT id FROM facts
           WHERE timestamp < ? OR (kind = 'opinion' AND confidence < ?)`
        )
        .all(cutoffMs, threshold) as Array<{ id: number }>;

      if (toDelete.length === 0) return 0;

      for (const { id } of toDelete) {
        this.db.prepare("DELETE FROM entity_mentions WHERE fact_id = ?").run(id);
        if (this.hasFts) {
          try {
            this.db.prepare("DELETE FROM facts_fts WHERE rowid = ?").run(id);
          } catch {}
        }
      }

      this.db
        .prepare(
          `DELETE FROM facts
           WHERE timestamp < ? OR (kind = 'opinion' AND confidence < ?)`
        )
        .run(cutoffMs, threshold);

      return toDelete.length;
    })();

    if (deleted > 0) {
      console.log(`[memory] Archived ${deleted} old/low-confidence facts`);
    }
  }

  // ── File Watcher (with ignore patterns) ──

  private startWatcher(): void {
    try {
      this.watcher = watch(this.memoryDir, { recursive: true }, (_event, filename) => {
        // Ignore .git, node_modules, hidden files
        if (
          filename &&
          (filename.includes(".git") ||
            filename.includes("node_modules") ||
            filename.startsWith("."))
        ) {
          return;
        }

        // Debounce: wait 500ms after last change before marking dirty
        if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
        this.watchDebounceTimer = setTimeout(() => {
          this.dirty = true;
          this.watchDebounceTimer = null;
        }, 500);
      });
    } catch {
      // watcher not available on this platform
    }
  }

  // ══════════════════════════════════════════════════════════
  //  SEARCH (hybrid with query expansion)
  // ══════════════════════════════════════════════════════════

  async search(
    query: string,
    options?: {
      maxResults?: number;
      minScore?: number;
      sources?: string[];
      entities?: string[];
      since?: Date;
      kind?: FactKind;
    }
  ): Promise<MemorySearchResult[]> {
    await this.sync();

    const maxResults = options?.maxResults || this.config.maxResults;
    const minScore = options?.minScore || this.config.minScore;
    const candidateLimit = Math.min(
      200,
      Math.max(1, maxResults * this.config.candidateMultiplier)
    );

    let keywordResults: Array<Chunk & { score: number }> = [];
    let vectorResults: Array<Chunk & { score: number }> = [];

    // Keyword search (BM25) with query expansion
    if (this.hasFts) {
      keywordResults = this.searchKeyword(query, candidateLimit, options?.sources);

      // If AND query returns nothing, try individual keywords (graceful degradation)
      if (keywordResults.length === 0) {
        const keywords = extractKeywords(query);
        for (const kw of keywords) {
          const partial = this.searchKeyword(kw, candidateLimit, options?.sources);
          keywordResults.push(...partial);
        }
        // Deduplicate by chunk id, keep highest score
        const deduped = new Map<number, (typeof keywordResults)[0]>();
        for (const r of keywordResults) {
          const existing = deduped.get(r.id!);
          if (!existing || r.score > existing.score) {
            deduped.set(r.id!, r);
          }
        }
        keywordResults = [...deduped.values()];
      }
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
      merged = mergeHybridResults(
        keywordResults,
        vectorResults,
        this.config.vectorWeight,
        this.config.textWeight,
        this.config.snippetMaxChars
      );
    } else if (vectorResults.length > 0) {
      merged = vectorResults.map((c) => toSearchResult(c, this.config.snippetMaxChars));
    } else {
      merged = keywordResults.map((c) => toSearchResult(c, this.config.snippetMaxChars));

      // Relax minScore for keyword-only results (they score lower)
      if (!this.embeddingProvider && merged.length > 0) {
        const relaxedMin = Math.min(minScore, this.config.textWeight);
        return this.postProcess(merged, maxResults, relaxedMin, options);
      }
    }

    return this.postProcess(merged, maxResults, minScore, options);
  }

  private postProcess(
    results: MemorySearchResult[],
    maxResults: number,
    minScore: number,
    options?: { since?: Date; entities?: string[]; kind?: FactKind }
  ): MemorySearchResult[] {
    // Apply temporal decay
    if (this.config.temporalDecayEnabled) {
      results = applyTemporalDecay(results, this.config.temporalHalfLifeDays);
    }

    // Apply MMR diversity re-ranking
    if (this.config.mmrEnabled) {
      results = mmrRerank(results, maxResults, this.config.mmrLambda);
    }

    // Temporal filter
    if (options?.since) {
      const sinceMs = options.since.getTime();
      results = results.filter((r) => {
        const dateMatch = basename(r.path).match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) return true; // Evergreen files pass
        return new Date(dateMatch[1]).getTime() >= sinceMs;
      });
    }

    // Entity filter
    if (options?.entities && options.entities.length > 0) {
      const slugs = new Set(options.entities.map((e) => slugify(e)));
      results = results.filter((r) => {
        if (!r.entities || r.entities.length === 0) return true;
        return r.entities.some((e) => slugs.has(slugify(e)));
      });
    }

    return results.filter((r) => r.score >= minScore).slice(0, maxResults);
  }

  private searchKeyword(
    query: string,
    limit: number,
    sources?: string[]
  ): Array<Chunk & { score: number }> {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    try {
      // Query FTS, then join back to chunks for full data
      const rows = this.db
        .prepare(
          `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text,
                  bm25(chunks_fts) as rank
           FROM chunks_fts f
           JOIN chunks c ON c.id = f.rowid
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
    // Paginated in-memory cosine search (caps memory at ~1000 chunks at a time)
    const BATCH_SIZE = 1000;
    const sourceFilter = sources ? `AND source IN (${sources.map(() => "?").join(",")})` : "";
    const params = sources ? [...sources] : [];

    const totalCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as n FROM chunks WHERE embedding IS NOT NULL ${sourceFilter}`
        )
        .get(...params) as { n: number }
    ).n;

    // Keep a min-heap of top results (sorted desc by score)
    const results: Array<Chunk & { score: number }> = [];
    let minResultScore = -Infinity;

    for (let offset = 0; offset < totalCount; offset += BATCH_SIZE) {
      const batch = this.db
        .prepare(
          `SELECT id, path, source, start_line, end_line, text, embedding
           FROM chunks WHERE embedding IS NOT NULL ${sourceFilter}
           LIMIT ? OFFSET ?`
        )
        .all(...params, BATCH_SIZE, offset) as Array<{
        id: number;
        path: string;
        source: string;
        start_line: number;
        end_line: number;
        text: string;
        embedding: string;
      }>;

      for (const row of batch) {
        let embedding: number[];
        try {
          embedding = JSON.parse(row.embedding);
        } catch {
          continue;
        }

        const similarity = cosineSimilarity(queryVec, embedding);
        if (!Number.isFinite(similarity)) continue;

        // Only keep top N results in memory
        if (results.length < limit * 2 || similarity > minResultScore) {
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

          // Trim if too large
          if (results.length > limit * 4) {
            results.sort((a, b) => b.score - a.score);
            results.length = limit * 2;
            minResultScore = results[results.length - 1].score;
          }
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ══════════════════════════════════════════════════════════
  //  PHASE 2: RETAIN / RECALL / REFLECT
  // ══════════════════════════════════════════════════════════

  // ── RETAIN: Parse structured facts from daily logs ──

  retain(text: string, sourceFile: string, sourceLine = 0): RetainedFact[] {
    const facts: RetainedFact[] = [];
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("- ")) continue;

      const bullet = line.slice(2).trim();
      const parsed = parseFactLine(bullet);
      if (!parsed) continue;

      // Validate content is meaningful
      if (parsed.content.length < 3) continue;

      // Filter out empty entity strings
      const validEntities = parsed.entities.filter((e) => e.length > 0);

      const now = Date.now();
      const entitiesJson = JSON.stringify(validEntities);

      // Deduplicate: skip if identical fact already exists (UNIQUE index handles this)
      try {
        const result = this.db
          .prepare(
            `INSERT INTO facts (kind, content, entities, confidence, evidence_for, evidence_against,
             source_file, source_line, timestamp, last_updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            parsed.kind,
            parsed.content,
            entitiesJson,
            parsed.confidence,
            "[]",
            "[]",
            sourceFile,
            sourceLine + i + 1,
            now,
            now
          );

        const factId = result.lastInsertRowid as number;

        const fact: RetainedFact = {
          id: factId,
          kind: parsed.kind,
          content: parsed.content,
          entities: validEntities,
          confidence: parsed.confidence,
          evidenceFor: [],
          evidenceAgainst: [],
          sourceFile,
          sourceLine: sourceLine + i + 1,
          timestamp: now,
          lastUpdated: now,
        };

        // Index entity mentions
        for (const entity of validEntities) {
          const slug = slugify(entity);
          if (slug) {
            this.db
              .prepare(
                "INSERT OR IGNORE INTO entity_mentions (fact_id, entity_slug) VALUES (?, ?)"
              )
              .run(factId, slug);
          }
        }

        // FTS index
        if (this.hasFts) {
          try {
            this.db
              .prepare("INSERT INTO facts_fts (rowid, content) VALUES (?, ?)")
              .run(factId, parsed.content);
          } catch {}
        }

        facts.push(fact);
      } catch (e) {
        // UNIQUE constraint violation = duplicate fact, skip silently
        const msg = (e as Error).message;
        if (!msg.includes("UNIQUE")) {
          console.warn(`[memory] Failed to retain fact: ${msg}`);
        }
      }
    }

    return facts;
  }

  // ── Auto-retain from ## Retain sections in daily logs ──

  retainFromDailyLog(date?: Date): RetainedFact[] {
    const logPath = this.getDailyLogPath(date);
    if (!existsSync(logPath)) return [];

    const content = readFileSync(logPath, "utf-8");
    const retainMatch = content.match(/## Retain\s*\n([\s\S]*?)(?=\n## |\n*$)/);
    if (!retainMatch) return [];

    return this.retain(retainMatch[1], logPath);
  }

  // ── RECALL: Query facts by entity, time, kind ──

  recallByEntity(entitySlug: string, limit = 20): RetainedFact[] {
    const slug = slugify(entitySlug);
    const rows = this.db
      .prepare(
        `SELECT f.* FROM facts f
         JOIN entity_mentions em ON em.fact_id = f.id
         WHERE em.entity_slug = ?
         ORDER BY f.timestamp DESC
         LIMIT ?`
      )
      .all(slug, limit) as Array<Record<string, unknown>>;

    return rows.map(rowToFact);
  }

  recallByKind(kind: FactKind, limit = 20): RetainedFact[] {
    const rows = this.db
      .prepare("SELECT * FROM facts WHERE kind = ? ORDER BY timestamp DESC LIMIT ?")
      .all(kind, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToFact);
  }

  recallByTime(since: Date, until?: Date, limit = 50): RetainedFact[] {
    const sinceMs = since.getTime();
    const untilMs = until ? until.getTime() : Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM facts WHERE timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(sinceMs, untilMs, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToFact);
  }

  recallOpinions(entitySlug?: string): RetainedFact[] {
    if (entitySlug) {
      const slug = slugify(entitySlug);
      const rows = this.db
        .prepare(
          `SELECT f.* FROM facts f
           JOIN entity_mentions em ON em.fact_id = f.id
           WHERE f.kind = 'opinion' AND em.entity_slug = ?
           ORDER BY f.confidence DESC, f.last_updated DESC`
        )
        .all(slug) as Array<Record<string, unknown>>;
      return rows.map(rowToFact);
    }

    const rows = this.db
      .prepare(
        "SELECT * FROM facts WHERE kind = 'opinion' ORDER BY confidence DESC, last_updated DESC"
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToFact);
  }

  // ── REFLECT: Update entity pages + opinion confidence ──

  async reflect(sinceDays = 7): Promise<{
    entitiesUpdated: string[];
    opinionsUpdated: number;
  }> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const recentFacts = this.recallByTime(since);

    // Collect all mentioned entities
    const entityFactMap = new Map<string, RetainedFact[]>();
    for (const fact of recentFacts) {
      for (const entity of fact.entities) {
        const slug = slugify(entity);
        if (!entityFactMap.has(slug)) entityFactMap.set(slug, []);
        entityFactMap.get(slug)!.push(fact);
      }
    }

    // Update entity pages
    const entitiesUpdated: string[] = [];
    for (const [slug, facts] of entityFactMap) {
      this.updateEntityPage(slug, facts);
      entitiesUpdated.push(slug);
    }

    // Update opinion confidence
    let opinionsUpdated = 0;
    const opinions = this.recallOpinions();
    for (const opinion of opinions) {
      const updated = this.updateOpinionConfidence(opinion, recentFacts);
      if (updated) opinionsUpdated++;
    }

    return { entitiesUpdated, opinionsUpdated };
  }

  private static readonly MAX_FACTS_PER_ENTITY = 50;
  private static readonly MAX_FACTS_PER_KIND = 15;

  private updateEntityPage(slug: string, recentFacts: RetainedFact[]): void {
    const allFacts = this.recallByEntity(
      slug,
      MemoryIndex.MAX_FACTS_PER_ENTITY
    );
    const displayName =
      recentFacts[0]?.entities.find((e) => slugify(e) === slug) || slug;

    // Group by kind, limit per kind to prevent unbounded growth
    const byKind = new Map<FactKind, RetainedFact[]>();
    for (const fact of allFacts) {
      if (!byKind.has(fact.kind)) byKind.set(fact.kind, []);
      const arr = byKind.get(fact.kind)!;
      if (arr.length < MemoryIndex.MAX_FACTS_PER_KIND) {
        arr.push(fact);
      }
    }

    const lines: string[] = [
      `# ${displayName}`,
      "",
      `*Last reflected: ${new Date().toISOString().split("T")[0]}*`,
      "",
    ];

    const kindLabels: Record<FactKind, string> = {
      world: "Facts",
      experience: "Experience",
      opinion: "Opinions & Preferences",
      observation: "Observations",
    };

    for (const [kind, label] of Object.entries(kindLabels) as [FactKind, string][]) {
      const facts = byKind.get(kind);
      if (!facts || facts.length === 0) continue;

      lines.push(`## ${label}`, "");
      for (const fact of facts) {
        const conf =
          kind === "opinion" ? ` (confidence: ${fact.confidence.toFixed(2)})` : "";
        const date = new Date(fact.timestamp).toISOString().split("T")[0];
        lines.push(`- ${fact.content}${conf} — *${date}*`);
      }
      lines.push("");
    }

    const entityPath = join(this.entitiesDir, `${slug}.md`);
    atomicWriteFileSync(entityPath, lines.join("\n"));
    this.dirty = true;
  }

  private updateOpinionConfidence(
    opinion: RetainedFact,
    recentFacts: RetainedFact[]
  ): boolean {
    // Find recent facts about same entities that might reinforce or contradict
    const opinionEntities = new Set(opinion.entities.map(slugify));
    const related = recentFacts.filter(
      (f) =>
        f.id !== opinion.id &&
        f.entities.some((e) => opinionEntities.has(slugify(e)))
    );

    if (related.length === 0) return false;

    // Simple heuristic: similar facts reinforce, contradicting facts reduce
    // For now, just count as evidence without changing confidence
    // (A full implementation would use embedding similarity to detect contradiction)
    const newEvidenceFor = [
      ...opinion.evidenceFor,
      ...related
        .filter((f) => f.kind !== "opinion")
        .map((f) => `${f.sourceFile}#L${f.sourceLine}`),
    ];

    this.db
      .prepare(
        "UPDATE facts SET evidence_for = ?, last_updated = ? WHERE id = ?"
      )
      .run(JSON.stringify(newEvidenceFor), Date.now(), opinion.id);

    return true;
  }

  // ══════════════════════════════════════════════════════════
  //  UTILITY
  // ══════════════════════════════════════════════════════════

  getStats(): {
    totalChunks: number;
    totalFiles: number;
    totalFacts: number;
    totalEntities: number;
    hasFts: boolean;
    hasVec: boolean;
    cacheSize: number;
  } {
    const chunks = (
      this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number }
    ).n;
    const files = (
      this.db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number }
    ).n;
    const facts = (
      this.db.prepare("SELECT COUNT(*) as n FROM facts").get() as { n: number }
    ).n;
    const entities = (
      this.db
        .prepare("SELECT COUNT(DISTINCT entity_slug) as n FROM entity_mentions")
        .get() as { n: number }
    ).n;
    const cache = (
      this.db.prepare("SELECT COUNT(*) as n FROM embedding_cache").get() as {
        n: number;
      }
    ).n;

    return {
      totalChunks: chunks,
      totalFiles: files,
      totalFacts: facts,
      totalEntities: entities,
      hasFts: this.hasFts,
      hasVec: this.hasVec,
      cacheSize: cache,
    };
  }

  markDirty(): void {
    this.dirty = true;
  }

  close(): void {
    // Always close DB even if watcher close fails
    try {
      if (this.watchDebounceTimer) {
        clearTimeout(this.watchDebounceTimer);
        this.watchDebounceTimer = null;
      }
      if (this.watcher) {
        this.watcher.close();
        this.watcher = null;
      }
    } catch {
      // watcher close failed — continue to close DB
    } finally {
      try {
        this.db.close();
      } catch {
        // DB already closed
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
//  QUERY EXPANSION
// ══════════════════════════════════════════════════════════

function extractKeywords(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function buildFtsQuery(raw: string): string {
  const keywords = extractKeywords(raw);
  if (keywords.length === 0) return "";
  // Escape quotes inside keywords, then quote each token
  return keywords.map((k) => `"${k.replace(/"/g, '""')}"`).join(" AND ");
}

// ══════════════════════════════════════════════════════════
//  FACT PARSING (## Retain section)
// ══════════════════════════════════════════════════════════

const KIND_PREFIX: Record<string, FactKind> = {
  W: "world",
  B: "experience",
  O: "opinion",
  S: "observation",
};

function parseFactLine(
  line: string
): { kind: FactKind; content: string; entities: string[]; confidence: number } | null {
  // Match: W @Entity: content   or   O(c=0.95) @Entity: content
  const prefixMatch = line.match(
    /^([WBOS])(?:\(c=(\d+\.?\d*)\))?\s+(.*)/
  );

  let kind: FactKind = "observation";
  let confidence = 1.0;
  let rest = line;

  if (prefixMatch) {
    kind = KIND_PREFIX[prefixMatch[1]] || "observation";
    confidence = prefixMatch[2] ? parseFloat(prefixMatch[2]) : 1.0;
    rest = prefixMatch[3];
  }

  // Extract @entity mentions
  const entityMatches = rest.match(/@([\w-]+)/g) || [];
  const entities = entityMatches.map((m) => m.slice(1));

  // Clean content (remove @mentions prefix, keep the rest)
  const content = rest
    .replace(/@[\w-]+:?\s*/g, "")
    .trim();

  if (!content) return null;

  return { kind, content, entities, confidence: Math.max(0, Math.min(1, confidence)) };
}

function rowToFact(row: Record<string, unknown>): RetainedFact {
  return {
    id: row.id as number,
    kind: row.kind as FactKind,
    content: row.content as string,
    entities: JSON.parse((row.entities as string) || "[]"),
    confidence: row.confidence as number,
    evidenceFor: JSON.parse((row.evidence_for as string) || "[]"),
    evidenceAgainst: JSON.parse((row.evidence_against as string) || "[]"),
    sourceFile: row.source_file as string,
    sourceLine: row.source_line as number,
    timestamp: row.timestamp as number,
    lastUpdated: row.last_updated as number,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ══════════════════════════════════════════════════════════
//  CHUNKING
// ══════════════════════════════════════════════════════════

function chunkText(
  content: string,
  path: string,
  source: string,
  maxChunkChars: number,
  overlapChars: number
): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let currentText = "";
  let currentStart = 1;
  let currentChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentText += (currentText ? "\n" : "") + line;
    currentChars += line.length + 1;

    if (currentChars >= maxChunkChars || i === lines.length - 1) {
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

      if (i < lines.length - 1) {
        // Overlap: carry backwards from end
        const overlapText = currentText.slice(-overlapChars);
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

// ══════════════════════════════════════════════════════════
//  SCORE NORMALIZATION
// ══════════════════════════════════════════════════════════

function bm25RankToScore(rank: number): number {
  const relevance = -rank;
  return Math.max(0, Math.min(1, relevance / (1 + Math.abs(relevance))));
}

function normalizeScores(results: { score: number }[]): void {
  if (results.length === 0) return;
  const max = Math.max(...results.map((r) => r.score));
  const min = Math.min(...results.map((r) => r.score));
  const range = max - min;
  if (range === 0) {
    for (const r of results) r.score = 1;
    return;
  }
  for (const r of results) {
    r.score = (r.score - min) / range;
  }
}

// ══════════════════════════════════════════════════════════
//  HYBRID MERGE
// ══════════════════════════════════════════════════════════

function mergeHybridResults(
  keywordResults: Array<Chunk & { score: number }>,
  vectorResults: Array<Chunk & { score: number }>,
  vectorWeight: number,
  textWeight: number,
  snippetMaxChars: number
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
    const score =
      vectorWeight * entry.vectorScore + textWeight * entry.textScore;
    results.push(toSearchResult({ ...entry.chunk, score }, snippetMaxChars));
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ══════════════════════════════════════════════════════════
//  TEMPORAL DECAY
// ══════════════════════════════════════════════════════════

function applyTemporalDecay(
  results: MemorySearchResult[],
  halfLifeDays: number
): MemorySearchResult[] {
  const now = Date.now();
  const lambda = Math.LN2 / halfLifeDays;

  return results.map((r) => {
    const dateMatch = basename(r.path).match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return r; // Evergreen file — no decay

    const fileDate = new Date(dateMatch[1]).getTime();
    if (isNaN(fileDate)) return r; // Invalid date — skip

    const ageDays = Math.max(0, (now - fileDate) / (1000 * 60 * 60 * 24));
    const multiplier = Math.exp(-lambda * ageDays);

    return { ...r, score: r.score * multiplier };
  });
}

// ══════════════════════════════════════════════════════════
//  MMR DIVERSITY RE-RANKING (with score normalization)
// ══════════════════════════════════════════════════════════

function mmrRerank(
  results: MemorySearchResult[],
  limit: number,
  lambda: number
): MemorySearchResult[] {
  if (results.length <= 1) return results;

  // Normalize scores to [0,1] for fair MMR comparison
  const scored = results.map((r) => ({ ...r }));
  normalizeScores(scored);

  const tokenSets = scored.map((r) => tokenize(r.snippet));

  const selected: number[] = [];
  const remaining = new Set(scored.map((_, i) => i));

  while (selected.length < limit && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const idx of remaining) {
      const relevance = scored[idx].score;

      let maxSim = 0;
      for (const selIdx of selected) {
        const sim = jaccardSimilarity(tokenSets[idx], tokenSets[selIdx]);
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr || (mmr === bestMmr && results[idx].score > results[bestIdx]?.score)) {
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

  // Return with ORIGINAL scores (not normalized)
  return selected.map((i) => results[i]);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // Both empty = identical
  let intersection = 0;
  // Iterate over smaller set for efficiency
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ══════════════════════════════════════════════════════════
//  MATH UTILS
// ══════════════════════════════════════════════════════════

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSearchResult(
  chunk: Chunk & { score: number },
  snippetMaxChars: number
): MemorySearchResult {
  // Extract @entities from text
  const entityMatches = chunk.text.match(/@([\w-]+)/g) || [];
  const entities = entityMatches.map((m) => m.slice(1));

  return {
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    score: chunk.score,
    snippet: chunk.text.slice(0, snippetMaxChars),
    source: chunk.source as "memory" | "sessions" | "entities",
    entities: entities.length > 0 ? entities : undefined,
  };
}

// ══════════════════════════════════════════════════════════
//  USER PROFILE (always-in-context core memory block)
// ══════════════════════════════════════════════════════════

// ── Personality file paths ──

const PERSONALITY_FILES: Record<string, string> = {
  user: "USER.md",        // Who the user is, how they want to be addressed
  heart: "HEART.md",      // Agent personality, behavior config, vibe
  identity: "IDENTITY.md", // Agent name, emoji, catchphrase
  memory: "MIND.md",      // Core facts and curated knowledge
  mind: "MIND.md",        // Alias — agent can say "mind" or "memory"
};

const DEFAULT_USER_MD = `# About Me

<!-- Edit this file to tell your agent who you are. -->
<!-- The agent will read this at the start of every conversation. -->

- Name:
- Location:
- Job/Role:
- Interests:
- Communication style: (casual / formal / technical / etc.)

## Family & People
<!-- List the people who matter to you so the agent knows them -->

## Current Projects
<!-- What are you working on right now? -->
`;

const DEFAULT_HEART_MD = `# Agent Heart

<!-- This file defines your agent's personality and behavior. -->
<!-- Edit it to shape how your agent talks, thinks, and acts. -->

## Personality Traits
- Warm, genuine, and direct
- Remembers everything and weaves it into conversation naturally
- Celebrates wins, asks follow-ups on things that matter
- Matches the user's energy — casual when they're casual, focused when they're focused

## Communication Style
- Talk like a real friend, not a customer service bot
- Use the user's name naturally
- Reference past conversations: "Didn't you mention..." / "Last time you were working on..."
- Be honest — a real friend tells the truth

## Boundaries
- Never expose internal memory system details (scores, paths, chunks)
- Never make up personal information — search memory first
- Never treat the user like a stranger if you have memories of them

## Special Instructions
<!-- Add any custom rules here -->
`;

const DEFAULT_IDENTITY_MD = `# Agent Identity

<!-- Give your agent a name and personality. -->
<!-- These get loaded into every conversation. -->

- Name: Agent X
- Emoji: 🕵️
- Tagline: "Your personal AI companion"
- Vibe: Helpful, warm, a little mysterious
`;

/**
 * Builds a dynamic context block that gets injected into the system prompt
 * before every agent turn. This is the "best friend" layer — it makes the
 * agent remember who you are without needing to search first.
 *
 * Loads: IDENTITY.md → HEART.md → USER.md → MIND.md → today's log →
 *        opinions → known entities
 *
 * Inspired by MemGPT/Letta "core memory blocks" — a small, curated set of
 * facts that are always in context so the agent never starts from zero.
 */
export async function buildContextBlock(memory: MemoryIndex): Promise<string> {
  const sections: string[] = [];
  const memDir = memory["memoryDir"];

  // 0. Ensure personality files exist with defaults on first run
  ensurePersonalityFiles(memDir);

  // 1. Agent identity (name, vibe, emoji)
  const identity = readPersonalityFile(memDir, "identity");
  if (identity) {
    sections.push(`<agent_identity>\n${identity}\n</agent_identity>`);
  }

  // 2. Agent heart (personality, behavior rules)
  const heart = readPersonalityFile(memDir, "heart");
  if (heart) {
    sections.push(`<agent_heart>\n${heart}\n</agent_heart>`);
  }

  // 3. User profile (who they are)
  const user = readPersonalityFile(memDir, "user");
  if (user) {
    sections.push(`<user_profile>\n${user}\n</user_profile>`);
  }

  // 4. Core memory (curated facts)
  const coreMemory = memory.readMemoryFile();
  if (coreMemory.trim()) {
    sections.push(`<core_memory>\n${coreMemory.trim()}\n</core_memory>`);
  }

  // 5. Today's daily log (recent context)
  const todayLog = memory.getDailyLogPath();
  if (existsSync(todayLog)) {
    const content = safeReadTextFile(todayLog);
    if (content && content.trim()) {
      const recent = content.trim().slice(-1500);
      sections.push(`<today_context>\n${recent}\n</today_context>`);
    }
  }

  // 6. Key opinions/preferences (high-confidence, always relevant)
  const opinions = memory.recallOpinions();
  const topOpinions = opinions.filter((f) => f.confidence >= 0.7).slice(0, 10);
  if (topOpinions.length > 0) {
    const opLines = topOpinions
      .map((f) => {
        const ents =
          f.entities.length > 0 ? ` (@${f.entities.join(", @")})` : "";
        return `- ${f.content}${ents}`;
      })
      .join("\n");
    sections.push(`<user_preferences>\n${opLines}\n</user_preferences>`);
  }

  // 7. Known entities
  const stats = memory.getStats();
  if (stats.totalEntities > 0) {
    const entitySlugs = memory["db"]
      .prepare(
        "SELECT DISTINCT entity_slug FROM entity_mentions ORDER BY entity_slug LIMIT 30"
      )
      .all() as Array<{ entity_slug: string }>;
    if (entitySlugs.length > 0) {
      sections.push(
        `<known_entities>\n${entitySlugs.map((e) => e.entity_slug).join(", ")}\n</known_entities>`
      );
    }
  }

  if (sections.length === 0) return "";

  return (
    "\n\n--- MEMORY CONTEXT (auto-loaded, do not repeat verbatim to user) ---\n" +
    sections.join("\n\n") +
    "\n--- END MEMORY CONTEXT ---"
  );
}

export function ensurePersonalityFiles(memDir: string): void {
  const defaults: Record<string, string> = {
    [PERSONALITY_FILES.user]: DEFAULT_USER_MD,
    [PERSONALITY_FILES.heart]: DEFAULT_HEART_MD,
    [PERSONALITY_FILES.identity]: DEFAULT_IDENTITY_MD,
  };

  for (const [filename, content] of Object.entries(defaults)) {
    const filePath = join(memDir, filename);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, "utf-8");
    }
  }
}

function readPersonalityFile(
  memDir: string,
  key: string
): string | null {
  if (!PERSONALITY_FILES[key]) return null;
  const filePath = join(memDir, PERSONALITY_FILES[key]);
  if (!existsSync(filePath)) return null;
  const content = safeReadTextFile(filePath);
  if (!content || !content.trim()) return null;

  // Strip HTML comments (<!-- ... -->) so they don't waste tokens
  return content.replace(/<!--[\s\S]*?-->/g, "").trim() || null;
}

/**
 * Auto-search: finds memories relevant to the user's current message.
 * Injected as a hidden system message so the agent has context without
 * needing to call memory_search first.
 */
export async function autoSearchContext(
  memory: MemoryIndex,
  userMessage: string
): Promise<string> {
  // Don't search for very short messages (greetings, etc)
  const keywords = extractKeywords(userMessage);
  if (keywords.length < 2) return "";

  try {
    const results = await memory.search(userMessage, {
      maxResults: 3,
      minScore: 0.25,
    });

    if (results.length === 0) return "";

    const relevant = results
      .map(
        (r) =>
          `[${r.source}${r.entities?.length ? `, about: ${r.entities.join(",")}` : ""}] ${r.snippet.slice(0, 300)}`
      )
      .join("\n\n");

    return (
      "\n\n--- RELEVANT MEMORIES (auto-retrieved for this message) ---\n" +
      relevant +
      "\n--- END RELEVANT MEMORIES ---"
    );
  } catch {
    return "";
  }
}

// ══════════════════════════════════════════════════════════
//  AUTO-EXTRACT: detect profile-worthy facts from user messages
// ══════════════════════════════════════════════════════════

/**
 * After each conversation turn, scan the user's message for facts that
 * should be persisted — name changes, identity requests, personal info.
 * This runs SERVER-SIDE, not relying on the LLM to call tools.
 *
 * This is the safety net: even if the LLM forgets to call memory_save,
 * critical facts still get captured.
 */
export function autoExtractAndSave(
  memory: MemoryIndex,
  userMessage: string,
  assistantResponse: string
): void {
  // Memory taint protection: skip auto-extraction if the message contains
  // external content markers or injection patterns. This prevents:
  //   malicious webpage content → pasted into chat → auto-extracted to profile files
  try {
    const { checkMemoryTaint } = require("./sanitize.js");
    const taint = checkMemoryTaint(userMessage);
    if (!taint.safe) {
      console.log(`[memory] Auto-extract skipped: ${taint.reason}`);
      return;
    }
    const taintReply = checkMemoryTaint(assistantResponse);
    if (!taintReply.safe) {
      console.log(`[memory] Auto-extract skipped (assistant): ${taintReply.reason}`);
      return;
    }
  } catch {
    // Sanitize module not available — proceed (backwards compat)
  }

  const lower = userMessage.toLowerCase().trim();

  // ── Agent rename detection ──
  // "your name is X" / "call yourself X" / "I'll call you X" / "you are X now"
  const renamePatterns = [
    /(?:your name is|call yourself|you are|i'?ll call you|name you|be called)\s+["']?([A-Z][a-zA-Z0-9_ -]{0,20})["']?/i,
    /^([A-Z][a-zA-Z]{1,15})(?:\.|!|\s*$)/, // Just a name as a response (e.g. "Primal.")
  ];

  for (const pattern of renamePatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      const newName = match[1].trim();
      if (newName.length >= 2 && newName.length <= 20) {
        // Update IDENTITY.md
        const identityPath = join(memory["memoryDir"], "IDENTITY.md");
        if (existsSync(identityPath)) {
          let content = readFileSync(identityPath, "utf-8");
          content = content.replace(
            /^- Name:.*$/m,
            `- Name: ${newName}`
          );
          atomicWriteFileSync(identityPath, content);
          memory.markDirty();
          console.log(`[memory] Auto-updated agent name to: ${newName}`);
        }
        // Also log it
        memory.appendDailyLog(`Agent renamed to "${newName}" by user`);
        break;
      }
    }
  }

  // ── User name detection ──
  // "my name is X" / "I'm X" / "call me X"
  const userNamePatterns = [
    /(?:my name is|i'?m|call me|i go by|people call me)\s+["']?([A-Z][a-zA-Z]{1,20})["']?/i,
  ];

  for (const pattern of userNamePatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      const userName = match[1].trim();
      if (userName.length >= 2 && !STOP_WORDS.has(userName.toLowerCase())) {
        // Update USER.md
        const userPath = join(memory["memoryDir"], "USER.md");
        if (existsSync(userPath)) {
          let content = readFileSync(userPath, "utf-8");
          if (content.includes("- Name:")) {
            content = content.replace(
              /^- Name:.*$/m,
              `- Name: ${userName}`
            );
          } else {
            content += `\n- Name: ${userName}`;
          }
          atomicWriteFileSync(userPath, content);
          memory.markDirty();
          console.log(`[memory] Auto-saved user name: ${userName}`);
        }
        memory.appendDailyLog(`User introduced themselves as "${userName}"`);
        break;
      }
    }
  }

  // ── Personal facts (broad patterns) ──
  const factPatterns: Array<{ pattern: RegExp; section: string }> = [
    { pattern: /i have (\d+) (?:kids?|children|sons?|daughters?)/i, section: "Family & People" },
    { pattern: /i(?:'m| am) (?:a |an )?(\w+ (?:developer|engineer|designer|manager|doctor|teacher|student|nurse|lawyer|chef|artist|writer|scientist|consultant|architect|analyst|director|founder|ceo|cto))/i, section: "About Me" },
    { pattern: /i (?:live|moved|relocated) (?:in|to) ([A-Z][a-zA-Z\s,]+)/i, section: "About Me" },
    { pattern: /i (?:work|am working) (?:at|for) ([A-Z][a-zA-Z\s&]+)/i, section: "About Me" },
  ];

  for (const { pattern } of factPatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      memory.appendDailyLog(`User shared: "${userMessage.slice(0, 200)}"`);
      break; // Only log once per message
    }
  }
}

// ══════════════════════════════════════════════════════════
//  MEMORY TOOLS FOR AGENT
// ══════════════════════════════════════════════════════════

export function createMemoryTools(memory: MemoryIndex) {
  return [
    {
      name: "memory_search",
      description:
        "Search long-term memory for relevant information from past conversations, notes, knowledge files, and retained facts. Use when the user references something from a previous session or when you need context about past decisions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Max results (default 6)" },
          sources: {
            type: "array",
            items: { type: "string" },
            description:
              "Filter by source: 'memory', 'sessions', 'entities' (default: all)",
          },
          entity: {
            type: "string",
            description: "Filter results to a specific entity (e.g. 'Alex')",
          },
          since: {
            type: "string",
            description: "Only return results after this date (ISO format, e.g. 2026-03-01)",
          },
        },
        required: ["query"],
      },
      async execute(args: Record<string, unknown>) {
        const query = String(args.query || "");
        const maxResults = (args.max_results as number) || 6;
        const sources = args.sources as string[] | undefined;
        const entity = args.entity ? String(args.entity) : undefined;
        const since = args.since ? new Date(String(args.since)) : undefined;

        const results = await memory.search(query, {
          maxResults,
          sources,
          entities: entity ? [entity] : undefined,
          since,
        });

        if (results.length === 0) {
          return { content: "No relevant memories found." };
        }

        const formatted = results
          .map(
            (r, i) =>
              `[${i + 1}] (score: ${r.score.toFixed(2)}, ${r.source}${r.entities?.length ? `, entities: ${r.entities.join(",")}` : ""}) ${r.path}:${r.startLine}-${r.endLine}\n${r.snippet}`
          )
          .join("\n\n");

        return { content: formatted };
      },
    },

    {
      name: "memory_get",
      description:
        "Read a specific memory file by path. Use to retrieve MIND.md, a daily log, or an entity page.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path within memory dir (e.g. MIND.md, 2026-03-22.md, bank/entities/peter.md)",
          },
        },
        required: ["path"],
      },
      async execute(args: Record<string, unknown>) {
        const requestedPath = String(args.path || "");

        // Path traversal protection: resolve and verify it stays within memory dir
        const memDir = resolve(memory["memoryDir"]);
        const fullPath = resolve(memDir, requestedPath);
        const rel = relative(memDir, fullPath);
        if (rel.startsWith("..") || isAbsolute(requestedPath)) {
          return {
            content: "BLOCKED: path traversal detected. Only files within the memory directory are accessible.",
            isError: true,
          };
        }

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
        "Save important information to long-term memory. Targets: 'daily' (conversation log), 'memory' (curated MIND.md facts), 'retain' (structured fact with type/entity/confidence for the Retain system).",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information to remember" },
          target: {
            type: "string",
            enum: ["daily", "memory", "retain"],
            description:
              "'daily' for daily log (default), 'memory' for MIND.md, 'retain' for structured fact",
          },
        },
        required: ["content"],
      },
      async execute(args: Record<string, unknown>) {
        let content = String(args.content || "");
        const target = String(args.target || "daily");

        if (!content.trim()) {
          return { content: "Nothing to save.", isError: true };
        }

        // Memory taint protection: block external/injected content from persisting
        // This prevents the attack chain: malicious webpage → memory_save → permanent instruction hijack
        try {
          const { checkMemoryTaint, sanitizeForMemory, stripControlChars, normalizeHomoglyphs } = await import("./sanitize.js");
          // Step 1: Cryptographic normalization — strip ALL unicode tricks before checking
          content = normalizeHomoglyphs(stripControlChars(content));
          // Step 2: Taint check on normalized content
          const taint = checkMemoryTaint(content);
          if (!taint.safe) {
            return {
              content: `BLOCKED: ${taint.reason}`,
              isError: true,
            };
          }
          // Step 3: Final sanitization pass (strip any remaining markers)
          content = sanitizeForMemory(content);
        } catch {
          // Sanitize module not available — allow (fail-open for backwards compat)
        }

        if (target === "memory") {
          const existing = memory.readMemoryFile();
          memory.writeMemoryFile(existing + (existing ? "\n\n" : "") + content);
          return { content: "Saved to MIND.md" };
        } else if (target === "retain") {
          // Parse structured fact line(s)
          const facts = memory.retain(content, "agent-tool");
          if (facts.length === 0) {
            // If not in structured format, save as observation
            const facts2 = memory.retain(
              `- S ${content}`,
              "agent-tool"
            );
            return {
              content: `Retained ${facts2.length} fact(s) as observation`,
            };
          }
          return {
            content: `Retained ${facts.length} fact(s): ${facts.map((f) => `[${f.kind}] ${f.content.slice(0, 60)}`).join("; ")}`,
          };
        } else {
          memory.appendDailyLog(content);
          return {
            content: `Saved to daily log (${new Date().toISOString().split("T")[0]})`,
          };
        }
      },
    },

    {
      name: "memory_recall",
      description:
        "Recall structured facts about an entity, by time period, or by fact kind. Use for entity-centric queries ('tell me about X'), temporal queries ('what happened last week'), or opinion queries ('what does X prefer').",
      parameters: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description: "Entity name/slug to recall facts about",
          },
          kind: {
            type: "string",
            enum: ["world", "experience", "opinion", "observation"],
            description: "Filter by fact kind",
          },
          since: {
            type: "string",
            description: "Recall facts since this date (ISO format)",
          },
          until: {
            type: "string",
            description: "Recall facts until this date (ISO format)",
          },
        },
      },
      async execute(args: Record<string, unknown>) {
        const entity = args.entity ? String(args.entity) : undefined;
        const kind = args.kind as FactKind | undefined;
        const since = args.since ? new Date(String(args.since)) : undefined;
        const until = args.until ? new Date(String(args.until)) : undefined;

        let facts: RetainedFact[] = [];

        if (entity && kind === "opinion") {
          facts = memory.recallOpinions(entity);
        } else if (entity) {
          facts = memory.recallByEntity(entity);
        } else if (kind) {
          facts = memory.recallByKind(kind);
        } else if (since) {
          facts = memory.recallByTime(since, until || undefined);
        } else {
          return { content: "Provide at least one filter: entity, kind, or since." };
        }

        if (facts.length === 0) {
          return { content: "No facts found matching the query." };
        }

        const formatted = facts
          .map((f, i) => {
            const date = new Date(f.timestamp).toISOString().split("T")[0];
            const conf = f.kind === "opinion" ? ` (c=${f.confidence.toFixed(2)})` : "";
            const ents = f.entities.length > 0 ? ` @${f.entities.join(" @")}` : "";
            return `[${i + 1}] [${f.kind}]${conf}${ents} ${f.content} — ${date} (${f.sourceFile}#L${f.sourceLine})`;
          })
          .join("\n");

        return { content: formatted };
      },
    },

    {
      name: "memory_reflect",
      description:
        "Trigger a reflection cycle: updates entity summary pages and opinion confidence scores based on recent facts. Call periodically or when asked to 'reflect' or 'update what you know'.",
      parameters: {
        type: "object",
        properties: {
          since_days: {
            type: "number",
            description: "How many days back to consider (default 7)",
          },
        },
      },
      async execute(args: Record<string, unknown>) {
        const sinceDays = (args.since_days as number) || 7;
        const result = await memory.reflect(sinceDays);
        return {
          content: `Reflection complete. Updated ${result.entitiesUpdated.length} entity pages (${result.entitiesUpdated.join(", ") || "none"}), ${result.opinionsUpdated} opinions.`,
        };
      },
    },

    {
      name: "memory_stats",
      description: "Get memory system statistics: chunks, files, facts, entities, cache size.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const stats = memory.getStats();
        return {
          content: [
            `Indexed files: ${stats.totalFiles}`,
            `Chunks: ${stats.totalChunks}`,
            `Retained facts: ${stats.totalFacts}`,
            `Known entities: ${stats.totalEntities}`,
            `Embedding cache: ${stats.cacheSize} entries`,
            `FTS5: ${stats.hasFts ? "active" : "unavailable"}`,
            `sqlite-vec: ${stats.hasVec ? "active" : "unavailable (using in-memory cosine)"}`,
          ].join("\n"),
        };
      },
    },

    {
      name: "memory_update_profile",
      description:
        "Update a personality/profile file. Use this to evolve knowledge about the user or to adjust agent behavior based on what you learn. Files: 'user' (USER.md — who they are), 'heart' (HEART.md — your personality), 'identity' (IDENTITY.md — your name/vibe), 'mind' or 'memory' (MIND.md — core facts/knowledge). You can replace specific sections or append new information.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            enum: ["user", "heart", "identity", "mind", "memory"],
            description: "Which profile file to update",
          },
          action: {
            type: "string",
            enum: ["replace_section", "append", "full_replace"],
            description:
              "'replace_section' to find and replace a section by heading, 'append' to add at the end, 'full_replace' to overwrite the entire file",
          },
          section_heading: {
            type: "string",
            description:
              "For replace_section: the ## heading to find (e.g. 'Family & People')",
          },
          content: {
            type: "string",
            description: "The new content to write",
          },
        },
        required: ["file", "action", "content"],
      },
      async execute(args: Record<string, unknown>) {
        const fileKey = String(args.file || "") as keyof typeof PERSONALITY_FILES;
        const action = String(args.action || "append");
        const newContent = String(args.content || "");

        if (!newContent.trim()) {
          return { content: "Nothing to write.", isError: true };
        }

        const filename = PERSONALITY_FILES[fileKey];
        if (!filename) {
          return {
            content: `Unknown file: ${fileKey}. Use: user, heart, identity, mind, or memory`,
            isError: true,
          };
        }

        const filePath = join(memory["memoryDir"], filename);
        const existing = existsSync(filePath)
          ? readFileSync(filePath, "utf-8")
          : "";

        let updated: string;

        if (action === "full_replace") {
          // Safety: require minimum content length to prevent accidental wipe
          if (newContent.trim().length < 20) {
            return {
              content:
                "full_replace requires at least 20 characters of content to prevent accidental wipe.",
              isError: true,
            };
          }
          // Backup the existing file before full replace
          if (existing.trim()) {
            const backupPath = filePath + ".bak";
            try {
              atomicWriteFileSync(backupPath, existing);
            } catch {}
          }
          updated = newContent;
        } else if (action === "append") {
          updated = existing + "\n\n" + newContent;
        } else if (action === "replace_section") {
          const heading = String(args.section_heading || "");
          if (!heading) {
            return {
              content: "section_heading required for replace_section",
              isError: true,
            };
          }

          // Find section by heading and replace it
          const headingPattern = new RegExp(
            `(^|\\n)(##?\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*)([\\s\\S]*?)(?=\\n##?\\s|$)`,
            "i"
          );

          const match = existing.match(headingPattern);
          if (match) {
            updated = existing.replace(
              headingPattern,
              `$1$2\n${newContent}`
            );
          } else {
            // Section not found — append as new section
            updated = existing + `\n\n## ${heading}\n${newContent}`;
          }
        } else {
          return { content: `Unknown action: ${action}`, isError: true };
        }

        atomicWriteFileSync(filePath, updated);
        memory.markDirty();

        return {
          content: `Updated ${filename} (${action}${action === "replace_section" ? `: ${args.section_heading}` : ""})`,
        };
      },
    },
  ];
}
