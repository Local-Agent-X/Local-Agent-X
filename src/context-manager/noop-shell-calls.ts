/**
 * Shell calls that only printed their own words leave the model's view of
 * finished turns, with their results and the narration around them.
 *
 * Grok, told to start a build, said "Calling the greenfield entrypoint now"
 * and sent `echo "calling start_app_build"` instead, forty-nine times over
 * several turns (chat-mwzepzxs, 2026-11-27). The shell now refuses such a call
 * (tools/shell-noop.ts), but the history kept teaching the pattern: in a later
 * turn Grok's very first call, meant for build_decide, was another echo, and
 * so were the next five. Those calls ran nothing, so the model loses nothing
 * by not seeing them: an assistant row whose every call printed only its own
 * words goes, with its results (its words claimed a step it never took);
 * a row that also made real calls keeps its words and those calls.
 *
 * Only turns that are over: in the turn still going, the model needs the
 * refusal to correct itself. A pure function of the history, so the prefix
 * changes once, when the next turn starts. Row count changes, so it runs
 * last, on the view (checkpoint-history.ts applyCheckpoint); the transcript,
 * the chat and every record are untouched.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { isHarnessRow } from "../harness-rows.js";
import { printedOnlyText } from "../tools/shell-noop.js";

type Call = { id?: string; function?: { name?: string; arguments?: string } };
type Row = ChatCompletionMessageParam & { tool_calls?: Call[]; tool_call_id?: string };

/** The shell tools whose `command` can be a print-only line. */
const SHELL_TOOLS = new Set(["bash"]);

function printsOnly(call: Call): boolean {
  if (!SHELL_TOOLS.has(call.function?.name ?? "")) return false;
  try {
    const args = JSON.parse(call.function?.arguments ?? "") as { command?: unknown };
    return typeof args.command === "string" && printedOnlyText(args.command) !== null;
  } catch {
    return false; // arguments that do not parse ran nothing either, but say nothing about printing
  }
}

/** Where the turn still going starts: the last row the user wrote. */
function currentTurnStart(messages: readonly ChatCompletionMessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isHarnessRow(messages[i])) return i;
  }
  return messages.length;
}

export function dropNoopShellCalls(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const end = currentTurnStart(messages);
  const goneIds = new Set<string>();
  const goneRows = new Set<number>();
  const trimmed = new Map<number, ChatCompletionMessageParam>();
  for (let i = 0; i < end; i++) {
    const row = messages[i] as Row;
    if (row.role !== "assistant" || !Array.isArray(row.tool_calls) || row.tool_calls.length === 0) continue;
    const noop = row.tool_calls.filter(printsOnly);
    if (noop.length === 0) continue;
    for (const c of noop) if (c.id) goneIds.add(c.id);
    if (noop.length === row.tool_calls.length) goneRows.add(i);
    else trimmed.set(i, { ...row, tool_calls: row.tool_calls.filter((c) => !noop.includes(c)) } as ChatCompletionMessageParam);
  }
  if (goneIds.size === 0) return messages;
  const out: ChatCompletionMessageParam[] = [];
  messages.forEach((m, i) => {
    if (goneRows.has(i)) return;
    if (i < end && m.role === "tool" && goneIds.has((m as Row).tool_call_id ?? "")) return;
    out.push(trimmed.get(i) ?? m);
  });
  return out;
}
