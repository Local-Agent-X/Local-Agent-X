import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentTurn } from "../../types.js";
import { readOpMessages } from "../store.js";
import { opMessageRowToChatParam } from "../chat-runner.js";
import type { TerminalState } from "../terminal-states.js";
import { resolveTerminalOpStatus } from "../checkpoint-stop.js";

export function collectMessages(
  opId: string,
  history: ChatCompletionMessageParam[],
  userMessage: string,
  systemPrompt: string,
): ChatCompletionMessageParam[] {
  // Mirror legacy runAgent return shape: system + history + user + new
  // assistant/tool messages produced this run. Seeded rows are prefixed
  // `hist-*` / `um-*`; everything else is adapter-produced output we
  // need to project back to ChatCompletionMessageParam.
  const rows = readOpMessages(opId);
  const newMessages: ChatCompletionMessageParam[] = [];
  for (const row of rows) {
    if (row.messageId.startsWith("hist-") || row.messageId.startsWith("um-")) continue;
    const m = opMessageRowToChatParam(row);
    if (m) newMessages.push(m);
  }
  return [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
    ...newMessages,
  ];
}

/** The run's stop reason, read through resolveTerminalOpStatus: an op the
 *  worker ended at an iteration checkpoint is `succeeded` on the state
 *  machine but stopped before finishing, so it is not `end_turn`. */
export function mapStopReason(
  opId: string,
  terminal: TerminalState,
  errorCode: string | undefined,
): AgentTurn["stopReason"] {
  const { status } = resolveTerminalOpStatus(opId, terminal);
  if (status === "completed") return "end_turn";
  if (status === "partial") return "max_iterations";
  if (status === "cancelled") return "abort";
  if (errorCode === "max_turns_exceeded") return "max_iterations";
  return "error";
}

/** Why an agent run did not finish, or null when it did. Every caller that
 *  turns a run into a success or failure reads it here. */
export function agentRunShortfall(turn: Pick<AgentTurn, "stopReason" | "errorMessage">): string | null {
  switch (turn.stopReason) {
    case "end_turn": return null;
    case "abort": return "the run was cancelled";
    case "max_iterations": return "the run stopped before finishing (step limit or checkpoint)";
    default: return `the run failed${turn.errorMessage ? `: ${turn.errorMessage}` : ""}`;
  }
}
