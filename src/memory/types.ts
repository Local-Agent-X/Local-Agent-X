/**
 * Memory system — shared types, interfaces, and defaults.
 *
 * All cross-file types live here so modules can share them without
 * circular imports. Public types are re-exported from src/memory.ts.
 */

// ── Configuration ──

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
  candidateMultiplier: 8,
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

// ── Search / chunk types ──

/**
 * Canonical source values written to chunks.source. Replaces the old
 * "memory"/"sessions"/"entities" trio with a finer split so search filters
 * can target one store at a time.
 *
 *   entity          — bank/entities/<slug>.md
 *   daily-log       — YYYY-MM-DD.md
 *   mind            — MIND.md
 *   session-summary — session-summaries/<id>.md
 *   session         — raw session JSON (~/.lax/sessions/<id>.json)
 *   personality     — USER.md / HEART.md / other memory-root files
 *   import          — ChatGPT / Claude / Slack imports
 */
export type CanonicalSource =
  | "entity"
  | "daily-log"
  | "mind"
  | "session-summary"
  | "session"
  | "personality"
  | "import";

export const CANONICAL_SOURCES: readonly CanonicalSource[] = [
  "entity", "daily-log", "mind", "session-summary",
  "session", "personality", "import",
] as const;

/**
 * Memory scope classification (upstream `MemorySource` equivalent). Profile-
 * scope content describes the user as a stable entity and is safe to surface
 * in any session. Session-scope content is bound to a specific conversation
 * and must NOT auto-leak across sessions — only via the explicit
 * `search_past_sessions` tool.
 */
export type MemoryScope = "profile" | "session";

const SOURCE_SCOPE: Record<CanonicalSource, MemoryScope> = {
  "entity": "profile",
  // daily-log is date-keyed, not session-keyed — across-session conversation
  // transcripts get aggregated into one file per day. The buildContextBlock
  // path now filters today's daily log to current-session lines only via
  // [sessionId] tagging, but at the SEARCH layer we treat it as session-
  // scope so cross-session retrieval still requires explicit opt-in.
  "daily-log": "session",
  "mind": "profile",
  "personality": "profile",
  "import": "profile",
  "session-summary": "session",
  "session": "session",
};

export function scopeOf(source: CanonicalSource): MemoryScope {
  return SOURCE_SCOPE[source];
}

export const PROFILE_SOURCES: readonly CanonicalSource[] = (Object.entries(SOURCE_SCOPE)
  .filter(([, s]) => s === "profile")
  .map(([k]) => k) as CanonicalSource[]);

export const SESSION_SOURCES: readonly CanonicalSource[] = (Object.entries(SOURCE_SCOPE)
  .filter(([, s]) => s === "session")
  .map(([k]) => k) as CanonicalSource[]);

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: CanonicalSource;
  entities?: string[];
  kind?: FactKind;
  metadata?: ChunkMetadata;
}

export interface ChunkMetadata {
  project?: string;
  topic?: string;
  date?: string;
  source_type?: "agent-x-session" | "chatgpt-import" | "claude-import" | "codex-import" | "slack-import" | "memory-file" | "entity-page" | "import";
  session_id?: string;
}

export interface Chunk {
  id?: number;
  path: string;
  source: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embedding?: number[];
  metadata?: ChunkMetadata;
}

export interface FileRecord {
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

// ── Facts / entities types ──

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
  // Bi-temporal validity (Zep-style). Facts with valid_to != null are superseded.
  validFrom?: number;
  validTo?: number | null;
  invalidatedBy?: number | null;
  invalidationReason?: string | null;
}

export interface EntityPage {
  slug: string;
  displayName: string;
  summary: string;
  facts: RetainedFact[];
  lastReflected: number;
}
