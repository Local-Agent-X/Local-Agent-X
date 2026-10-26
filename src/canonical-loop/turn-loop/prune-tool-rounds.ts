/**
 * Tool output from older rounds of the SAME op leaves the model's view, in
 * batches — the in-op counterpart of the chat lane's finished-turn prune
 * (context-manager/prune-tool-results.ts), with the same stub.
 *
 * A code task or agent job is one user message and then tool call after tool
 * call; the finished-turn prune never sees a finished turn there, so every file
 * dump stayed in view until the summary at "Compact at" replaced the whole head
 * at once. Here a tool result older than the newest PRUNE_KEEP_TOOL_ROUNDS rounds
 * becomes a one-line stub naming the tool and its size; the file is still on
 * disk and the command can run again. User and assistant rows stay verbatim.
 *
 * The stub boundary is pinned per op and moves only when moving it reclaims at
 * least PRUNE_BATCH_MIN_RECLAIM_TOKENS. Stubbing only ever moves forward, so
 * every row before the old boundary is byte-identical from one turn to the next
 * and a provider's prefix cache (a local runtime's KV cache) survives up to it:
 * a batch costs a re-read of the stretch it changed, not of the whole view.
 * Like the rest of the turn loop's compaction this reshapes only the per-turn
 * view, never op_messages.
 */
import type { CanonicalMessage } from "../contract-types.js";
import { elidedToolResultStub, isElidedToolResult } from "../../harness-text.js";
import { estimateTokens } from "../../context-manager/token-estimation.js";
import {
  PRUNE_BATCH_MIN_RECLAIM_TOKENS,
  PRUNE_KEEP_TOOL_ROUNDS,
  PRUNE_MIN_RESULT_CHARS,
} from "../../context-manager/compaction-policy.js";

const MAX_TRACKED_OPS = 500;
/** opId → messageId of the first row kept whole. */
const pinnedBoundary = new Map<string, string>();

type ToolCallRef = { id?: unknown; name?: unknown };

function toolCallsOf(m: CanonicalMessage): ToolCallRef[] {
  if (m.role !== "assistant" || !m.content || typeof m.content !== "object") return [];
  const calls = (m.content as { toolCalls?: unknown }).toolCalls;
  return Array.isArray(calls) ? (calls as ToolCallRef[]) : [];
}

/** The result payload as the model sees it, whatever its stored shape; "" for
 *  a row already stubbed. */
function resultText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const c = content as { result?: unknown; text?: unknown };
  const payload = c.result !== undefined ? c.result : c.text;
  if (typeof payload === "string") return isElidedToolResult(payload) ? "" : payload;
  return payload === undefined || payload === null ? "" : JSON.stringify(payload);
}

/** Index of the first row of the newest PRUNE_KEEP_TOOL_ROUNDS rounds, or -1
 *  when the op has no more rounds than that. */
export function keepBoundary(messages: CanonicalMessage[]): number {
  const roundStarts: number[] = [];
  messages.forEach((m, i) => { if (toolCallsOf(m).length > 0) roundStarts.push(i); });
  return roundStarts.length > PRUNE_KEEP_TOOL_ROUNDS ? roundStarts[roundStarts.length - PRUNE_KEEP_TOOL_ROUNDS] : -1;
}

function stubbable(m: CanonicalMessage): boolean {
  return m.role === "tool_result" && resultText(m.content).length > PRUNE_MIN_RESULT_CHARS;
}

/** Tokens stubbing rows [from, to) would take out of the view. */
function reclaimable(messages: CanonicalMessage[], from: number, to: number): number {
  let tokens = 0;
  for (let i = Math.max(0, from); i < to; i++) if (stubbable(messages[i])) tokens += estimateTokens(resultText(messages[i].content));
  return tokens;
}

function stubRows(messages: CanonicalMessage[], before: number): CanonicalMessage[] {
  const names = new Map<string, string>();
  for (let i = 0; i < before; i++) {
    for (const c of toolCallsOf(messages[i])) if (typeof c.id === "string") names.set(c.id, typeof c.name === "string" ? c.name : "tool");
  }
  return messages.map((m, i) => {
    if (i >= before || !stubbable(m)) return m;
    const { text: _text, result: _result, images: _images, ...rest } = m.content as Record<string, unknown>;
    const name = names.get(String(rest.toolCallId ?? "")) ?? "tool";
    return { ...m, content: { ...rest, result: elidedToolResultStub(name, resultText(m.content).length) } };
  });
}

function pin(opId: string, messageId: string): void {
  pinnedBoundary.delete(opId);
  pinnedBoundary.set(opId, messageId);
  if (pinnedBoundary.size > MAX_TRACKED_OPS) pinnedBoundary.delete(pinnedBoundary.keys().next().value as string);
}

/**
 * The view with older rounds' tool output stubbed. `changed` is true whenever a
 * row was stubbed, so the caller records the view as reshaped. Without an opId
 * (direct callers, tests) the boundary is recomputed from the view alone.
 */
export function pruneToolRounds(messages: CanonicalMessage[], opId?: string): { messages: CanonicalMessage[]; changed: boolean } {
  const pinnedId = opId ? pinnedBoundary.get(opId) : undefined;
  const pinnedAt = pinnedId ? messages.findIndex((m) => m.messageId === pinnedId) : -1;
  const target = keepBoundary(messages);
  let boundary = pinnedAt;
  if (target > Math.max(pinnedAt, 0) && reclaimable(messages, pinnedAt, target) >= PRUNE_BATCH_MIN_RECLAIM_TOKENS) {
    boundary = target;
    if (opId) pin(opId, messages[target].messageId);
  }
  if (boundary <= 0) return { messages, changed: false };
  const out = stubRows(messages, boundary);
  return { messages: out, changed: out.some((m, i) => m !== messages[i]) };
}

/** Test-only: forget every pinned boundary. */
export function _resetPrunedBoundaries(): void {
  pinnedBoundary.clear();
}
