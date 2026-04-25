import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface StreamEvent {
  type: "text" | "tool_call" | "mcp_activity" | "done" | "error";
  delta?: string;
  id?: string;
  name?: string;
  arguments?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  /** Stop reason from the API — populated on done/error */
  stopReason?: string;
  /** Classification of why the response ended */
  classification?: import("../response-classifier.js").ClassificationResult;
}

export interface StreamOptions {
  token: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  systemPrompt: string;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  temperature?: number;
  maxTokens?: number;
  /** If true, don't fall back to CLI proxy on 429 — yield error instead */
  skipCliFallback?: boolean;
  /** Force tool use: "required" makes the model call a tool. "auto" (default) lets it decide. */
  toolChoice?: "auto" | "required";
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

export type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
