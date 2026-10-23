/**
 * The calls a scheduled run had refused, for its run record (run-history.ts
 * CronRunRecord.blocked). A refused call leaves its ToolBlockRecord on the
 * tool row of the run's transcript (tool-execution/tool-message-carry.ts,
 * written back by chat-runner/message-convert.ts), so an unattended run that
 * ends "done" cannot also hide what was stopped: the cron detail view lists it
 * beside the run, whatever the agent's own summary said.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { getLaxDir } from "../lax-data-dir.js";
import { readSessionLog } from "../memory/session-message-log.js";
import { join } from "node:path";

export interface BlockedCall {
  tool: string;
  reason: string;
}

/** A run record keeps the first few; the transcript holds every one. */
export const BLOCKED_CALLS_KEPT = 10;

/** Pure: the refused calls in a transcript, in order, named by the call that made them. */
export function blockedCallsIn(messages: readonly ChatCompletionMessageParam[]): BlockedCall[] {
  const toolNames = new Map<string, string>();
  const out: BlockedCall[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) if (call.type === "function") toolNames.set(call.id, call.function.name);
    }
    const block = (m as { _block?: { reason?: unknown } })._block;
    if (m.role === "tool" && block && typeof block.reason === "string") {
      out.push({ tool: toolNames.get(m.tool_call_id) ?? "unknown", reason: block.reason });
      if (out.length === BLOCKED_CALLS_KEPT) break;
    }
  }
  return out;
}

/** The refused calls of a run's saved session, or undefined when it had none. */
export function blockedCallsOfRun(sessionId: string | undefined): BlockedCall[] | undefined {
  if (!sessionId) return undefined;
  const session = readSessionLog(join(getLaxDir(), "sessions"), sessionId);
  const blocked = session ? blockedCallsIn(session.messages) : [];
  return blocked.length > 0 ? blocked : undefined;
}
