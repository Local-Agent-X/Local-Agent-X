// Types + constants for the ChatGPT Codex Responses API client. Kept here
// so request/parse/orchestrator modules import a single source of truth.

import type { ReasoningItem } from "../codex-message-convert.js";
import type { ClassificationResult } from "../response-classifier.js";

export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

export interface CodexTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CodexStreamEvent {
  type: string;
  // response.output_text.delta / response.reasoning_summary_text.delta
  delta?: string;
  // response.reasoning_summary_text.done carries the full summary text; keyed
  // for dedup by item_id + summary_index.
  text?: string;
  item_id?: string;
  summary_index?: number;
  // response.function_call_arguments.delta
  name?: string;
  call_id?: string;
  // response.completed / response.done
  response?: {
    id?: string;
    output?: Array<{
      type: string;
      content?: Array<{ type?: string; text?: string }>;
      name?: string;
      call_id?: string;
      arguments?: string;
      // Reasoning items
      summary?: Array<{ type?: string; text?: string }>;
      encrypted_content?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

export interface CodexResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  reasoning: ReasoningItem[];
  usage: { inputTokens: number; outputTokens: number };
}

export type CodexStreamYield =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  // Live reasoning-summary delta (Responses API `reasoning: { summary }`).
  // Distinct from the end-of-turn `reasoning` item below, which carries the
  // encrypted reasoning payload replayed for context-chaining, not UI text.
  | { type: "reasoning_summary"; delta: string }
  | { type: "reasoning"; item: ReasoningItem }
  | {
      type: "done";
      usage: { inputTokens: number; outputTokens: number; classification?: ClassificationResult };
      responseId?: string;
      reasoning: ReasoningItem[];
    };

export interface CodexToolCallAccum {
  id: string;
  callId: string;
  itemId: string;
  name: string;
  arguments: string;
}
