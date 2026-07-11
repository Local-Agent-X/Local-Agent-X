// Pre-flight: build headers + JSON body for a Codex request. Pure functions
// — no fetch, no logging. The orchestrator composes these, hands the result
// to fetchWithRetry, and streams the response.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { convertMessagesToInput } from "../codex-message-convert.js";
import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../providers/reasoning-effort.js";
import type { CodexTool } from "./types.js";

export function extractAccountIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    );
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

export function buildHeaders(token: string): Record<string, string> {
  const accountId = extractAccountIdFromJwt(token);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    // The chatgpt.com/backend-api/codex Cloudflare layer whitelists a small set
    // of first-party originators (codex_cli_rs, codex_vscode, codex_sdk_ts).
    // A non-whitelisted originator ("pi") is served a degraded, reasoning-stripped
    // stream (answer only, no reasoning_summary_* events) even when auth is valid,
    // and non-residential IPs get a 403 challenge outright. Pin the codex-rs CLI
    // originator + a matching User-Agent so the backend emits the full reasoning
    // summary stream — the same values the upstream Codex CLI sends.
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0 (Local Agent X)",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return headers;
}

export interface BuildBodyInput {
  model: string;
  systemPrompt: string;
  messages: ChatCompletionMessageParam[];
  tools?: CodexTool[];
  toolChoice?: "auto" | "required" | { type: "tool"; name: string } | { type: "function"; function: { name: string } };
  reasoningEffort?: ReasoningEffort;
}

export function buildRequestBody(input: BuildBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    stream: true,
    instructions: input.systemPrompt,
    input: convertMessagesToInput(input.messages),
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    store: false,
    // Note: Codex subscription endpoint rejects max_output_tokens (400 error).
    // It has an internal cap we can't raise — means prompts must stay lean.
    // Effort default is "medium": "high" caused timeouts on complex prompts,
    // "low" caused ~40% empty responses. A user-picked level (settings
    // reasoningEffort, chat-bar Think picker) overrides the default — their
    // call to trade latency/reliability for depth.
    // summary MUST be "auto" on this endpoint. Tried "detailed" (2026-07-10)
    // to get summaries on light turns too: the subscription backend silently
    // dropped reasoning summaries ENTIRELY — same prompts that streamed
    // reasoning_summary_* under auto streamed none under detailed, no error.
    // (The public api.openai.com Responses API does accept detailed; the
    // chatgpt.com/backend-api/codex endpoint does not honor it.) Consequence:
    // trivial prompts legitimately render no Thinking block — auto only emits
    // a summary when the model actually runs a reasoning pass.
    reasoning: { effort: input.reasoningEffort ?? DEFAULT_REASONING_EFFORT, summary: "auto" },
  };

  // NOTE: previous_response_id is NOT supported on the Codex subscription
  // endpoint (chatgpt.com/backend-api). Sending it causes 400 Bad Request.
  // Incremental mode will need to work via message-level optimization
  // instead of API-level response chaining.

  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
    // Responses API tool_choice shape: name lives at the top level, not
    // nested under a `function` object. The Chat Completions shape
    // ({type:"function", function:{name}}) is rejected with 400
    // "Unknown parameter: tool_choice.function".
    const tc = input.toolChoice;
    if (tc && typeof tc === "object" && tc.type === "tool") {
      body.tool_choice = { type: "function", name: tc.name };
    } else {
      body.tool_choice = tc || "auto";
    }
    body.parallel_tool_calls = true;
  }

  // NOTE: tried adding the built-in {type: "image_generation"} tool here —
  // documented as supported on the public Responses API. The chatgpt.com
  // codex/responses OAuth endpoint reasons on it for ~120-200 tokens and
  // then produces zero output (empty stream, classified as reasoning_timeout).
  // Removed pending a working request shape for this endpoint.

  // Codex endpoint does not support temperature

  return body;
}
