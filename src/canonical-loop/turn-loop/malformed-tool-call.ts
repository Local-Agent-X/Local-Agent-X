/**
 * A turn the model ended with a tool call its runtime could not parse —
 * beside cut-off-turn.ts, the other turn that produced nothing usable.
 *
 * A local runtime parses the model's tool-call text itself, and when the model
 * writes it malformed the runtime fails the whole response (Ollama on Qwen:
 * "XML syntax error on line 4: element <function> closed by </parameter>").
 * The adapter reports that as a transport error, and an adapter error ended
 * the op: on Terminal-Bench 2.0 two local runs died one step from the answer
 * (mteb-leaderboard, install-windows-3.11, 2026-10-23). The generic adapter
 * retry never fires here, because the model's thinking streamed first.
 *
 * Nothing ran, so the turn is re-driven with a nudge naming the parse error,
 * at most MALFORMED_TOOL_CALL_REDRIVE_LIMIT times in a row; past that it ends
 * with the error, as before.
 */
import { getMiddlewareState } from "../middlewares/state.js";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";
import { classify } from "../../resilience-policy.js";
import { appendNudgeAsUserMessage } from "./nudges.js";

const MALFORMED_TOOL_CALL_KEY = "malformed-tool-call-counter";
export const MALFORMED_TOOL_CALL_REDRIVE_LIMIT = 2;
/** How much of the runtime's parse error the nudge quotes. */
const DETAIL_MAX_CHARS = 200;

export function malformedToolCallNudge(detail: string): string {
  return `Your last tool call could not be parsed by the model runtime, so nothing ran (${detail.slice(0, DETAIL_MAX_CHARS)}). Send that call again in the native tool-call format with every argument complete. Don't restate the plan.`;
}

export interface MalformedToolCallInput {
  op: Op;
  turnIdx: number;
  adapterError: { code: string; message: string } | null;
  toolCalls: ToolCall[];
  middlewareAborted: boolean;
  middlewareSuspended: boolean;
}

/**
 *   "redrive"   → the turn re-opens with the nudge queued for the next turn.
 *   "exhausted" → the re-drives in a row are spent; the error stands.
 *   null        → not a malformed tool call, or another decision owns the turn.
 */
export function evaluateMalformedToolCall(in_: MalformedToolCallInput): "redrive" | "exhausted" | null {
  const state = getMiddlewareState(in_.op.id, MALFORMED_TOOL_CALL_KEY, () => ({ consecutive: 0 }));
  const malformed = !!in_.adapterError && in_.toolCalls.length === 0
    && classify(in_.adapterError.message) === "malformedToolCall";
  if (!malformed) { state.consecutive = 0; return null; }
  if (in_.middlewareAborted || in_.middlewareSuspended) return null;
  if (state.consecutive >= MALFORMED_TOOL_CALL_REDRIVE_LIMIT) return "exhausted";
  appendNudgeAsUserMessage(in_.op.id, in_.turnIdx + 1, malformedToolCallNudge(in_.adapterError!.message),
    { name: "malformed-tool-call", reason: "malformed-tool-call", outcome: "nudge" });
  state.consecutive += 1;
  return "redrive";
}
