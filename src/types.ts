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
}

// ── Server Types ──

export type ServerEvent =
  | { type: "stream"; delta: string }
  | { type: "tool_start"; toolName: string; args: unknown }
  | { type: "tool_end"; toolName: string; result: string; allowed: boolean }
  | { type: "done"; usage: AgentTurn["usage"] }
  | { type: "error"; message: string }
  | { type: "secret_request"; name: string; service?: string; reason: string };

// ── Auth Types ──

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
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
}
