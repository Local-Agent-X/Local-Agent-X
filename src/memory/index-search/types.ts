import type Database from "better-sqlite3";
import type { EmbeddingProvider, FactKind, MemoryConfig } from "../types.js";

export interface SearchOptions {
  maxResults?: number;
  minScore?: number;
  sources?: string[];
  entities?: string[];
  since?: Date;
  kind?: FactKind;
  project?: string;
  sourceType?: string;
  dateFrom?: string;
  dateTo?: string;
  rerank?: boolean;
  rerankModel?: string;
  sessionId?: string;
  /**
   * Cross-session opt-in. Default false. When false, profile sources are
   * eligible plus session-scoped chunks whose stored session_id exactly
   * matches a provided sessionId. NULL/unknown IDs fail closed. When true,
   * all sessions are searched and applySessionGrouping is applied.
   *
   * Auto-inject paths (buildTurnContext, autoSearchContext) leave this false
   * to prevent cross-session bleed. The `search_past_sessions` tool sets it
   * true so the model explicitly opts in when it wants historical context.
   */
  crossSession?: boolean;
  /**
   * The project this search is for. Its documents (source "project-doc") are
   * eligible; every other project's are not, cross-session or not. Absent,
   * no project document is eligible.
   */
  projectId?: string;
  hyde?: boolean;
  hydeProvider?: "ollama" | "anthropic" | "openai" | "auto";
  hydeModel?: string;
}

export interface SearchDeps {
  db: InstanceType<typeof Database>;
  embeddingProvider: EmbeddingProvider | null;
  config: MemoryConfig;
  hasFts: boolean;
  sync: () => Promise<void>;
}
