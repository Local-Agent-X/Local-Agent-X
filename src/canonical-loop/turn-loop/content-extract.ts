// Pull plain text out of a message's content blob. CanonicalMessage.content
// is `unknown` by contract — adapters store it in whatever shape they were
// given, so we defensively probe the common shapes (string, {text}, {result})
// and bail to empty string for anything else. Used to feed afterModelCall
// middlewares an assistantContent string and to render tool results into
// the afterToolExecution view.
import type { CommitTurnMessage } from "../checkpoint.js";
import { TOOL_DISPATCH_STATUSES, type ToolCallSummary, type ToolDispatchStatus } from "../types.js";
import { envelopeStatusToDispatchStatus } from "../tool-dispatch.js";
import type { CanonicalToolResultView } from "../middlewares/types.js";
import type { ToolBlockRecord } from "../../types.js";
import { parseStatusHeader } from "../../tools/result-helpers.js";

/** The payload of a tool_result row, in either stored shape: `{ toolCallId,
 *  result, status }` from the turn loop, or `{ text, toolCallId }` re-seeded
 *  from session history. The request converters read `result` alone, so every
 *  tool result from an earlier message reached the model as the string "null"
 *  and it told the user its tool had returned nothing (live 2026-09-26). */
export function toolResultPayload(content: unknown): unknown {
  if (!content || typeof content !== "object") return content;
  const c = content as { text?: unknown; result?: unknown };
  return c.result !== undefined ? c.result : c.text;
}

/** The dispatch status the turn loop recorded on a tool_result row
 *  (dispatch-tools.ts); undefined for a row re-seeded from session history,
 *  which carries only its text. */
export function recordedToolResultStatus(content: unknown): ToolDispatchStatus | undefined {
  const status = content && typeof content === "object" ? (content as { status?: unknown }).status : undefined;
  return typeof status === "string" && (TOOL_DISPATCH_STATUSES as readonly string[]).includes(status) ? (status as ToolDispatchStatus) : undefined;
}

/** A tool_result row's status: the one recorded on it, or, for a row that
 *  carries only its text, the one its rendered header says (the same rule the
 *  tool message's carry applies to rows written before it existed). */
export function toolResultStatus(content: unknown): ToolDispatchStatus {
  return recordedToolResultStatus(content) ?? envelopeStatusToDispatchStatus(parseStatusHeader(extractToolResultText(content)));
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as { text?: unknown; result?: unknown };
    if (typeof c.text === "string") return c.text;
    if (typeof c.result === "string") return c.result;
  }
  return "";
}

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as { text?: unknown; result?: unknown };
    if (typeof c.text === "string") return c.text;
    const r = c.result;
    if (typeof r === "string") return r;
    if (r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string") {
      return (r as { text: string }).text;
    }
    if (r != null) {
      try { return JSON.stringify(r); } catch { return ""; }
    }
  }
  return "";
}

export function buildToolResultsView(
  messages: CommitTurnMessage[],
  summary: ToolCallSummary[],
  extract: (content: unknown) => string = extractToolResultText,
): CanonicalToolResultView[] {
  return messages.map((message, index) => {
    const row = message.content as { block?: ToolBlockRecord; metadata?: Record<string, unknown> } | null;
    const block = row?.block;
    const metadata = row?.metadata;
    return {
      toolName: summary[index]?.tool ?? "unknown",
      toolCallId: (message.content as { toolCallId?: string })?.toolCallId ?? "",
      content: extract(message.content),
      status: summary[index]?.resultStatus,
      ...(block && typeof block === "object" ? { block } : {}),
      ...(metadata && typeof metadata === "object" ? { metadata } : {}),
    };
  });
}
