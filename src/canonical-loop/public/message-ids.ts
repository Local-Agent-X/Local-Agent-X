/**
 * What a row's message id says about where the row came from.
 *
 * An op's message log opens with the chat's earlier turns, replayed so the
 * model has the conversation (../chat-runner/seed-messages.ts): those rows are
 * `hist-…`. The turn's own user message is `um-…`. Everything after is what
 * the op itself produced. A reader that wants "what this op said" skips the
 * replayed history; nine of them did, each with the prefix written out.
 */

/** Prefix of a row replayed from the chat's earlier turns. */
export const SEEDED_HISTORY_PREFIX = "hist-";

/** Prefix of the user message a turn was started with. */
export const USER_MESSAGE_PREFIX = "um-";

/** A row replayed from the chat's history, not produced by this op. */
export function isSeededHistoryRow(messageId: string): boolean {
  return messageId.startsWith(SEEDED_HISTORY_PREFIX);
}

/** The user message this op's turn was started with. */
export function isUserMessageRow(messageId: string): boolean {
  return messageId.startsWith(USER_MESSAGE_PREFIX);
}
