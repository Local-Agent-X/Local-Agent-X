/**
 * An app message that asked the agent to answer by a tool call is shortened in the
 * model's view once its turn is over: its evidence was for the answer, and the
 * answer is given, or was not and the app went on without it.
 *
 * Measured on a build's lead chat (label-check-grok, 2026-11-27): each build
 * decision the engine posts carries a chunk's contract, the review's findings and
 * the worker's report, about 4K tokens, and 36 finished ones rode along in full on
 * every later decision, 64% of each ~230K-token call, re-sent every ~15 minutes.
 * Half had been answered; the other half were not, and the engine had decided them
 * by its own rules. The lead needs what was decided, not the evidence again.
 *
 * A request names the call that answers it on its own line (appAnswerLine,
 * harness-text.ts), and is answered in the turn it lands in or not at all. Once a
 * later user-authored row has started another turn, the request keeps everything
 * up to its headline (the first line naming its id, so the lead role a first
 * request carries stays) and one line: the answer that call gave, or that none was
 * given. The request still in its turn is left whole. Like prune-tool-results.ts,
 * the view is a pure function of the history, so the prefix changes once, when the
 * next turn starts; row count is kept; the transcript, the chat and the app's own
 * records are untouched.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { isHarnessRow } from "../harness-rows.js";
import { APP_ANSWER_LINE, APP_MESSAGE_LEAD, spentAppRequestNote } from "../harness-text.js";

type Row = ChatCompletionMessageParam & { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
type Call = { at: number; tool: string; args: Record<string, unknown> };

/** How long the answer's own words may run in the note. */
const ANSWER_CHARS = 400;

function callsIn(messages: readonly ChatCompletionMessageParam[]): Call[] {
  const calls: Call[] = [];
  messages.forEach((m, at) => {
    const toolCalls = (m as Row).tool_calls;
    if (m.role !== "assistant" || !Array.isArray(toolCalls)) return;
    for (const c of toolCalls) {
      let args: unknown;
      try { args = JSON.parse(c.function?.arguments ?? ""); } catch { continue; } // a call whose arguments do not parse answers nothing
      if (args && typeof args === "object" && !Array.isArray(args)) calls.push({ at, tool: c.function?.name ?? "", args: args as Record<string, unknown> });
    }
  });
  return calls;
}

/** The answer in the call's own words: its arguments but the id, shortened. */
function answerOf(call: Call, idArg: string): string {
  const parts = Object.entries(call.args)
    .filter(([key, value]) => key !== idArg && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  const text = parts.join(", ").replace(/\s+/g, " ");
  return text.length > ANSWER_CHARS ? `${text.slice(0, ANSWER_CHARS)}…` : text;
}

function shortened(content: string, id: string, tool: string, answer: string | null): string {
  const lines = content.split("\n");
  const headline = lines.findIndex((line) => line.includes(id));
  const kept = lines.slice(0, headline > 0 ? headline + 1 : 1);
  return [...kept, spentAppRequestNote(tool, answer)].join("\n");
}

/** The index of the next user-authored row after `i`: the start of the next
 *  turn. A row that names the same request is the app asking for it again (a
 *  build decision whose turn ended unanswered, lead-decisions.ts answerNow):
 *  the request is still open through it. */
function nextTurnStart(messages: readonly ChatCompletionMessageParam[], i: number, id: string): number {
  for (let j = i + 1; j < messages.length; j++) {
    const m = messages[j];
    if (m.role !== "user" || isHarnessRow(m)) continue;
    if (typeof m.content === "string" && m.content.startsWith(APP_MESSAGE_LEAD) && m.content.includes(id)) continue;
    return j;
  }
  return -1;
}

/** The history with every app request whose turn is over shortened to its headline
 *  and how it was answered. */
export function shortenSpentAppRequests(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  let calls: Call[] | null = null;
  let changed = false;
  const out = messages.map((m, i) => {
    if (m.role !== "user" || typeof m.content !== "string" || !m.content.startsWith(APP_MESSAGE_LEAD)) return m;
    const asked = APP_ANSWER_LINE.exec(m.content);
    if (!asked) return m;
    const [, tool, idArg, id] = asked;
    const next = nextTurnStart(messages, i, id);
    if (next < 0) return m; // its turn is the one still going
    calls ??= callsIn(messages);
    const call = calls.find((c) => c.at > i && c.at < next && c.tool === tool && c.args[idArg] === id);
    changed = true;
    return { ...m, content: shortened(m.content, id, tool, call ? answerOf(call, idArg) : null) } as ChatCompletionMessageParam;
  });
  return changed ? out : messages;
}
