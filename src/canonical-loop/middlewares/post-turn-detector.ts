/**
 * Post-turn detector stack — wraps runPostTurnDetectors from
 * agent-loop-detectors.ts. Catches planning-only turns, single-action-stop,
 * evidence-stale, uncommitted turns, etc. Canonical-loop port of
 * src/agent-loop/middlewares/post-turn-detector.ts.
 *
 * Legacy stuffs the hit into `ctx.promptLayers.retry` so the next iteration's
 * system prompt carries the nudge, and returns retry-iteration. Canonical
 * has no prompt-layer surface today; for parity we push the instruction as
 * a user message via the standard `nudge` directive — same effective
 * behavior (model sees the nudge on the next turn), just plumbed through
 * op_messages instead of a layer.
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";

const RETRY_COUNTERS_KEY = "post-turn-detector-counters";

export const postTurnDetectorMiddleware: CanonicalMiddleware = {
  name: "post-turn-detector",

  async afterModelCall(ctx) {
    const { runPostTurnDetectors, computeEvidenceCount, userMessageHasImages, createRetryCounters } =
      await import("../../agent-loop-detectors/index.js");
    const counters = getMiddlewareState(ctx.op.id, RETRY_COUNTERS_KEY, createRetryCounters);

    // Compute evidence from the committed op_messages PLUS this turn's
    // just-emitted assistant tool calls (those haven't been committed yet
    // — afterModelCall fires before commitTurn). Build a thin
    // ChatCompletionMessageParam[] view because computeEvidenceCount reads
    // assistant.tool_calls from that exact shape.
    const { readOpMessages } = await import("../store.js");
    const rows = readOpMessages(ctx.op.id);
    const messagesView = rows.map(r => {
      if (r.role !== "assistant") {
        return { role: r.role === "tool_result" ? "tool" : r.role, content: "" } as { role: string; content: unknown };
      }
      const toolCalls = (r.content as { toolCalls?: Array<{ id?: string; name: string; arguments?: string }> })?.toolCalls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        return {
          role: "assistant",
          content: "",
          tool_calls: toolCalls.map(tc => ({
            id: tc.id ?? "",
            type: "function",
            function: { name: tc.name, arguments: tc.arguments ?? "" },
          })),
        };
      }
      return { role: "assistant", content: "" };
    }) as Array<{ role: string; content: unknown; tool_calls?: Array<{ function?: { name?: string } }> }>;

    // Append this turn's tool calls so evidence count includes them.
    if (ctx.toolCalls.length > 0) {
      messagesView.push({
        role: "assistant",
        content: "",
        tool_calls: ctx.toolCalls.map(tc => ({
          function: { name: tc.tool },
        })),
      });
    }

    ctx.evidenceHistory.push(
      computeEvidenceCount(messagesView as unknown as Parameters<typeof computeEvidenceCount>[0]),
    );

    const detectorState = {
      assistantText: ctx.assistantContent,
      toolCallsThisIteration: ctx.toolCalls.map(tc => ({
        name: tc.tool,
        arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? null),
      })),
      toolsCalledThisTurn: ctx.toolsCalledThisOp,
      hasReasoning: false,
      completionTokens: 0,
      iteration: ctx.turnIdx,
      evidenceCount: ctx.evidenceHistory[ctx.evidenceHistory.length - 1],
      evidenceHistory: [...ctx.evidenceHistory],
      userMessageHasImages: userMessageHasImages(
        messagesView as Array<{ role: string; content: unknown }>,
      ),
    };

    const hit = runPostTurnDetectors(detectorState, counters);
    if (hit) {
      return { kind: "nudge", message: hit.instruction, reason: `post-turn:${hit.kind}` };
    }
    return { kind: "continue" };
  },
};
