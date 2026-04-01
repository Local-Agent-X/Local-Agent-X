import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ── Agent Types ──

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface AgentTurn {
  messages: ChatCompletionMessageParam[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  stopReason: "end_turn" | "max_iterations" | "abort" | "error";
}

// ── Security Types ──

export interface SecurityDecision {
  allowed: boolean;
  reason: string;
  quarantined?: boolean;
}

// ── Session Types ──

export interface Session {
  id: string;
  title: string;
  messages: ChatCompletionMessageParam[];
  createdAt: number;
  updatedAt: number;
  /** Summary of compacted (older) messages */
  compactedSummary?: string;
  /** Index at which compaction was applied */
  compactedAt?: number;
  /** Session ID this session was forked from */
  forkedFrom?: string;
  /** Message index at which the fork was taken */
  forkAtIndex?: number;
}

// ── Server Types ──

export type ServerEvent =
  | { type: "stream"; delta: string }
  | { type: "tool_start"; toolName: string; args: unknown; riskLevel?: "low" | "medium" | "high"; context?: string; requiresApproval?: boolean }
  | { type: "tool_end"; toolName: string; result: string; allowed: boolean }
  | { type: "done"; usage: AgentTurn["usage"] }
  | { type: "error"; message: string }
  | { type: "secret_request"; name: string; service?: string; reason: string }
  | { type: "context_status"; percentage: number; level: string; usedTokens: number; maxTokens: number; compacted: boolean };

// ── Auth Types ──

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// ── Deployment Profile Types ──

export type DeploymentProfile = "home" | "dev" | "enterprise";

export interface ProfileDefaults {
  sandboxMode: "host" | "docker";
  toolApproval: "auto" | "confirm-risky" | "confirm-all";
  retentionDays: number;
  autoUpdate: boolean;
  networkExposure: "localhost" | "lan" | "public";
  logLevel: "basic" | "detailed" | "full-audit";
}

// ── Config Types ──

export interface SAXConfig {
  port: number;
  authToken: string;
  workspace: string;
  openaiApiKey?: string;
  model: string;
  maxIterations: number;
  temperature: number;
  systemPrompt: string;
  profile: DeploymentProfile;
  toolApproval: "auto" | "confirm-risky" | "confirm-all";
  retentionDays: number;
  autoUpdate: boolean;
  logLevel: "basic" | "detailed" | "full-audit";
  ariRequired?: boolean;

  // ── Externalized service URLs ──
  ollamaUrl: string;
  sdServerUrl: string;
  videoServerUrl: string;
  xttsServerUrl: string;

  // ── Externalized limits & timeouts ──
  browserCdpPort: number;
  browserIdleTimeoutMs: number;
  rateLimitMax: number;
  rateLimitRefillPerSec: number;
  maxRequestBodyBytes: number;
  maxUploadBytes: number;
  maxAudioBytes: number;
  authMaxFailures: number;
  authLockoutMs: number;
  agentTimeoutMs: number;
  maxCachedSessions: number;
}
