/**
 * The failed tool calls of one committed op, read back from its stored
 * messages: which failures they were, and what the run did about each.
 *
 * Two readers, both looking at runs that are over:
 *  - the one-time backfill (server/background-jobs/failure-backfill.ts) asks
 *    which failures a past run had, so the count of recurring problems does
 *    not start from nothing;
 *  - the failure review asks for one failure's evidence: the call, its result,
 *    and the calls after it up to the one that worked.
 *
 * A call is paired with its result by `toolCallId`, never by position: the
 * pairing by index in tool-failure-summary.ts is a known hazard, and a skew
 * here would put one call's error under another's name.
 *
 * Only the op's OWN rows are read. An op is seeded with the chat's earlier
 * messages (`hist-` rows), so a failure from the first message of a chat sits
 * in every later op of it; counting those would count one failure many times.
 *
 * Inside canonical-loop because the read goes through opMessageRowToChatParam,
 * the canonical row→message adapter (see the SEAL in store.ts).
 */
import { readOpMessages } from "../store.js";
import { extractTextContent, opMessageRowToChatParam } from "../chat-runner/message-convert.js";
import { scrubMetadata, toolMessageBlock, toolMessageStatus } from "../../tool-execution/tool-message-carry.js";
import { actionOf, countsAsFailure, failureReason, failureSignature } from "../../tools/failure-signature.js";
import { makeEntry, redactTranscriptText, renderEntry, type TranscriptEntry } from "./op-transcript.js";

/** Per-entry clips. The failed call's own result gets the most room: it is
 *  the thing under review. */
const MAX_ASK_CHARS = 800;
const MAX_ARGS_CHARS = 400;
const MAX_FAILED_RESULT_CHARS = 600;
const MAX_LATER_RESULT_CHARS = 300;
/** Calls shown after the failed one. What the run did next is either a retry
 *  that worked within a few calls or a change of plan; a long tail is neither. */
const MAX_LATER_CALLS = 6;

interface OpCall {
  toolCallId: string;
  tool: string;
  args: string;
  status: string;
  layer?: string;
  text: string;
  at: number;
  /** What the user had asked when the call was made. */
  ask: string;
}

function parsedArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; } // a call whose arguments never parsed still failed
}

/** The op's own tool calls that got a result, in order. */
function opCalls(opId: string): OpCall[] {
  const pending = new Map<string, { tool: string; args: string }>();
  const calls: OpCall[] = [];
  let ask = "";
  for (const row of readOpMessages(opId)) {
    const msg = opMessageRowToChatParam(row);
    if (!msg) continue;
    if (msg.role === "user") {
      ask = extractTextContent(msg.content).trim() || ask;
      continue;
    }
    if (row.messageId.startsWith("hist-")) continue;
    if (msg.role === "assistant") {
      // Shape-tolerant read, as in op-transcript.ts.
      const toolCalls = (msg as { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }).tool_calls ?? [];
      for (const call of toolCalls) {
        if (call.id && call.function?.name) pending.set(call.id, { tool: call.function.name, args: call.function.arguments ?? "" });
      }
    } else if (msg.role === "tool") {
      const call = pending.get(msg.tool_call_id);
      if (!call) continue;
      const at = Date.parse(row.createdAt);
      calls.push({
        toolCallId: msg.tool_call_id, tool: call.tool, args: call.args,
        status: toolMessageStatus(msg), layer: toolMessageBlock(msg)?.layer,
        text: extractTextContent(msg.content), at: Number.isFinite(at) ? at : 0, ask,
      });
    }
  }
  return calls;
}

export interface OpToolFailure {
  toolCallId: string;
  tool: string;
  action?: string;
  status: string;
  layer?: string;
  /** The failure's first line, redacted. */
  reason: string;
  signature: string;
  at: number;
}

/** The op's failed calls, each identified the way the live record identifies
 *  one (tool-execution/failure-record.ts). */
export function readOpToolFailures(opId: string): OpToolFailure[] {
  const failures: OpToolFailure[] = [];
  for (const call of opCalls(opId)) {
    if (!countsAsFailure(call.status, call.layer)) continue;
    const action = actionOf(parsedArgs(call.args));
    const reason = scrubMetadata(failureReason(call.text));
    failures.push({
      toolCallId: call.toolCallId, tool: call.tool, status: call.status, reason, at: call.at,
      signature: failureSignature({ tool: call.tool, action, status: call.status, layer: call.layer, reason }),
      ...(action ? { action } : {}),
      ...(call.layer ? { layer: call.layer } : {}),
    });
  }
  return failures;
}

export interface FailureEvidence {
  /** The user's ask, the failed call and what the run did next, as plain text. */
  text: string;
  /** A later call to the same tool, with the same action, worked. */
  recovered: boolean;
}

function sameWork(a: OpCall, b: OpCall): boolean {
  return a.tool === b.tool && actionOf(parsedArgs(a.args)) === actionOf(parsedArgs(b.args));
}

/**
 * One failure as a review reads it. Null when the run no longer holds the
 * call. Redacted the way a reviewed transcript is: before any clip, and once
 * more over the whole text.
 */
export function renderFailureEvidence(opId: string, toolCallId: string): FailureEvidence | null {
  const calls = opCalls(opId);
  const index = calls.findIndex((c) => c.toolCallId === toolCallId);
  if (index < 0) return null;
  const failed = calls[index];
  const refusedBy = failed.layer ? `, refused by ${failed.layer}` : "";
  const entries: TranscriptEntry[] = [
    makeEntry(true, "[USER] ", failed.ask || "(no message)", MAX_ASK_CHARS),
    makeEntry(true, `[FAILED CALL] ${failed.tool} `, failed.args, MAX_ARGS_CHARS),
    makeEntry(true, `[RESULT ${failed.tool}, ${failed.status}${refusedBy}] `, failed.text.trim() || "(empty)", MAX_FAILED_RESULT_CHARS),
  ];
  let recovered = false;
  for (const call of calls.slice(index + 1, index + 1 + MAX_LATER_CALLS)) {
    entries.push(makeEntry(true, `[THEN] ${call.tool} `, call.args, MAX_ARGS_CHARS));
    entries.push(makeEntry(true, `[RESULT ${call.tool}, ${call.status}] `, call.text.trim() || "(empty)", MAX_LATER_RESULT_CHARS));
    if (call.status === "ok" && sameWork(call, failed)) { recovered = true; break; }
  }
  const text = redactTranscriptText(entries.map((e) => renderEntry(e, redactTranscriptText)).join("\n"));
  return { text, recovered };
}
