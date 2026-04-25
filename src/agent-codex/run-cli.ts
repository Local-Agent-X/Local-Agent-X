import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { AgentTurn } from "../types.js";
import type { AgentOptions } from "./shared.js";
import { runCodexAgentHttp } from "./run-http.js";

// ── Codex (ChatGPT subscription) Agent Loop ──
//
// Codex tool calls are routed through the canonical tool-executor in
// runCodexAgentHttp(), so they get the same security, hooks, retry,
// circuit breaker, rate limiting, and tracker treatment as Anthropic/xAI.
// (The previous WebSocket path was disabled in production and bypassed
// the executor entirely — it has been removed to prevent that drift.)

export async function runCodexAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  return runCodexAgentHttp(userMessage, history, options);
}
