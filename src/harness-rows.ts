/**
 * Which transcript rows are the HARNESS talking, not the user.
 *
 * A nudge is `role:"user"` because that is the only role every provider treats
 * as an instruction to obey on the next turn. That role is a wire-format
 * convenience and nothing more — the person never said it. Until now the
 * harness resolved the tension by DROPPING nudges when the turn was saved, so
 * the model that was told "you claimed the cleanup was done, prove it" saw no
 * trace of that instruction on the next message, and the user saw three replies
 * answering a question that wasn't in their transcript (live 2026-09-15).
 *
 * Keeping them means every consumer must be able to tell the two apart. There
 * are seven: the chat UI, the progressive loader, retract-last-turn, memory
 * pair extraction, the memory index sync, session export, and fork. A row whose
 * origin is only knowable by matching its prose is a row every one of those
 * gets to guess about — which is what the prefix list in
 * stripEphemeralMessages already was, and it drifted from its sibling copy in
 * the progressive loader.
 *
 * So: one flag, set once where op rows become session rows, read everywhere
 * that asks "did the user say this?".
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

/** What the harness wrote a row for. Extend when a new kind appears; every
 *  consumer below keys on the flag's PRESENCE, so a new kind is hidden from
 *  users and memory by default rather than leaking until someone notices. */
export type HarnessRowKind = "nudge";

type Tagged = ChatCompletionMessageParam & { _harness?: HarnessRowKind };

export function markHarnessRow<T extends ChatCompletionMessageParam>(row: T, kind: HarnessRowKind): T {
  (row as Tagged)._harness = kind;
  return row;
}

/** True when the harness wrote this row, whatever role it wears. */
export function isHarnessRow(row: ChatCompletionMessageParam | undefined | null): boolean {
  return !!row && (row as Tagged)._harness !== undefined;
}

export function harnessRowKind(row: ChatCompletionMessageParam): HarnessRowKind | undefined {
  return (row as Tagged)._harness;
}

/** The user's own turns — what a human would call "the conversation". */
export function userAuthoredRows(rows: readonly ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return rows.filter((row) => !isHarnessRow(row));
}
