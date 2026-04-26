export type {
  MemoryConfig, MemorySearchResult, ChunkMetadata, EmbeddingProvider,
  FactKind, RetainedFact, EntityPage, CanonicalSource,
} from "./memory/types.js";
export { DEFAULT_MEMORY_CONFIG, CANONICAL_SOURCES } from "./memory/types.js";
export { SessionStore } from "./memory/session-store.js";
export { ensurePersonalityFiles } from "./memory/personality.js";
export { createMemoryTools } from "./memory/tools.js";
export { MemoryIndex } from "./memory/index-core.js";
export { buildContextBlock, autoSearchContext } from "./memory/context.js";
export { autoExtractAndSave } from "./memory/auto-extract.js";
export { MemoryManager } from "./memory/manager.js";
export type {
  TurnContextInput, TurnContext, PersistTurnInput, RecallBy,
} from "./memory/manager.js";
