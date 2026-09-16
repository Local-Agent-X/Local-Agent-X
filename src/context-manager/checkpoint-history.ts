/**
 * What the model is sent as "the conversation so far".
 *
 * This replaces the row-count window (providers/truncate-history.ts): keep the
 * last N rows, slide by a step every message. Two costs made that the wrong
 * shape. It cut by COUNT, so ten one-line turns outweighed one huge tool
 * result; and because the cut moved every message, message N+1's history was
 * never message N's plus the new rows — so the provider's cache prefix broke
 * every single turn, on a conversation that had not actually changed.
 *
 * A checkpoint is the fix: summarize the old part ONCE, persist it
 * (memory/session-message-log.ts SessionCheckpointRow), and reuse it verbatim
 * until the tail grows enough to be worth re-cutting. The bytes sent for the
 * old part are then byte-identical message after message, which is what a
 * prefix cache needs — and the transcript itself is untouched, so the chat,
 * fork, export and recall still show everything.
 *
 * The turn-loop's own compaction (canonical-loop/turn-loop/compact-history.ts)
 * stays as the in-op emergency bound for a turn that overflows mid-flight.
 * This is the between-messages bound, and the two are deliberately different
 * questions: "does this request fit" vs "what is the stable view of the past".
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { Session } from "../types.js";
import { totalTokens } from "./token-estimation.js";
import { summarizeOldMessages } from "./compaction.js";
import {
  CHECKPOINT_KEEP_RECENT,
  CHECKPOINT_REFRESH_MIN_GROWTH,
  CONVERSATION_BUDGET_SHARE,
} from "./compaction-policy.js";
import { createLogger } from "../logger.js";

const logger = createLogger("context-manager.checkpoint-history");

export interface CheckpointedHistory {
  /** What to send: [summary row?, ...verbatim tail]. */
  messages: ChatCompletionMessageParam[];
  /** Set when a NEW checkpoint was computed and should be persisted. */
  newCheckpoint?: { summary: string; coversThrough: number };
}

function summaryRow(summary: string): ChatCompletionMessageParam {
  return {
    role: "system",
    content: `[Earlier in this conversation]\n${summary}`,
  } as ChatCompletionMessageParam;
}

/** Apply an existing checkpoint without deciding anything — the common path. */
export function applyCheckpoint(
  messages: ChatCompletionMessageParam[],
  checkpoint: { summary: string; coversThrough: number } | undefined,
): ChatCompletionMessageParam[] {
  if (!checkpoint || checkpoint.coversThrough <= 0 || checkpoint.coversThrough > messages.length) return messages;
  return [summaryRow(checkpoint.summary), ...messages.slice(checkpoint.coversThrough)];
}

/**
 * The view to send, plus a checkpoint to persist when one was just made.
 *
 * Pure w.r.t. the session: it never writes. The caller owns persistence, so a
 * failed summarize simply sends more history rather than corrupting a log.
 */
export async function checkpointedHistory(
  messages: ChatCompletionMessageParam[],
  session: Pick<Session, "compactionCheckpoint">,
  modelWindowTokens: number,
): Promise<CheckpointedHistory> {
  const existing = session.compactionCheckpoint;
  const applied = applyCheckpoint(messages, existing);
  const budget = Math.floor(modelWindowTokens * CONVERSATION_BUDGET_SHARE);
  if (budget <= 0 || totalTokens(applied) <= budget) return { messages: applied };

  // Over budget. Re-cut only if the tail has actually grown since the last cut;
  // otherwise there is nothing new to fold in and re-summarizing would only
  // churn the prefix.
  const from = existing?.coversThrough ?? 0;
  const tailSinceCheckpoint = messages.length - from;
  if (existing && tailSinceCheckpoint < CHECKPOINT_REFRESH_MIN_GROWTH) return { messages: applied };

  const coversThrough = Math.max(from, messages.length - CHECKPOINT_KEEP_RECENT);
  if (coversThrough <= from) return { messages: applied };

  const summary = await summarizeOldMessages(messages.slice(0, coversThrough));
  if (!summary) {
    // A failed summarize is not a reason to drop the user's conversation: send
    // what we have and let the turn-loop's in-op compaction bound the request.
    logger.info("summarize returned null — sending the un-checkpointed view");
    return { messages: applied };
  }
  const checkpoint = { summary, coversThrough };
  logger.info(`checkpointed ${coversThrough} messages (tail ${messages.length - coversThrough})`);
  return { messages: applyCheckpoint(messages, checkpoint), newCheckpoint: checkpoint };
}
