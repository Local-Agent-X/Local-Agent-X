// Direct LLM streamer for voice mode.
//
// Bypasses prepareAgentRequest + runAgent entirely. The agent pipeline is
// designed for tool-using turns with a 5kb persona/security/policy system
// prompt, multi-turn tool loops, hooks, retry detectors, etc. None of that
// belongs in casual voice chat — and pushing 6-13k input tokens per "Hey"
// gives us 5-15sec turn times.
//
// This caller:
//   - 100-token voice-only system prompt
//   - last 10 messages (5 turns) of history, full agent context dropped
//   - direct streaming API call against the user's selected provider
//   - signal.aborted checked on every delta so barge-in is truly instant
//   - no tools, no memory orchestrator, no security layer, no detectors
//
// Result: a 1-3sec voice turn instead of 5-15sec.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { streamCodexResponse } from "../codex-client.js";
import { streamAnthropicResponse } from "../anthropic-client.js";

const VOICE_SYSTEM_PROMPT =
  "You are a friendly voice assistant. The user is speaking to you and your reply will be spoken aloud. " +
  "Respond in one to three short conversational sentences. " +
  "No markdown, no lists, no code blocks, no headings, no emoji. " +
  "Use natural spoken English. If you don't know something, say so briefly. " +
  "Do not narrate your reasoning — just answer.";

const HISTORY_TURNS = 5; // last N user+assistant exchanges to keep

export interface VoiceLLMResult {
  assistantText: string;
  updatedHistory: ChatCompletionMessageParam[];
}

export interface VoiceLLMOptions {
  provider: "codex" | "anthropic" | "openai";
  apiKey: string;
  model: string;
  history: ChatCompletionMessageParam[];
  userMessage: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

export async function streamVoiceTurn(opts: VoiceLLMOptions): Promise<VoiceLLMResult> {
  // Trim history to recent turns. History stored as [user, assistant, user, ...]
  // so HISTORY_TURNS * 2 keeps the last N exchanges.
  const trimmedHistory = opts.history.slice(-HISTORY_TURNS * 2);
  const messages: ChatCompletionMessageParam[] = [
    ...trimmedHistory,
    { role: "user", content: opts.userMessage },
  ];

  let assistantText = "";
  let aborted = false;

  if (opts.provider === "codex") {
    const stream = streamCodexResponse({
      token: opts.apiKey,
      model: opts.model,
      messages,
      systemPrompt: VOICE_SYSTEM_PROMPT,
    });
    for await (const event of stream) {
      if (opts.signal.aborted) { aborted = true; break; }
      if (event.type === "text" && event.delta) {
        assistantText += event.delta;
        opts.onDelta(event.delta);
      } else if (event.type === "done") {
        break;
      }
    }
  } else if (opts.provider === "anthropic") {
    const stream = streamAnthropicResponse({
      token: opts.apiKey,
      model: opts.model,
      messages,
      systemPrompt: VOICE_SYSTEM_PROMPT,
    });
    for await (const event of stream) {
      if (opts.signal.aborted) { aborted = true; break; }
      if (event.type === "text" && event.delta) {
        assistantText += event.delta;
        opts.onDelta(event.delta);
      } else if (event.type === "done" || event.type === "error") {
        break;
      }
    }
  } else {
    // openai / xai / others — fall back to a generic OpenAI-compatible streaming
    // call. We don't currently have a thin client for these in voice mode;
    // until we do, fail loud rather than silently routing through the heavy
    // agent pipeline (which is what we're trying to avoid).
    throw new Error(`voice-llm: provider "${opts.provider}" not yet supported in fast path`);
  }

  if (aborted) {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }

  // Build updated history. Even if assistant text is empty, append it so
  // turn ordering stays consistent.
  const updatedHistory: ChatCompletionMessageParam[] = [
    ...opts.history,
    { role: "user", content: opts.userMessage },
    { role: "assistant", content: assistantText },
  ];

  return { assistantText, updatedHistory };
}
