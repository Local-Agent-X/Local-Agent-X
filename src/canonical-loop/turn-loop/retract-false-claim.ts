// When a hallucination guard fires on a terminal turn, the model's just-
// streamed text is a confirmed-false claim of work that never happened
// ("Worker already on it, build running in the background", "I scheduled the
// job"). The guard nudges the model to redo the turn, but without this the
// false bubble stays — the user is left with a lie sitting next to the
// correction the next turn produces. Live failure 2026-06-02: "I want to
// start a company" drew a phantom "Worker already on it" claim; the user
// read it as real background work, abandoned the chat, and re-sent in a new
// one — producing a duplicate build.
//
// Retraction removes the false assistant text from the committed transcript
// here; the caller also clears the live stream bubble with a replace:true
// chunk. The next turn's answer becomes the only assistant message the user
// sees, in both the live view and on reload.
//
// Scoped to confirmed-false reasons only. worker-hallucination is provably
// false (built from the tool-call ledger — no spawn-class call fired);
// creation-hallucination is LLM-verified before it nudges. approval-
// hallucination is excluded: "requires approval" is a misplaced permission
// ask, not a false claim of completed work, so its text should stand.

import type { CommitTurnMessage } from "../checkpoint.js";

const RETRACTABLE_REASONS: ReadonlySet<string> = new Set([
  "worker-hallucination",
  "creation-hallucination",
]);

export function isRetractableHallucination(reason: string | null | undefined): boolean {
  return reason != null && RETRACTABLE_REASONS.has(reason);
}

// Drop assistant messages (the false claim) while preserving any tool
// messages. The hallucination guards only fire on tool-less terminal turns,
// so in practice this empties the turn — but filtering by role keeps it
// correct if that invariant ever changes.
export function stripRetractedAssistant(messages: CommitTurnMessage[]): CommitTurnMessage[] {
  return messages.filter(m => m.role !== "assistant");
}
