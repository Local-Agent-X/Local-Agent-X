import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentTurn } from "../../types.js";
import { readOpMessages } from "../store.js";
import { opMessageRowToChatParam } from "../chat-runner.js";
import type { TerminalState } from "../terminal-states.js";

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

export function mapStopReason(
  terminal: TerminalState,
  errorCode: string | undefined,
): AgentTurn["stopReason"] {
  if (terminal === "succeeded") return "end_turn";
  if (terminal === "cancelled") return "abort";
  if (errorCode === "max_turns_exceeded") return "max_iterations";
  return "error";
}
