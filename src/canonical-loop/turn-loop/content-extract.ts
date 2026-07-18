// Pull plain text out of a message's content blob. CanonicalMessage.content
// is `unknown` by contract — adapters store it in whatever shape they were
// given, so we defensively probe the common shapes (string, {text}, {result})
// and bail to empty string for anything else. Used to feed afterModelCall
// middlewares an assistantContent string and to render tool results into
// the afterToolExecution view.
import type { CommitTurnMessage } from "../checkpoint.js";
import type { ToolCallSummary } from "../types.js";
import type { CanonicalToolResultView } from "../middlewares/types.js";

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
  return messages.map((message, index) => ({
    toolName: summary[index]?.tool ?? "unknown",
    toolCallId: (message.content as { toolCallId?: string })?.toolCallId ?? "",
    content: extract(message.content),
    status: summary[index]?.resultStatus,
  }));
}
