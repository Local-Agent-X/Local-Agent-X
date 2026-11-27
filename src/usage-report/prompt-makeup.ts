/**
 * What one model call's prompt was made of, by source: the instructions, the tool
 * definitions, what you typed, what the app posted, the agent's own replies, tool
 * output (in full, or already cut to a one-line stub), recalled memory and other
 * notes the harness adds.
 *
 * Read from the call's turn trace (canonical-loop readTurnTrace, which rebuilds the
 * full request from the traces it points back to). Sizes are measured in
 * characters and scaled to the tokens the provider counted for the call, so the
 * parts add up to the real prompt. A call whose trace is gone, or whose history
 * could not be rebuilt, has no makeup: the screen says so instead of guessing.
 *
 * This is how the lead's 64% of settled build decisions was found (2026-11-27).
 */
import { readTurnTrace } from "../canonical-loop/public/op-facts.js";
import { isHarnessRow, harnessRowKind } from "../harness-rows.js";
import { APP_MESSAGE_LEAD, isElidedToolResult } from "../harness-text.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface PromptPart {
  /** "instructions", "tool definitions", "you typed", "app messages", … */
  source: string;
  rows: number;
  tokens: number;
}

const RECALL_LEAD = /^Recalled memory for the user|^\[RECALLED CONTEXT/;
const NUDGE_LEAD = /^\[automatic check\]|^You're ending this turn/;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

function sourceOf(row: Record<string, unknown>): string {
  const text = textOf(row.content);
  if (row.role === "system") return "instructions";
  if (row.role === "assistant") return "agent's replies and calls";
  if (row.role === "tool") return isElidedToolResult(text) ? "old tool output (stubs)" : "tool output";
  const asRow = row as unknown as ChatCompletionMessageParam;
  const kind = isHarnessRow(asRow) ? harnessRowKind(asRow) : undefined;
  if (kind === "recall" || RECALL_LEAD.test(text)) return "recalled memory";
  if (kind || NUDGE_LEAD.test(text)) return "harness notes";
  if (text.startsWith(APP_MESSAGE_LEAD)) return "app messages";
  return "you typed";
}

function sizeOf(row: Record<string, unknown>): number {
  return textOf(row.content).length + (row.tool_calls ? JSON.stringify(row.tool_calls).length : 0);
}

/** The makeup of one call's prompt, biggest part first, scaled to
 *  `promptTokens`; null when its full request cannot be read. */
export function promptMakeup(opId: string, turnIdx: number, promptTokens: number): PromptPart[] | null {
  const trace = readTurnTrace(opId, turnIdx);
  if (!trace || trace.request.messagesFrom) return null;
  const chars = new Map<string, { rows: number; chars: number }>();
  const add = (source: string, size: number, rows = 1) => {
    const part = chars.get(source) ?? { rows: 0, chars: 0 };
    part.rows += rows;
    part.chars += size;
    chars.set(source, part);
  };
  add("instructions", trace.request.systemPrompt.length);
  add("tool definitions", JSON.stringify(trace.request.tools ?? []).length, (trace.request.tools ?? []).length);
  for (const row of trace.request.messages as Array<Record<string, unknown>>) add(sourceOf(row), sizeOf(row));
  const total = [...chars.values()].reduce((n, p) => n + p.chars, 0);
  if (total === 0) return null;
  return [...chars.entries()]
    .map(([source, p]) => ({ source, rows: p.rows, tokens: Math.round((p.chars / total) * promptTokens) }))
    .filter((p) => p.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}
