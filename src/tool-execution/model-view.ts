// What the model was actually shown on an op's latest turn, when that differs
// from the op's transcript.
//
// The canonical loop compacts history per turn without touching op_messages
// (turn-loop/compact-history.ts), so the transcript the dispatcher reads is a
// superset of the model's input. Checks that ask "does the model hold X" must
// use this view; checks that ask "did the user say X" keep the transcript.
// Written by turn-loop/build-input.ts: a compacted turn records its view, an
// uncompacted one clears it (the transcript IS the view).

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// Op ids are unique, so an entry left behind by a finished op is inert; the
// cap only bounds memory.
const MAX_OPS = 64;
const views = new Map<string, ChatCompletionMessageParam[]>();

export function setModelView(opId: string, view: ChatCompletionMessageParam[] | null): void {
  views.delete(opId);
  if (!view) return;
  views.set(opId, view);
  if (views.size > MAX_OPS) views.delete(views.keys().next().value!);
}

/** The compacted view of `opId`'s latest turn, or null when the model saw the whole transcript. */
export function getModelView(opId: string | undefined): ChatCompletionMessageParam[] | null {
  return opId ? views.get(opId) ?? null : null;
}
