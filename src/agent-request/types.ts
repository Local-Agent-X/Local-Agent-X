import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, LAXConfig } from "../types.js";
import type { MemoryIndex, MemoryManager } from "../memory.js";
import type { IntegrationRegistry } from "../integrations.js";
import type { SecretsStore } from "../secrets.js";

export type ChannelKind = "web" | "telegram" | "whatsapp" | "cron" | "agent";

export interface AgentRequestInput {
  /** Which entry point is calling */
  channel: ChannelKind;
  /** The user's message */
  message: string;
  /** Session messages (raw, will be sanitized) */
  sessionMessages: ChatCompletionMessageParam[];
  /** Session ID for the agent run */
  sessionId: string;
  /** App config */
  config: LAXConfig;
  /** Data directory (~/.lax) */
  dataDir: string;
  /** Memory index for context building */
  memoryIndex: MemoryIndex;
  /** High-level memory facade (per-turn context, persistence, search). */
  memoryManager: MemoryManager;
  /** Integration registry for API context */
  integrations: IntegrationRegistry;
  /** Secrets store for API key lookups */
  secretsStore: SecretsStore;
  /** Full tool set (web chat) */
  allAgentTools: ToolDefinition[];
  /** Slimmed tool set (bridges, Codex) */
  bridgeTools: ToolDefinition[];
  /** Skip heavy memory orchestrator (bridges, cron) */
  skipMemory?: boolean;
  /** Override system prompt (sub-agents) */
  systemPromptOverride?: string;
  /** Max messages to keep in history (default 30 for bridges, 40 for web) */
  maxHistory?: number;
  /** Bridge-specific context string (platform, channel, formatting rules) */
  bridgeContext?: string;
  /** Image attachments */
  attachments?: Array<{ isImage: boolean; url: string; name: string }>;
  /** Uploads directory for resolving attachment paths */
  uploadsDir?: string;
  /**
   * Frozen summary written by /api/compact. When present and matched by
   * compactedAt, prepare-request prepends it as a leading system message and
   * trims the older history below the compaction cut. Lets long sessions
   * survive without re-summarizing on every turn.
   */
  compactedSummary?: string;
  /** Index in sessionMessages at which the compaction was applied. */
  compactedAt?: number;
}

export interface PreparedAgentRequest {
  provider: string;
  apiKey: string;
  model: string;
  codexApiKey?: string;
  customBaseURL?: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  cleanHistory: ChatCompletionMessageParam[];
  images: Array<{ url: string; filePath?: string; name: string }>;
  temperature: number;
  maxIterations: number;
}
