/**
 * A reply the output cap cut off is continued, not restarted.
 *
 * local-cap.ts caps one local reply at LOCAL_DEFAULT_MAX_TOKENS so a silent
 * stretch of thinking stays bounded. The cap must not cost the thought: on a
 * discovered Ollama runtime the cut reply goes back as the LAST message of the
 * same request, an assistant row carrying everything the model produced, and
 * Ollama renders a trailing assistant row as a prefill (model/renderers/
 * qwen35.go, read 2026-10-31: no <|im_end|>, the row's thinking as a closed
 * `<think>` block, then its text), so the model's next tokens continue that
 * reply. The runtime's prefix cache already holds the prompt and the tokens it
 * just generated, so the continuation costs almost no re-read.
 *
 * Three shapes of reply are continued:
 *   - cut while thinking (no text yet): the thinking goes back closed, with
 *     the sentence Qwen3 was trained to see when its budget ends appended
 *     (Qwen3 technical report, thinking budget), and the model must now act on
 *     it — a tool call or the answer;
 *   - cut while writing (thinking done, text partial): the text goes back as
 *     the row's content and the model resumes mid-sentence;
 *   - stopped after thinking: the think block closed and the model ended the
 *     turn with no answer and no tool call. The same row as the first shape,
 *     for the same reason: the thought is done and must be acted on. Before,
 *     such a turn went to the turn loop's nudge, and a second one in a row
 *     ended the op as blocked (custom-memory-heap-crash, 2026-10-31: two
 *     thought-only turns of 7.7k and 9.4k tokens, seven minutes unused).
 * At most CUT_OFF_CONTINUATION_LEGS continuations a turn, so one turn is
 * bounded at three legs of the cap; a reply still cut, or still thought-only,
 * after them reaches the turn loop's re-drive (turn-loop/cut-off-turn.ts,
 * turn-loop/empty-turn-termination.ts) exactly as before.
 *
 * The thinking recorded for the turn stays what the model wrote: the closing
 * sentence is in the row the model is shown, never in the trace.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ProviderRequest } from "../../../providers/adapter/types.js";
import { estimateTokens } from "../../../context-manager/token-estimation.js";
import { isCutOffStop } from "../../turn-loop/cut-off-turn.js";
import { classifyModelStop } from "../model-stop.js";
import type { StreamOnceResult } from "./types.js";

export const CUT_OFF_CONTINUATION_LEGS = 2;

export const THINKING_BUDGET_CLOSE =
  "Considering the limited time by the user, I have to give the solution based on the thinking directly now.";

/** No reason not to continue: a tool call, an error, a guard stop or a user
 *  interrupt each own the turn already. */
function unowned(result: StreamOnceResult): boolean {
  return result.pendingToolCalls.length === 0 &&
    !result.firstError &&
    !result.stoppedByGuard &&
    !result.interruptedByInject;
}

/** A reply the cap cut off with something to continue from. */
export function isContinuableCut(result: StreamOnceResult): boolean {
  return isCutOffStop(result.providerStop) && unowned(result) &&
    (result.assembledText.length > 0 || result.assembledThinking.length > 0);
}

/** A reply the model ended after thinking, with no answer and no tool call. */
export function isReasoningOnlyStop(result: StreamOnceResult): boolean {
  return classifyModelStop(result.providerStop) === "ended" && unowned(result) &&
    result.assembledText.length === 0 && result.assembledThinking.length > 0;
}

/** The cut reply as the assistant row the continuation request ends with. */
export function continuationRow(carry: { thinking: string; text: string }): ChatCompletionMessageParam {
  const cutWhileThinking = carry.text.length === 0 && carry.thinking.length > 0;
  const reasoning = cutWhileThinking ? `${carry.thinking}\n\n${THINKING_BUDGET_CLOSE}` : carry.thinking;
  return { role: "assistant", content: carry.text, ...(reasoning ? { reasoning } : {}) } as unknown as ChatCompletionMessageParam;
}

/** What the turn has so far plus one continuation leg: the texts and thinking
 *  joined, the leg's own stop, tool calls and prompt usage, output summed. */
export function mergeLeg(sofar: StreamOnceResult, leg: StreamOnceResult): StreamOnceResult {
  const text = sofar.assembledText + leg.assembledText;
  const sum = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  return {
    ...leg,
    assembledText: text,
    rawText: text,
    assembledThinking: [sofar.assembledThinking, leg.assembledThinking].filter((s) => s.length > 0).join("\n\n"),
    usageCompletionTokens: sum(sofar.usageCompletionTokens, leg.usageCompletionTokens),
    ...(sofar.firstTokenMs !== undefined ? { firstTokenMs: sofar.firstTokenMs } : {}),
  };
}

export interface ContinueCutOffArgs {
  req: ProviderRequest;
  result: StreamOnceResult;
  /** The cap for a continuation whose prompt grew by `addedTokens`; undefined
   *  = the window has no room left, so the reply cannot be continued. */
  cap: (addedTokens: number) => number | undefined;
  run: (req: ProviderRequest) => Promise<StreamOnceResult>;
  isAborted: () => boolean;
}

/** Continue a cut or thought-only reply in place, leg by leg, and say how
 *  many legs it took. */
export async function continueCutOffReply(args: ContinueCutOffArgs): Promise<{ result: StreamOnceResult; legs: number }> {
  let result = args.result;
  let legs = 0;
  while (legs < CUT_OFF_CONTINUATION_LEGS && !args.isAborted() && (isContinuableCut(result) || isReasoningOnlyStop(result))) {
    const carry = { thinking: result.assembledThinking, text: result.assembledText };
    const maxTokens = args.cap(estimateTokens(carry.thinking) + estimateTokens(carry.text));
    if (maxTokens === undefined) break;
    const leg = await args.run({ ...args.req, messages: [...args.req.messages, continuationRow(carry)], maxTokens });
    result = mergeLeg(result, leg);
    legs += 1;
  }
  return { result, legs };
}
