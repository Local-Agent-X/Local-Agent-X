import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ── Agent Types ──

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
  /** Tool only reads state, never mutates. Eligible for parallel batching. */
  readOnly?: boolean;
  /** Explicit opt-in to parallel execution alongside adjacent concurrent-safe tools. */
  concurrencySafe?: boolean;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentTurn {
  messages: ChatCompletionMessageParam[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  stopReason: "end_turn" | "max_iterations" | "abort" | "error";
  /** When stopReason is "error", the provider's error message — used by the
   * chat route to decide whether the error is transient (rate limit, auth,
   * overload) and eligible for failover to another provider. */
  errorMessage?: string;
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
  | { type: "tool_start"; toolName: string; toolCallId?: string; args: unknown; riskLevel?: "low" | "medium" | "high"; context?: string; requiresApproval?: boolean }
  | { type: "tool_progress"; toolName: string; toolCallId?: string; message: string }
  | { type: "tool_end"; toolName: string; toolCallId?: string; result: string; allowed: boolean }
  | { type: "done"; usage: AgentTurn["usage"] }
  | { type: "error"; message: string }
  | { type: "secret_request"; name: string; service?: string; reason: string }
  | { type: "approval_requested"; approvalId: string; toolName: string; toolCallId?: string; context: string; argsPreview: string }
  | { type: "approval_timeout"; approvalId: string; toolName: string; toolCallId?: string }
  | { type: "context_status"; percentage: number; level: string; usedTokens: number; maxTokens: number; compacted: boolean }
  | { type: "visual"; kind: "emoji" | "text" | "shape" | "mood"; value: string; durationMs: number }
  | { type: "bg_op_started"; opId: string; task: string; provider: string }
  | { type: "bg_op_completed"; opId: string; status: "completed" | "failed" | "cancelled"; summary: string; filesChanged: string[] };

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

export interface LAXConfig {
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

  /** Browser session mode. "isolated" = dedicated agent profile (safer).
   *  "attach" = your real Chrome profile, requires Chrome closed. */
  browserMode: "isolated" | "attach";

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

  /** When true (default), voice mode exposes the `voice_visual` tool to
   *  the LLM so it can morph the particle sphere into emojis/text/shapes/
   *  moods during emotionally significant moments. Off = strict no-tools
   *  voice mode (existing behavior). Hot-reloads via the config watcher. */
  voice_visuals_enabled?: boolean;
}
