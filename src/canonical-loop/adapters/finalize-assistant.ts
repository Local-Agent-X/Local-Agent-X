/**
 * The assistant row a hosted adapter (Anthropic, Codex, Gemini) reports at
 * the end of a turn.
 *
 * Finalized whenever there is EITHER text OR tool calls. A tool-only turn must
 * still finalize, carrying its calls on `content.toolCalls`: otherwise the next
 * turn replays the matching tool results with no call before them, which the
 * Messages API (400 "unexpected tool_use_id") and the Responses API (400 "No
 * tool call found") both reject. The row also keeps the model's reasoning
 * payload when there is one (row-reasoning.ts), so the next step of the same
 * tool loop can send it back.
 */
import type { AdapterReport, TurnInput } from "../adapter-contract.js";
import type { CanonicalMessage } from "../contract-types.js";
import type { ReasoningPayload } from "./row-reasoning.js";

export interface AssistantTurnContent {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  reasoningPayload?: ReasoningPayload;
}

/** Reports the row and returns its messageId, or null when the turn produced
 *  neither text nor tool calls. `idPrefix` keeps each adapter's id spelling. */
export function finalizeAssistantRow(
  idPrefix: string,
  input: Pick<TurnInput, "opId" | "turnIdx">,
  turn: AssistantTurnContent,
  report: (r: AdapterReport) => void,
): string | null {
  if (turn.text.length === 0 && turn.toolCalls.length === 0) return null;
  const messageId = `${idPrefix}-${input.opId}-${input.turnIdx}-${Date.now().toString(36)}`;
  const content: { text: string; toolCalls?: AssistantTurnContent["toolCalls"]; reasoningPayload?: ReasoningPayload } = { text: turn.text };
  if (turn.toolCalls.length > 0) content.toolCalls = turn.toolCalls;
  if (turn.reasoningPayload) content.reasoningPayload = turn.reasoningPayload;
  const message: CanonicalMessage = { messageId, role: "assistant", content };
  report({ kind: "message_finalized", message });
  return messageId;
}
