// One round-trip through the Anthropic transport. Iterates the transport's
// AsyncIterable<TransportEvent>, accumulates text + tool calls, and
// reports each event back through the canonical contract.
//
// Mid-stream interrupt: Anthropic's streaming model does in-stream tool
// execution — one runTurn can include many model iterations + tool calls
// without returning. If the user types a course-correction during that,
// the inject queue receives the message but driveTurn doesn't re-fire
// until this runTurn returns. To stay responsive, we poll the inject
// queue at the top of each stream event; on a hit we flag
// interruptedByInject and bail. The caller flips its own aborted flag
// and aborts the transport's signal — the next driveTurn drains the
// inject and the model sees the user's text on its very next API call.

import type { AdapterReport } from "../../adapter-contract.js";
import { hasInjects } from "../../../agent-loop/inject-queue.js";
import { extractToolCallsFromText } from "../tool-call-text-extractor.js";
import { createLogger } from "../../../logger.js";
import { parseArgs, redactSecrets } from "./helpers.js";
import type {
  AnthropicTransport,
  AnthropicTransportRequest,
  StreamConsumeResult,
} from "./types.js";

const logger = createLogger("canonical-loop.anthropic.stream");

export interface StreamConsumeDeps {
  isAborted: () => boolean;
  sessionId?: string;
}

export async function streamConsume(
  transport: AnthropicTransport,
  req: AnthropicTransportRequest,
  report: (r: AdapterReport) => void,
  deps: StreamConsumeDeps,
): Promise<StreamConsumeResult> {
  const out: StreamConsumeResult = {
    assembledText: "",
    toolCallIds: [],
    firstError: null,
    providerStop: undefined,
    usageInputTokens: undefined,
    usageOutputTokens: undefined,
    cacheReadTokens: undefined,
    cacheCreateTokens: undefined,
    interruptedByInject: false,
  };
  try {
    for await (const ev of transport.stream(req)) {
      if (deps.isAborted()) break;
      // Mid-stream user interrupt. Anthropic's streaming model does
      // in-stream tool execution: one runTurn can include many model
      // iterations + tool calls without returning. If the user types
      // a course-correction during that, the inject queue receives
      // the message but driveTurn doesn't re-fire (and drainInjects
      // doesn't run) until this runTurn returns. Result: the user's
      // "don't ever use AI Import" sits unseen for minutes while the
      // agent keeps doing the thing they're trying to stop.
      //
      // Fix: poll the inject queue at the top of each stream event.
      // When the user types, flag interruptedByInject and bail —
      // the caller aborts the transport's signal so the runTurn
      // returns cleanly, then driveTurn drains the inject and the
      // model sees it on its very next API call. Whatever the model
      // was about to say next gets discarded; that's the right
      // tradeoff — the user explicitly intervened.
      if (deps.sessionId && hasInjects(deps.sessionId)) {
        out.interruptedByInject = true;
        break;
      }
      if (ev.type === "text") {
        if (ev.delta.length === 0) continue;
        out.assembledText += ev.delta;
        report({ kind: "stream_chunk", body: { delta: ev.delta } });
        continue;
      }
      if (ev.type === "tool_call") {
        out.toolCallIds.push(ev.id);
        report({
          kind: "tool_call_requested",
          call: {
            toolCallId: ev.id,
            tool: ev.name,
            args: parseArgs(ev.arguments),
          },
        });
        continue;
      }
      if (ev.type === "error") {
        // Routine errors come through as adapter_reports (PRD §15 H).
        // We capture the FIRST error and propagate via TurnResult.
        if (!out.firstError) {
          out.firstError = { code: ev.code, message: redactSecrets(ev.message) };
        }
        report({
          kind: "error",
          code: ev.code,
          message: redactSecrets(ev.message),
          retryable: ev.retryable === true,
        });
        continue;
      }
      if (ev.type === "done") {
        out.providerStop = ev.stopReason;
        if (ev.usage) {
          out.usageInputTokens = ev.usage.inputTokens;
          out.usageOutputTokens = ev.usage.outputTokens;
          out.cacheReadTokens = ev.usage.cacheReadTokens;
          out.cacheCreateTokens = ev.usage.cacheCreateTokens;
        }
        continue;
      }
    }
  } catch (e) {
    // Defensive: contract H says routine errors come via report,
    // not exceptions. If the transport throws, convert into an error
    // report and proceed. We never re-throw out of runTurn.
    const message = redactSecrets((e as Error).message ?? String(e));
    if (!out.firstError) out.firstError = { code: "transport_exception", message };
    report({ kind: "error", code: "transport_exception", message, retryable: false });
  }
  return out;
}

/**
 * Tool-call-in-text fallback. Mirror of the rescue path in openai-compat.
 * Anthropic models occasionally emit a tool call as raw JSON inside the
 * text channel instead of as a structured tool_use block — typically
 * after long sessions or when the model "explains" a call before making
 * it. Without this, the JSON shows up in chat, the loop sees zero tool
 * calls, and the turn stalls.
 *
 * Fires ONLY when no structured tool_use arrived AND the text contains
 * a clear pattern. Healthy turns are untouched.
 *
 * Mutates `result` in place: pushes extracted tool-call ids into
 * toolCallIds and overwrites assembledText with the leftover text.
 * Emits a stream_redact so the UI swaps the dirty stream chunks for
 * the cleaned text.
 */
export function applyToolCallTextFallback(
  result: StreamConsumeResult,
  report: (r: AdapterReport) => void,
  model: string,
  validToolNames: Set<string>,
): void {
  if (result.toolCallIds.length > 0 || result.assembledText.length === 0) return;
  const extracted = extractToolCallsFromText(result.assembledText, validToolNames);
  if (extracted.toolCalls.length === 0) return;
  logger.info(`${model} emitted ${extracted.toolCalls.length} tool call(s) as text — extracted`);
  for (const tc of extracted.toolCalls) {
    result.toolCallIds.push(tc.id);
    report({
      kind: "tool_call_requested",
      call: { toolCallId: tc.id, tool: tc.name, args: parseArgs(tc.arguments) },
    });
  }
  result.assembledText = extracted.remainingText;
  // Retract the JSON the UI already streamed into the bubble; the
  // persisted message will use the cleaned text. Clients without
  // stream_redact handling are no worse off than before.
  report({ kind: "stream_redact", replacementText: extracted.remainingText });
}
