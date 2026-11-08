// One round-trip through the openai-compat family's HTTP transport. Streams
// events from the transport chat-transport.ts picks (Chat Completions, or
// Ollama's native /api/chat for a discovered local Ollama), accumulates
// text + tool calls, and reports each event back through the canonical
// contract.
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
import { isLocalModelEndpoint } from "../../../local-runtimes/model-endpoint.js";
import { markServingChat } from "../../../local-runtimes/residency.js";
import { createLogger } from "../../../logger.js";
import { refusalError } from "../model-stop.js";
import { extractToolCallsFromText } from "../tool-call-text-extractor.js";
import { parseArgs } from "../tool-call-text-repair.js";
import { createDegenerateStreamGuard, DEGENERATE_STOP, DEGENERATE_STREAM_STOP_REASON, isRuntimeDegenerateAbort } from "../stream-guards.js";
import { withTransportRetry } from "../transport-retry.js";
import { chatTransportFor } from "./chat-transport.js";
import type { StreamOnceResult } from "./types.js";

const logger = createLogger("canonical-loop.adapters.openai-compat.stream");

export interface StreamOnceDeps {
  isAborted: () => boolean;
  sessionId?: string;
  /** Leave a cut-off, reasoning-only reply as it streamed: the caller will
   *  continue it (cut-off-continuation.ts) and promote it itself if it
   *  stays cut. Default: promoted here (promoteCutOffReasoning). */
  keepCutOffReasoning?: boolean;
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
    stoppedByGuard: undefined,
  };
  // Degenerate-output guard, on every endpoint: a local model can loop
  // verbatim or emit garble indefinitely, and so can a hosted one (Grok
  // 4.7 repeated one sentence 170 times on a voice turn until its 4,096-token
  // cap, 2026-11-07). Watches answer-text deltas only: reasoning models
  // legitimately produce repetitive chain-of-thought, bounded by the output
  // cap regardless.
  const local = isLocalModelEndpoint(req.baseURL);
  const guard = createDegenerateStreamGuard();
  // A background call to this model now would wait behind this request, so
  // short-budget classifiers skip instead of queueing (residency.ts).
  const endServing = local ? markServingChat(req.model) : undefined;
  try {
    // Chat Completions for every provider in this family, except a
    // discovered local Ollama runtime, which rides native /api/chat
    // (chat-transport.ts). Same StreamChunk contract either way.
    const transport = await chatTransportFor(req.baseURL);
    for await (const ev of withTransportRetry(() => transport.stream(req), {
      label: "openai-compat",
      signal: req.signal,
      isAborted: deps.isAborted,
    })) {
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
        const verdict = guard.feed(ev.delta);
        if (verdict.tripped) {
          // Same teardown mechanism as the inject interrupt below: breaking
          // the loop return()s the generator chain, which aborts the SDK's
          // in-flight HTTP request via its own AbortController. Text
          // streamed so far stays in assembledText, so the partial reply
          // still finalizes.
          stopDegenerate(out, report, req.model, verdict.reason, "stream-guard");
          break;
        }
        continue;
      }
      if (ev.type === "thinking") {
        // Reasoning-model chain-of-thought (Cerebras `delta.reasoning`,
        // DeepSeek-style `reasoning_content`). Stream it live on the
        // reasoning lane so the UI shows a "Thinking" affordance instead of
        // a silent spinner, and accumulate it so the reasoning-only fallback
        // below still has text if the model burns its budget on reasoning and
        // never emits a `content` answer. reasoning_chunk also resets the
        // orchestrator's idle watchdog, so a minutes-long think-only turn
        // isn't killed as "stalled".
        if (ev.delta) {
          out.assembledThinking += ev.delta;
          report({ kind: "reasoning_chunk", delta: ev.delta });
        }
        continue;
      }
      if (ev.type === "tool_call") {
        out.pendingToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
        report({ kind: "tool_call_requested", call: { toolCallId: ev.id, tool: ev.name, args: parseArgs(ev.arguments) } });
        continue;
      }
      if (ev.type === "request_sent") {
        out.wireParams = ev.params;
        continue;
      }
      if (ev.type === "usage") {
        out.usagePromptTokens = ev.promptTokens;
        out.usageCompletionTokens = ev.completionTokens;
        out.usageCachedTokens = ev.cachedTokens;
        continue;
      }
      if (ev.type === "error") {
        const message = ev.message ?? "transport error";
        // The runtime stopped a looping reply itself: the guard's event, one
        // layer down, so the guard's outcome — not a failed op.
        if (isRuntimeDegenerateAbort(message)) {
          stopDegenerate(out, report, req.model, message, "runtime");
          break;
        }
        if (!out.firstError) out.firstError = { code: "transport_error", message };
        report({ kind: "error", code: "transport_error", message, retryable: false });
        continue;
      }
      if (ev.type === "done") {
        out.providerStop = ev.stopReason;
        if (ev.firstTokenMs !== undefined) out.firstTokenMs = ev.firstTokenMs;
        const refusal = refusalError(ev.stopReason);
        if (refusal) {
          if (!out.firstError) out.firstError = refusal;
          report({ kind: "error", ...refusal, retryable: false });
        }
        continue;
      }
    }
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if (!out.firstError) out.firstError = { code: "transport_exception", message };
    report({ kind: "error", code: "transport_exception", message, retryable: false });
  } finally {
    endServing?.();
  }
  out.rawText = out.assembledText;
  if (!deps.keepCutOffReasoning) promoteCutOffReasoning(out, report);
  return out;
}

/**
 * A degenerate reply, caught by the guard or by the runtime, ends here with
 * DEGENERATE_STOP as its stop and exactly ONE user-visible notice: the adapter
 * contract has no "stopped" report kind, so it rides the op-stream bus as a
 * marker chunk (stream_chunk bodies pass through turn-loop verbatim); the chat
 * event pump maps it to the standard `stopped` ServerEvent, and every other
 * stream consumer ignores chunks without delta/replace by invariant.
 */
function stopDegenerate(
  out: StreamOnceResult,
  report: (r: AdapterReport) => void,
  model: string,
  reason: string,
  firedBy: "stream-guard" | "runtime",
): void {
  out.stoppedByGuard = reason;
  out.providerStop = DEGENERATE_STOP;
  logger.warn(`[${firedBy}] ${model}: ${reason} — stopping stream early`);
  report({
    kind: "stream_chunk",
    body: { stopped: true, reason: DEGENERATE_STREAM_STOP_REASON, debug: reason, firedBy },
  });
}

/**
 * Reasoning-only fallback. The model reasoned the entire output budget away
 * (finish_reason "length") and never emitted `content` — without this, the
 * user sees an empty bubble. Surface the reasoning as the assistant text so
 * the turn is at least visible. Skip when the turn produced tool calls (then
 * text is optional) or had a transport error (the error event already
 * surfaced).
 *
 * ONLY on a length stop. A model that planned and then stopped ("We need to
 * find the stub file. Let's list workspace.") had its plan committed as the
 * answer, and the turn ended as done without the tool call it described
 * (muse, grep, 2026-09-17). With no text, the turn loop sees a
 * reasoning-only turn and re-drives it (empty-turn-termination.ts).
 */
export function promoteCutOffReasoning(out: StreamOnceResult, report: (r: AdapterReport) => void): void {
  if (
    out.providerStop === "length" &&
    out.assembledText.length === 0 &&
    out.assembledThinking.length > 0 &&
    out.pendingToolCalls.length === 0 &&
    !out.firstError
  ) {
    out.assembledText = out.assembledThinking;
    report({ kind: "stream_chunk", body: { delta: out.assembledThinking } });
  }
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
