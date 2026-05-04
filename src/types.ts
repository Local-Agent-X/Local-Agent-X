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
  // Out-of-band notice that the turn stopped early (middleware abort,
  // wall-clock ceiling, stale evidence, loop detection, etc.). The UI
  // renders this as a small inline note BELOW the message, NOT as
  // appended message body — keeps technical jargon out of chat content
  // and out of persisted message history. `reason` is the user-friendly
  // one-liner; `debug` is the original technical text for diagnostics.
  | { type: "stopped"; reason: string; debug?: string; firedBy?: string }
  | { type: "error"; message: string }
  | { type: "secret_request"; name: string; service?: string; reason: string }
  | { type: "secrets_request"; secrets: Array<{ name: string; service?: string; reason: string }> }
  | { type: "approval_requested"; approvalId: string; toolName: string; toolCallId?: string; context: string; argsPreview: string }
  | { type: "approval_timeout"; approvalId: string; toolName: string; toolCallId?: string }
  | { type: "context_status"; percentage: number; level: string; usedTokens: number; maxTokens: number; compacted: boolean }
  | { type: "visual"; kind: "emoji" | "text" | "shape" | "mood"; value: string; durationMs: number }
  | { type: "bg_op_queued"; opId: string; task: string; provider: string; lane: string; queuePosition: number }
  | { type: "bg_op_queue_reordered"; opId: string; queuePosition: number }
  | { type: "bg_op_started"; opId: string; task: string; provider: string }
  | { type: "bg_op_progress"; opId: string; line: string }
  | { type: "bg_op_completed"; opId: string; status: "completed" | "failed" | "cancelled"; summary: string; filesChanged: string[] }
  | { type: "bg_op_nudge"; opIds: string[]; text: string }
  // Worker narration → main chat thread (Step 1 of JARVIS-mode roadmap).
  // The worker's own LLM text deltas, surfaced as a distinct message bubble
  // in chat (not just the sidebar progress trace) so the user sees what the
  // worker is doing in real-time, conversationally. opId scopes the bubble
  // — multiple workers each get their own bubble, identified + styled
  // separately from the main agent's stream.
  | { type: "worker_stream"; opId: string; task?: string; delta: string }
  | { type: "worker_done"; opId: string; status: "completed" | "failed" | "cancelled"; summary?: string };

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
