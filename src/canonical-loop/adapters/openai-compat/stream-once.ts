// One round-trip through the OpenAI-compat HTTP transport. Streams events
// from openaiHttpAdapter (the OpenAI Chat Completions client used by every
// HTTP provider in this family), accumulates text + tool calls, and
// reports each event back through the canonical contract.
//
// Mid-stream interrupt: if the user types while the model is generating,
// we break out of the loop and signal `interruptedByInject: true`. The
// caller flips its own aborted flag so post-stream handling treats the
// turn as aborted (and the next driveTurn picks up the queued message).
//
// Reasoning-only fallback: if the model burned its entire output budget
// on reasoning (Cerebras `delta.reasoning`, DeepSeek `reasoning_content`)
// and never emitted `content`, we surface the reasoning as the assistant
// text so the user sees something instead of an empty bubble.

import type { AdapterReport } from "../../adapter-contract.js";
import type { ProviderRequest } from "../../../providers/adapter/types.js";
import { hasInjects } from "../../../agent-loop/inject-queue.js";
import { createLogger } from "../../../logger.js";
import { extractToolCallsFromText } from "../tool-call-text-extractor.js";
import { parseArgs } from "./helpers.js";
import type { StreamOnceResult } from "./types.js";

const logger = createLogger("canonical-loop.adapters.openai-compat.stream");

export interface StreamOnceDeps {
  isAborted: () => boolean;
  sessionId?: string;
}

export async function streamOnce(
  req: ProviderRequest,
  report: (r: AdapterReport) => void,
  deps: StreamOnceDeps,
): Promise<StreamOnceResult> {
  const out: StreamOnceResult = {
    assembledText: "",
    assembledThinking: "",
    pendingToolCalls: [],
    firstError: null,
    providerStop: undefined,
    usagePromptTokens: undefined,
    usageCompletionTokens: undefined,
    interruptedByInject: false,
  };
  try {
    // The OpenAI Chat Completions client every provider in this family
    // shares — OpenAI, xAI, Gemini compat, and local + cloud Ollama. They
    // differ only by baseURL/apiKey, which ride on `req`.
    const { openaiHttpAdapter } = await import("../../../providers/adapters/openai-http.js");
    for await (const ev of openaiHttpAdapter.stream(req)) {
      if (deps.isAborted()) break;
      // Mid-stream user interrupt — same shape as anthropic.ts and
      // codex.ts. Abort the stream when the user types so the next
      // driveTurn drains the inject and the model sees the message
      // on its next API call.
      if (deps.sessionId && hasInjects(deps.sessionId)) {
        out.interruptedByInject = true;
        break;
      }
      if (ev.type === "text") {
        if (!ev.delta) continue;
        out.assembledText += ev.delta;
        report({ kind: "stream_chunk", body: { delta: ev.delta } });
        continue;
      }
      if (ev.type === "thinking") {
        // Reasoning-model chain-of-thought (Cerebras `delta.reasoning`,
        // DeepSeek-style `reasoning_content`). Accumulate silently so
        // we have something to show if the model burns its budget on
        // reasoning and never emits a final `content` answer. Streaming
        // this live to chat would dump raw thoughts into the bubble,
        // which is bad UX — surface only as a final fallback below.
        //
        // Still ping the orchestrator so its idle watchdog knows the model
        // is alive. Reasoning models can think for minutes before the first
        // `content`/tool_call; without this the silent accumulation reads as
        // a stall and the turn gets killed mid-thought.
        if (ev.delta) {
          out.assembledThinking += ev.delta;
          report({ kind: "heartbeat" });
        }
        continue;
      }
      if (ev.type === "tool_call") {
        out.pendingToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
        report({ kind: "tool_call_requested", call: { toolCallId: ev.id, tool: ev.name, args: parseArgs(ev.arguments) } });
        continue;
      }
      if (ev.type === "usage") {
        out.usagePromptTokens = ev.promptTokens;
        out.usageCompletionTokens = ev.completionTokens;
        continue;
      }
      if (ev.type === "error") {
        const message = ev.message ?? "transport error";
        if (!out.firstError) out.firstError = { code: "transport_error", message };
        report({ kind: "error", code: "transport_error", message, retryable: false });
        continue;
      }
      if (ev.type === "done") {
        out.providerStop = ev.stopReason;
        continue;
      }
    }
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if (!out.firstError) out.firstError = { code: "transport_exception", message };
    report({ kind: "error", code: "transport_exception", message, retryable: false });
  }
  // Reasoning-only fallback. The model reasoned the entire output
  // budget away and never emitted `content` — without this, the user
  // sees an empty bubble. Surface the reasoning as the assistant text
  // so the turn is at least visible. Skip when the turn produced tool
  // calls (then text is optional) or had a transport error (the error
  // event already surfaced).
  if (
    out.assembledText.length === 0 &&
    out.assembledThinking.length > 0 &&
    out.pendingToolCalls.length === 0 &&
    !out.firstError
  ) {
    out.assembledText = out.assembledThinking;
    report({ kind: "stream_chunk", body: { delta: out.assembledThinking } });
  }
  return out;
}

/**
 * Tool-call-in-text fallback. Some models (qwen3-next, gpt-oss, llama
 * variants on Ollama) sporadically emit tool calls as raw JSON inside
 * `content` instead of populating the structured tool_calls field. Detect
 * and rewrite. Fires ONLY when tool_calls is empty AND the text matches a
 * known pattern — no-op for Claude/GPT-5/healthy providers.
 *
 * Live failure 2026-05-12: qwen3-next:80b on Ollama Turbo emitted
 * `{"action":"click","ref":49}` and `{"name":"browser","arguments":{...}}`
 * as plain text mid-conversation, leaking tool calls to the chat UI and
 * stalling the agent because no click dispatched.
 *
 * Mutates `result` in place: pushes extracted tool calls into
 * pendingToolCalls and overwrites assembledText with the leftover text.
 * Emits a stream_redact so the UI can swap the dirty stream chunks for
 * the cleaned text.
 */
export function applyToolCallTextFallback(
  result: StreamOnceResult,
  report: (r: AdapterReport) => void,
  model: string,
  validToolNames: Set<string>,
): void {
  if (result.pendingToolCalls.length > 0 || result.assembledText.length === 0) return;
  const extracted = extractToolCallsFromText(result.assembledText, validToolNames);
  if (extracted.toolCalls.length === 0) return;
  logger.info(`${model} emitted ${extracted.toolCalls.length} tool call(s) as text — extracted`);
  for (const tc of extracted.toolCalls) {
    result.pendingToolCalls.push(tc);
    report({ kind: "tool_call_requested", call: { toolCallId: tc.id, tool: tc.name, args: parseArgs(tc.arguments) } });
  }
  result.assembledText = extracted.remainingText;
  // Tell the UI to retract the JSON it already streamed into the bubble
  // and replace with the cleaned text. Without this, the user sees JSON
  // soup left over from the original stream chunks even though the
  // persisted message is clean. Clients that don't handle stream_redact
  // leave the dirty stream rendered (no regression for older UIs).
  report({ kind: "stream_redact", replacementText: extracted.remainingText });
}
