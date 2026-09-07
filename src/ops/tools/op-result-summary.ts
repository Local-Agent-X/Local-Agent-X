/**
 * The ONE rendering of an awaited op's result as a tool result — shared by
 * op_wait and op_submit (which is op_submit_async + op_wait in one call), so
 * the two can never disagree about what a parent sees.
 *
 * A `partial` child (checkpoint-stop.ts: the op stopped at an iteration
 * checkpoint — dry checkpoints or the spend ceiling) is NOT an error: its
 * work is saved and the parent must act on it (continue or report), which an
 * isError result would tell it to abandon. But it is not done either, and
 * its last assistant text reads like a finished answer — so the PARTIAL line
 * (result.finalSummary, from the checkpoint's own event via await-op.ts) MUST
 * open the content, before any of the child's own text.
 */
import type { OpResult } from "../types.js";
import { extractFinalAssistantText } from "../../canonical-loop/index.js";

/** Terminal statuses a parent should treat as the op having gone wrong. A
 *  partial is unfinished, not failed. */
export function isOpResultError(status: OpResult["status"]): boolean {
  return status !== "completed" && status !== "partial";
}

export function formatAwaitedOpResult(
  opId: string,
  result: OpResult,
  wallMs: number,
): { content: string; isError: boolean } {
  // The worker's actual final message — what the caller waited FOR.
  // result.finalSummary is a synthesized status line ("op <id> completed")
  // with no content; prefer the real assistant text.
  const finalText = extractFinalAssistantText(opId);
  const partial = result.status === "partial";
  const content =
    (partial ? `${result.finalSummary}\n\n` : "") +
    `op ${opId} ${result.status} in ${Math.round(wallMs / 1000)}s` +
    (result.error ? `\n  error: ${result.error.message}` : "") +
    (result.filesChanged.length > 0 ? `\n  files: ${result.filesChanged.slice(0, 5).join(", ")}${result.filesChanged.length > 5 ? "..." : ""}` : "") +
    `\n\n${finalText || (partial ? "(no final message — the worker stopped mid-work)" : result.finalSummary)}`;
  return { content, isError: isOpResultError(result.status) };
}
