/**
 * Commit-seam invariant: every tool call on a committed assistant row has a
 * tool_result row behind it.
 *
 * turn-loop.ts skips dispatch when an afterModelCall middleware aborts the
 * turn or nudges with `skipToolDispatch` (loop-detection's mutation-repeat
 * pivot does the latter, and empties the live toolCalls list on its way out —
 * middlewares/loop-detection.ts). The finalized assistant row still carries
 * the calls on `content.toolCalls`, so decide-outcome used to commit an
 * assistant row whose calls had no results. Every provider then choked on the
 * replay in its own way: Anthropic 400 (tool_use without tool_result), Codex
 * 400 ("No tool output found for function call"), legacy chat silently
 * dropped the call (providers/sanitize.ts). One defect, three behaviors —
 * repaired here at the producer so every adapter sees a well-formed
 * transcript. The codex wire keeps its own belt (codex-message-convert.ts
 * MISSING_TOOL_OUTPUT) for transcripts cut mid-call; both use ONE phrasing,
 * pinned equal by orphan-tool-results.test.ts.
 *
 * The row asserts no cause. Dispatch was skipped before any call started on
 * the loop-detection path, but the invariant is general — a call may have
 * run — so the text tells the model to check state before repeating a side-
 * effecting action. The envelope has no "skipped" flavor (src/types.ts
 * ToolResultStatus: ok|error|blocked|declined|timeout|running), so the row
 * carries the failure state `error` and names its provenance in
 * `synthesized` (code `dispatch_skipped` + the middleware), never in the text.
 *
 * Deliberately NOT mirrored into toolCallSummary: that ledger records what was
 * DISPATCHED — the middleware tallies (middlewares/host.ts), the action ledger
 * and the committing-work proofs (agent-runner/run.ts) all read it — and a
 * skipped call was not. Nor into decide-outcome's `toolMessages`, which
 * collectToolFailures pairs with toolCallSummary BY INDEX.
 */
import type { CommitTurnMessage } from "../checkpoint.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.turn-loop.orphan-tool-results");

/** Exact text the model sees for a call whose result was never recorded. */
export const MISSING_TOOL_RESULT_TEXT =
  "[No result was recorded for this tool call. It may or may not have run; check current state before repeating any action with side effects.]";

export const DISPATCH_SKIPPED_CODE = "dispatch_skipped";

export interface SynthesizedToolResultContent {
  toolCallId: string;
  result: string;
  status: "error";
  synthesized: {
    code: typeof DISPATCH_SKIPPED_CODE;
    /** Middleware whose directive skipped dispatch (`firedBy`), or "unknown". */
    middleware: string;
    /** That directive's reason (e.g. "strategy-pivot"), when one fired. */
    reason?: string;
  };
}

/** The sticky directive that skipped dispatch — `firedBy` + `reason` are all
 *  three MiddlewareDirective kinds carry (turn-loop/types.ts). */
export interface SkippedDispatchSource {
  firedBy: string;
  reason: string;
}

/**
 * Append one synthesized tool_result row per tool call on an assistant row in
 * `messages` that no tool_result row in `messages` answers. Mutates in place
 * (same contract as applyTerminalEpilogue) and returns the number appended.
 * Call BEFORE any epilogue / answer rows are appended: the rows land at the
 * end, which is "immediately after the tool batch" only while the batch is
 * last. A fully answered turn is untouched — no allocation, no reorder.
 */
export function appendMissingToolResults(
  messages: CommitTurnMessage[],
  skippedBy: SkippedDispatchSource | null,
): number {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool_result") continue;
    const id = (m.content as { toolCallId?: unknown } | null | undefined)?.toolCallId;
    if (typeof id === "string") answered.add(id);
  }
  const missing: Array<{ id: string; name: string }> = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of toolCallsOf(m.content)) {
      if (answered.has(call.id)) continue;
      answered.add(call.id); // one row per id, even if a row repeats it
      missing.push(call);
    }
  }
  const middleware = skippedBy?.firedBy ?? "unknown";
  for (const call of missing) {
    logger.info(
      `[canonical-loop] synthesized tool_result for ${call.name} (${call.id}): dispatch skipped by ${middleware}`,
    );
    const content: SynthesizedToolResultContent = {
      toolCallId: call.id,
      result: MISSING_TOOL_RESULT_TEXT,
      status: "error",
      synthesized: {
        code: DISPATCH_SKIPPED_CODE,
        middleware,
        ...(skippedBy ? { reason: skippedBy.reason } : {}),
      },
    };
    messages.push({ role: "tool_result", content });
  }
  return missing.length;
}

// Assistant rows finalize tool calls as `content.toolCalls: [{ id, name,
// arguments }]` (anthropic.ts / codex.ts / openai-compat.ts message_finalized;
// canonical-to-transport.ts and step-effort.ts read the identical shape). The
// id is what pairs a result to its call, so an entry without one is skipped;
// the name only labels the log line.
function toolCallsOf(content: unknown): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  if (!content || typeof content !== "object") return out;
  const tc = (content as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(tc)) return out;
  for (const t of tc) {
    if (!t || typeof t !== "object") continue;
    const { id, name } = t as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !id) continue;
    out.push({ id, name: typeof name === "string" && name ? name : "unknown" });
  }
  return out;
}
